// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { delimiter, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  aliasCacheControl,
  cacheControl,
  getCdnAliasUploads,
  getCdnArtifacts,
  getCdnMajor,
  getCdnUploads,
  getIntegrity,
  prepareCdn,
  prepareCdnAliases,
  readCdnFile,
  root,
} from "../../scripts/cdn.mjs";
import { activateCdnAliases, publishCdn, runAzureCli } from "../../scripts/publish-cdn.mjs";
import { verifyCdn } from "../../scripts/verify-cdn.mjs";

const md5 = (bytes) => createHash("md5").update(bytes).digest("base64");

async function azureCliFixture(t, sideEffectDelay) {
  const directory = await mkdtemp(resolve(tmpdir(), "otel-azure-cli-test-"));
  const ready = resolve(directory, "ready.json");
  const uploaded = resolve(directory, "uploaded");
  const worker = resolve(directory, "worker.cjs");
  const launcher = resolve(directory, "launcher.cjs");
  await writeFile(
    worker,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ pid: process.pid }));
fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
setTimeout(() => fs.writeFileSync(${JSON.stringify(uploaded)}, "uploaded"), ${sideEffectDelay});
setInterval(() => {}, 1000);
`,
  );
  await writeFile(
    launcher,
    `require("node:child_process").spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: "inherit" });
`,
  );
  const windows = process.platform === "win32";
  const executable = resolve(directory, windows ? "az.cmd" : "az");
  await writeFile(
    executable,
    windows
      ? `@echo off\r\n"${process.execPath}" "${launcher}"\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${launcher}"\n`,
  );
  if (!windows) await chmod(executable, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${directory}${delimiter}${path}`;
  let pid;
  t.after(async () => {
    process.env.PATH = path;
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    uploaded,
    markStopped() {
      pid = undefined;
    },
    async waitForWorker() {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        try {
          pid = JSON.parse(await readFile(ready, "utf8")).pid;
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      assert.fail("Azure CLI wrapper did not start its descendant.");
    },
  };
}

test(
  "Azure CLI cancellation stops a real non-exec wrapper and its uploading descendant",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await azureCliFixture(t, 600);
    const controller = new AbortController();
    const cancelled = new Error("Lease renewal failed.");
    const result = runAzureCli(["fixture"], { signal: controller.signal }).catch((error) => error);
    await fixture.waitForWorker();
    const start = performance.now();
    controller.abort(cancelled);
    assert.equal(await result, cancelled);
    fixture.markStopped();
    assert.ok(performance.now() - start < 2_000, "inherited pipes must not delay cancellation");
    await delay(800);
    await assert.rejects(readFile(fixture.uploaded), { code: "ENOENT" });
  },
);

test(
  "Azure CLI timeout stops a real non-exec wrapper and its uploading descendant",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await azureCliFixture(t, 4_000);
    const start = performance.now();
    const result = runAzureCli(["fixture"], { timeoutMs: 2_000 }).catch((error) => error);
    await fixture.waitForWorker();
    assert.match((await result).message, /Azure CLI timed out after 2000 ms/);
    fixture.markStopped();
    assert.ok(performance.now() - start < 3_500, "inherited pipes must not defeat the timeout");
    await delay(4_200);
    await assert.rejects(readFile(fixture.uploaded), { code: "ENOENT" });
  },
);

async function release(t, version) {
  const directory = await mkdtemp(resolve(tmpdir(), "otel-alias-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDirectory = resolve(directory, "source");
  await mkdir(sourceDirectory);
  for (const artifact of getCdnArtifacts(version)) {
    await writeFile(
      resolve(sourceDirectory, artifact.source),
      `globalThis.release = "${version}";\n//# sourceMappingURL=${artifact.source}.map\n`,
    );
    await writeFile(
      resolve(sourceDirectory, `${artifact.source}.map`),
      JSON.stringify({ version: 3, file: artifact.source, sources: [], names: [], mappings: "" }),
    );
  }
  const outputDirectory = resolve(directory, "cdn");
  await prepareCdn({ version, sourceDirectory, outputDirectory });
  return { version, directory: outputDirectory };
}

async function signalCliFixture(t, publishing) {
  const beta = await release(t, "0.1.0-beta.1");
  const project = resolve(beta.directory, "..");
  const scripts = resolve(project, "scripts");
  await mkdir(scripts);
  for (const file of [
    "cdn.mjs",
    "publish-cdn.mjs",
    "activate-cdn.mjs",
    "verify-cdn.mjs",
    "check-node-version.mjs",
  ]) {
    await copyFile(resolve(root, "scripts", file), resolve(scripts, file));
  }
  await writeFile(resolve(project, "package.json"), JSON.stringify({ version: beta.version }));
  const stateFile = resolve(project, "storage.json");
  const readyFile = resolve(project, "ready.json");
  const lateFile = resolve(project, "late-upload");
  const releasedFile = resolve(project, "released");
  const state = { blobs: {}, lease: null };
  if (!publishing) {
    for (const upload of getCdnUploads(beta.version, "public")) {
      const bytes = await readCdnFile(beta.version, upload.file, beta.directory, "public");
      state.blobs[upload.blob] = { bytes: bytes.toString("base64"), md5: md5(bytes) };
    }
  }
  await writeFile(stateFile, JSON.stringify(state));
  const worker = resolve(project, "worker.cjs");
  await writeFile(
    worker,
    `
const fs = require("node:fs");
const ready = ${JSON.stringify(readyFile)};
fs.writeFileSync(ready + ".tmp", JSON.stringify({
  pid: process.pid, file: process.argv[2]
}));
fs.renameSync(ready + ".tmp", ready);
setTimeout(() => fs.writeFileSync(${JSON.stringify(lateFile)}, "uploaded"), 1000);
setInterval(() => {}, 1000);
`,
  );
  const runner = resolve(project, "azure.cjs");
  await writeFile(
    runner,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = (error) => { process.stderr.write(error); process.exit(1); };
const name = option("--name");
if (args[2] === "lease") {
  if (args[3] === "acquire") {
    state.lease = option("--proposed-lease-id");
    save();
  } else {
    if (state.lease !== option("--lease-id")) fail("LeaseIdMismatch");
    if (args[3] === "release") {
      setTimeout(() => {
        state.lease = null;
        save();
        fs.writeFileSync(${JSON.stringify(releasedFile)}, "released");
      }, 200);
    }
  }
} else if (args[2] === "show") {
  const blob = state.blobs[name];
  if (!blob) fail("BlobNotFound");
  if (option("--output") === "json") process.stdout.write(JSON.stringify(blob));
  else if (option("--output") !== "none") process.stdout.write(blob.md5);
} else if (args[2] === "download") {
  fs.writeFileSync(option("--file"), Buffer.from(state.blobs[name].bytes, "base64"));
} else if (args[2] === "upload") {
  if (option("--content-cache-control") === ${JSON.stringify(aliasCacheControl)}) {
    if (!state.lease) fail("Alias write without lease");
    require("node:child_process").spawn(process.execPath,
      [${JSON.stringify(worker)}, option("--file")],
      { stdio: "inherit" });
  } else {
    const bytes = fs.readFileSync(option("--file"));
    state.blobs[name] = { bytes: bytes.toString("base64"), md5: option("--content-md5") };
    save();
  }
} else fail("Unsupported fake Azure command");
`,
  );
  const executable = resolve(project, "az");
  await writeFile(executable, `#!/bin/sh\n"${process.execPath}" "${runner}" "$@"\n`);
  await chmod(executable, 0o755);
  const script = publishing ? "publish-cdn.mjs" : "activate-cdn.mjs";
  const args = [
    resolve(scripts, script),
    "--account",
    "fixture",
    "--container",
    "tst",
    "--destination",
    publishing ? "next" : "public",
  ];
  if (!publishing) args.push("--from-storage");
  const cli = spawn(process.execPath, args, {
    cwd: project,
    env: { ...process.env, PATH: `${project}${delimiter}${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(cli, "close");
  let stderr = "";
  cli.stdout.resume();
  cli.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  let ready;
  let needsCleanup = true;
  t.after(async () => {
    if (needsCleanup && ready) {
      try {
        process.kill(ready.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
    await closed;
  });
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline && !ready) {
    try {
      ready = JSON.parse(await readFile(readyFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  assert.ok(ready, `CLI did not reach an alias upload: ${stderr}`);
  assert.ok(JSON.parse(await readFile(stateFile, "utf8")).lease, "activation must hold its lease");
  return {
    async cancel(signal, code) {
      cli.kill(signal);
      assert.deepEqual(await closed, [code, null], stderr);
      assert.match(stderr, new RegExp(`CDN operation cancelled by ${signal}`));
      assert.equal(await readFile(releasedFile, "utf8"), "released");
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).lease, null);
      await assert.rejects(readFile(ready.file), { code: "ENOENT" });
      needsCleanup = false;
      await delay(1_200);
      await assert.rejects(readFile(lateFile), { code: "ENOENT" });
    },
  };
}

for (const publishing of [true, false]) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    test(
      `${publishing ? "publishing" : "storage-only activation"} CLI ${signal} stops descendants and awaits lease cleanup`,
      { skip: process.platform === "win32", timeout: 30_000 },
      async (t) => {
        const fixture = await signalCliFixture(t, publishing);
        await fixture.cancel(signal, code);
      },
    );
  }
}

function storage() {
  const blobs = new Map();
  const leases = new Map();
  const calls = [];
  let serial = 0;
  const run = (args) => {
    calls.push(args);
    const option = (name) => args[args.indexOf(name) + 1];
    const key = `${option("--container-name")}/${option(args[2] === "lease" ? "--blob-name" : "--name")}`;
    const existing = blobs.get(key);
    if (args[2] === "lease") {
      const lease = leases.get(key);
      if (args[3] === "acquire") {
        assert.ok(existing, "lock blob must exist");
        assert.equal(option("--lease-duration"), "60");
        if (lease && lease.expires > performance.now()) {
          return { status: 1, stdout: "", stderr: "LeaseAlreadyPresent" };
        }
        leases.set(key, { id: option("--proposed-lease-id"), expires: performance.now() + 60_000 });
      } else {
        if (lease?.id !== option("--lease-id")) {
          return { status: 1, stdout: "", stderr: "LeaseIdMismatchWithLeaseOperation" };
        }
        if (args[3] === "renew") lease.expires = performance.now() + 60_000;
        else {
          assert.equal(args[3], "release");
          leases.delete(key);
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[2] === "show") {
      if (!existing) return { status: 3, stdout: "", stderr: "BlobNotFound" };
      const properties = {
        md5: md5(existing.bytes),
        etag: existing.etag,
        cacheControl: existing.headers["Cache-Control"],
      };
      return {
        status: 0,
        stdout: option("--output") === "json" ? JSON.stringify(properties) : properties.md5,
        stderr: "",
      };
    }
    if (args[2] === "download") {
      assert.ok(existing);
      writeFileSync(option("--file"), existing.bytes);
      return { status: 0, stdout: "", stderr: "" };
    }
    assert.equal(args[2], "upload");
    if (option("--overwrite") === "true") {
      assert.ok(args.includes("--if-match") || args.includes("--if-none-match"));
      if (
        (args.includes("--if-match") && option("--if-match") !== existing?.etag) ||
        (args.includes("--if-none-match") && existing)
      )
        return { status: 1, stdout: "", stderr: "ConditionNotMet" };
      assert.equal(option("--content-cache-control"), aliasCacheControl);
      const name = option("--name");
      const major = name.slice(name.lastIndexOf("/") + 1).split(".")[1];
      const lockKey = `${option("--container-name")}/${name.slice(0, name.lastIndexOf("/"))}/.major-${major}.activation.lock`;
      assert.ok(
        leases.get(lockKey)?.expires > performance.now(),
        "alias writes require the live shared lease",
      );
    } else {
      assert.equal(option("--overwrite"), "false");
      assert.ok(!existing, "immutable blobs must not be overwritten");
      assert.equal(
        option("--content-cache-control"),
        key.endsWith(".activation.lock") ? "no-store" : cacheControl,
      );
    }
    const bytes = readFileSync(option("--file"));
    assert.equal(option("--content-md5"), md5(bytes));
    blobs.set(key, {
      bytes,
      etag: `"${++serial}"`,
      headers: {
        "Content-Type": option("--content-type"),
        "Cache-Control": option("--content-cache-control"),
        "Access-Control-Allow-Origin": "*",
      },
    });
    return { status: 0, stdout: "", stderr: "" };
  };
  const verify = (options) =>
    verifyCdn({
      ...options,
      fetch: async (url) => {
        const blob = blobs.get(`cdn${new URL(url).pathname}`);
        return blob
          ? new Response(blob.bytes, { headers: blob.headers })
          : new Response(null, { status: 404 });
      },
    });
  return { blobs, leases, calls, run, verify };
}

test("next major aliases advance within a major; public aliases change only on promotion", async (t) => {
  const azure = storage();
  const beta1 = await release(t, "0.1.0-beta.1");
  const beta2 = await release(t, "0.1.0-beta.2");
  const major1 = await release(t, "1.0.0-beta.1");
  const options = { account: "store", container: "cdn", ...azure, log: () => {} };
  await publishCdn({ ...options, ...beta1, destination: "public" });
  assert.ok(!azure.blobs.has("cdn/scripts/otel/opentelemetry-browser.0.min.js"));
  await publishCdn({ ...options, ...beta1, destination: "next" });
  await activateCdnAliases({ ...options, ...beta1, destination: "public" });
  const publicAlias = azure.blobs.get("cdn/scripts/otel/opentelemetry-browser.0.min.js").bytes;
  const previousVersioned = new Map(
    getCdnUploads(beta1.version, "next").map(({ blob }) => [
      blob,
      azure.blobs.get(`cdn/${blob}`).bytes,
    ]),
  );
  await publishCdn({ ...options, ...beta2, destination: "public" });
  await publishCdn({ ...options, ...beta2, destination: "next" });
  const nextAlias = azure.blobs.get("cdn/next/otel/opentelemetry-browser.0.min.js").bytes;
  assert.match(nextAlias.toString(), /0\.1\.0-beta\.2/);
  assert.deepEqual(
    azure.blobs.get("cdn/scripts/otel/opentelemetry-browser.0.min.js").bytes,
    publicAlias,
  );
  for (const [blob, bytes] of previousVersioned)
    assert.deepEqual(azure.blobs.get(`cdn/${blob}`).bytes, bytes);
  for (const destination of ["next", "public"]) {
    for (const { blob } of getCdnUploads(beta1.version, destination)) {
      assert.equal(azure.blobs.get(`cdn/${blob}`).headers["Cache-Control"], cacheControl);
    }
  }
  await activateCdnAliases({ ...options, ...beta2, destination: "public" });
  assert.deepEqual(
    azure.blobs.get("cdn/scripts/otel/opentelemetry-browser.0.min.js").bytes,
    nextAlias,
  );
  const count = azure.calls.filter((args) => args[2] === "upload").length;
  await activateCdnAliases({ ...options, ...beta2, destination: "public" });
  assert.equal(azure.calls.filter((args) => args[2] === "upload").length, count);
  await publishCdn({ ...options, ...major1, destination: "next" });
  assert.deepEqual(
    azure.blobs.get("cdn/next/otel/opentelemetry-browser.0.min.js").bytes,
    nextAlias,
  );
  assert.match(
    azure.blobs.get("cdn/next/otel/opentelemetry-browser.1.min.js").bytes.toString(),
    /1\.0\.0-beta\.1/,
  );
  assert.equal(aliasCacheControl, "public, max-age=1800, no-transform");

  const aliases = await prepareCdnAliases(beta2.version, beta2.directory, "public");
  await azure.verify({ ...beta2, destination: "public", major: true, log: () => {} });
  await assert.rejects(
    azure.verify({ ...beta1, destination: "public", major: true, remoteOnly: true, log: () => {} }),
    /version 0\.1\.0-beta\.2, expected 0\.1\.0-beta\.1/,
  );
  assert.equal(aliases.length, 20);
  for (const alias of aliases) {
    assert.deepEqual(azure.blobs.get(`cdn/${alias.blob}`).bytes, alias.bytes);
    if (alias.file.endsWith(".js")) {
      assert.ok(alias.bytes.toString().endsWith(`//# sourceMappingURL=${alias.file}.map\n`));
      const map = JSON.parse(aliases.find(({ file }) => file === `${alias.file}.map`).bytes);
      assert.equal(map.file, alias.file);
    }
    if (alias.file.endsWith(".integrity.json")) {
      const json = JSON.parse(alias.bytes);
      assert.equal(json.version, beta2.version);
      for (const entry of Object.values(json.ext)) {
        const bundle = aliases.find(({ file }) => file === entry.file);
        assert.equal(entry.url, bundle.url);
        assert.deepEqual(entry.hashes, getIntegrity(bundle.bytes).hashes);
        assert.equal(entry.integrity, getIntegrity(bundle.bytes).integrity);
      }
    }
  }
  const aliasWrites = azure.calls.filter(
    (args) => args[2] === "upload" && args.includes(aliasCacheControl),
  );
  assert.ok(aliasWrites.some((args) => args.includes("--if-none-match")));
  assert.ok(aliasWrites.some((args) => args.includes("--if-match")));
  const lastBatch = aliasWrites.slice(-20);
  assert.ok(
    lastBatch
      .slice(-2)
      .every((args) => args[args.indexOf("--name") + 1].endsWith(".integrity.json")),
  );
});

test("storage-only promotion uses the requested release, not package.json or current build", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.2");
  const options = { account: "store", container: "cdn", ...azure, log: () => {} };
  await publishCdn({ ...options, ...beta, destination: "public" });
  await activateCdnAliases({
    ...options,
    version: beta.version,
    directory: "not-a-build",
    destination: "public",
    fromStorage: true,
  });
  assert.equal(azure.calls.filter((args) => args[2] === "download").length, 20);
  assert.match(
    azure.blobs.get("cdn/scripts/otel/opentelemetry-browser.0.min.js").bytes.toString(),
    /0\.1\.0-beta\.2/,
  );
  for (const args of azure.calls.filter((args) => args[2] === "download")) {
    await assert.rejects(readFile(args[args.indexOf("--file") + 1]), { code: "ENOENT" });
  }
});

test("failed publication and failed preflight never activate aliases", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const options = {
    account: "store",
    container: "cdn",
    ...azure,
    ...beta,
    destination: "next",
    log: () => {},
  };
  let activated = false;
  await assert.rejects(
    publishCdn({
      ...options,
      verify: () => {
        throw new Error("CDN verification failed");
      },
      activate: () => {
        activated = true;
      },
    }),
    /CDN verification failed/,
  );
  assert.equal(activated, false);
  const versioned = getCdnUploads(beta.version, "next").at(-1);
  azure.blobs.delete(`cdn/${versioned.blob}`);
  const before = azure.calls.filter((args) => args[2] === "upload").length;
  await assert.rejects(activateCdnAliases(options), /Unable to activate unpublished/);
  assert.equal(azure.calls.filter((args) => args[2] === "upload").length, before);
  await publishCdn({ ...options, activate: async () => {} });
  const first = getCdnUploads(beta.version, "next")[0];
  const saved = azure.blobs.get(`cdn/${first.blob}`);
  azure.blobs.set(`cdn/${first.blob}`, { ...saved, bytes: Buffer.from("different") });
  await assert.rejects(activateCdnAliases(options), /differs from the activation release/);
  assert.ok(!azure.blobs.has("cdn/next/otel/opentelemetry-browser.0.min.js"));
});

test("storage-only download failures and corruption cannot activate aliases", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const options = {
    account: "store",
    container: "cdn",
    ...azure,
    ...beta,
    destination: "public",
    log: () => {},
  };
  await publishCdn(options);
  for (const corruption of [false, true]) {
    const temporaryFiles = [];
    await assert.rejects(
      activateCdnAliases({
        ...options,
        fromStorage: true,
        run: (args) => {
          if (args[2] === "download") {
            const file = args[args.indexOf("--file") + 1];
            temporaryFiles.push(file);
            if (!corruption) return { status: 1, stdout: "", stderr: "download failed" };
            const result = azure.run(args);
            writeFileSync(file, "corrupted");
            return result;
          }
          return azure.run(args);
        },
      }),
      corruption ? /differs from the activation release/ : /Unable to download .*download failed/,
    );
    for (const file of temporaryFiles) await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.ok(!azure.blobs.has("cdn/scripts/otel/opentelemetry-browser.0.min.js"));
  }
});

test("identical aliases with incorrect cache policy are conditionally repaired", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const options = {
    account: "store",
    container: "cdn",
    ...azure,
    ...beta,
    destination: "public",
    log: () => {},
  };
  await publishCdn(options);
  await activateCdnAliases(options);
  const key = "cdn/scripts/otel/opentelemetry-browser.0.min.js";
  const blob = azure.blobs.get(key);
  blob.headers["Cache-Control"] = cacheControl;
  const before = azure.calls.filter((args) => args[2] === "upload").length;
  await activateCdnAliases(options);
  assert.equal(azure.calls.filter((args) => args[2] === "upload").length, before + 1);
  assert.deepEqual(azure.blobs.get(key).bytes, blob.bytes);
  assert.equal(azure.blobs.get(key).headers["Cache-Control"], aliasCacheControl);
});

test("alias replacement refuses missing ETags and concurrent updates and cleans temporary files", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const options = {
    account: "store",
    container: "cdn",
    ...azure,
    ...beta,
    destination: "public",
    log: () => {},
  };
  await publishCdn(options);
  for (const mode of ["missing-etag", "race", "authorization"]) {
    let temporaryFile;
    await assert.rejects(
      activateCdnAliases({
        ...options,
        run: (args) => {
          if (args.includes("--output") && args[args.indexOf("--output") + 1] === "json") {
            if (mode === "authorization")
              return { status: 1, stdout: "", stderr: "AuthorizationPermissionMismatch" };
            if (mode === "missing-etag") return { status: 0, stdout: '{"md5":"old"}', stderr: "" };
          }
          if (args[2] === "upload" && args.includes(aliasCacheControl)) {
            temporaryFile = args[args.indexOf("--file") + 1];
            return { status: 1, stdout: "", stderr: "ConditionNotMet" };
          }
          return azure.run(args);
        },
      }),
      mode === "missing-etag"
        ? /Missing ETag/
        : mode === "race"
          ? /Failed to activate .*ConditionNotMet/
          : /Unable to check .*AuthorizationPermissionMismatch/,
    );
    if (temporaryFile) await assert.rejects(readFile(temporaryFile), { code: "ENOENT" });
    assert.ok(!azure.blobs.has("cdn/scripts/otel/opentelemetry-browser.0.min.js"));
  }
});

test("activation validates versions/destinations; dry-run is offline; tst stays isolated", async (t) => {
  assert.equal(getCdnMajor("0.1.0-beta.1"), "0");
  assert.throws(() => getCdnAliasUploads("latest", "public"), /Unsupported CDN release version/);
  assert.throws(() => getCdnAliasUploads("0.1.0-beta.1"), /require an explicit CDN destination/);
  const offline = () => assert.fail("must not make network calls");
  await assert.rejects(
    activateCdnAliases({ version: "0.1.0-beta.1", destination: "wrong", run: offline }),
    /Unsupported CDN destination/,
  );
  const logs = [];
  await activateCdnAliases({
    version: "0.1.0-beta.2",
    destination: "public",
    fromStorage: true,
    dryRun: true,
    run: offline,
    verify: offline,
    log: (line) => logs.push(line),
  });
  assert.equal(logs.length, 20);
  assert.ok(
    logs.every((line) => line.includes("/scripts/otel/") && !line.includes(".0.1.0-beta.2.")),
  );
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  await publishCdn({
    ...beta,
    account: "store",
    container: "tst",
    destination: "next",
    run: azure.run,
    verify: offline,
    log: () => {},
  });
  assert.ok(azure.blobs.has("tst/next/otel/opentelemetry-browser.0.min.js"));
  assert.ok([...azure.blobs.keys()].every((key) => key.startsWith("tst/")));
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/activate-cdn.mjs",
      "--account",
      "store",
      "--destination",
      "public",
      "--version",
      "0.1.0-beta.2",
      "--from-storage",
      "--dry-run",
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /scripts\/otel\/opentelemetry-browser\.0\.min\.js/);
});

test("malformed alias source maps and references fail before alias writes", async (t) => {
  const beta = await release(t, "0.1.0-beta.1");
  const artifact = getCdnArtifacts(beta.version)[0];
  const map = resolve(beta.directory, `${artifact.file}.map`);
  await writeFile(map, '{"file":"wrong.js"}');
  await assert.rejects(
    prepareCdnAliases(beta.version, beta.directory, "next"),
    /Invalid CDN source map/,
  );
  await writeFile(resolve(beta.directory, artifact.file), "no source map reference");
  await assert.rejects(
    prepareCdnAliases(beta.version, beta.directory, "next"),
    /does not end with its source map reference/,
  );
});

test(
  "independent activation clients cannot interleave different releases in the same major",
  { timeout: 10_000 },
  async (t) => {
    const azure = storage();
    const beta1 = await release(t, "0.1.0-beta.1");
    const beta2 = await release(t, "0.1.0-beta.2");
    const major1 = await release(t, "1.0.0-beta.1");
    const options = {
      account: "store",
      container: "cdn",
      destination: "public",
      verify: azure.verify,
      log: () => {},
    };
    await publishCdn({ ...options, ...beta1, run: azure.run });
    await publishCdn({ ...options, ...beta2, run: azure.run });
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    let firstWrite;
    const written = new Promise((resolve) => {
      firstWrite = resolve;
    });
    let interrupted = false;
    let renewedWhilePaused;
    const renewal = new Promise((resolve) => {
      renewedWhilePaused = resolve;
    });
    const client1 = async (args) => {
      const result = azure.run(args);
      if (interrupted && args[2] === "lease" && args[3] === "renew") renewedWhilePaused();
      if (!interrupted && args[2] === "upload" && args.includes(aliasCacheControl)) {
        interrupted = true;
        firstWrite();
        await paused;
      }
      return result;
    };
    const client2 = async (args) => azure.run(args);
    const first = activateCdnAliases({ ...options, ...beta1, run: client1, renewalIntervalMs: 5 });
    t.after(() => resume());
    await written;
    await assert.rejects(
      activateCdnAliases({ ...options, ...beta2, run: client2 }),
      /Unable to acquire activation lease .*LeaseAlreadyPresent/,
    );
    await publishCdn({ ...options, ...beta1, destination: "next", run: client2 });
    await publishCdn({ ...options, ...major1, run: client2 });
    await activateCdnAliases({ ...options, ...major1, run: client2 });
    await publishCdn({ ...options, ...beta1, container: "tst", run: client2 });
    await activateCdnAliases({ ...options, ...beta1, container: "tst", run: client2 });
    assert.equal(
      azure.leases.size,
      1,
      "other destinations, majors and containers do not share this lock",
    );
    await renewal;
    resume();
    await first;
    assert.equal(azure.leases.size, 0);
    await azure.verify({ ...beta1, destination: "public", major: true, log: () => {} });
    await activateCdnAliases({ ...options, ...beta2, run: client2 });
    await azure.verify({ ...beta2, destination: "public", major: true, log: () => {} });
    assert.equal(azure.leases.size, 0);
  },
);

test(
  "renewal protects a pending upload and failure cancels it before subsequent aliases",
  { timeout: 10_000 },
  async (t) => {
    const azure = storage();
    const beta = await release(t, "0.1.0-beta.1");
    const options = {
      account: "store",
      container: "cdn",
      destination: "public",
      ...beta,
      verify: azure.verify,
      log: () => {},
    };
    await publishCdn({ ...options, run: azure.run });
    let renewals = 0;
    let pending = false;
    let temporaryFile;
    let cancelled = false;
    const run = async (args, { signal } = {}) => {
      if (args[2] === "lease" && args[3] === "renew") {
        renewals++;
        if (pending) return { status: 1, stdout: "", stderr: "LeaseLost" };
      }
      if (args[2] === "upload" && args.includes(aliasCacheControl)) {
        pending = true;
        temporaryFile = args[args.indexOf("--file") + 1];
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      return azure.run(args);
    };
    await assert.rejects(
      activateCdnAliases({ ...options, run, renewalIntervalMs: 5 }),
      /Unable to renew activation lease .*LeaseLost/,
    );
    assert.ok(renewals >= 3, "lease renews while an upload is pending");
    assert.equal(cancelled, true);
    assert.equal(azure.leases.size, 0);
    assert.ok(!azure.blobs.has("cdn/scripts/otel/opentelemetry-browser.0.min.js"));
    await assert.rejects(readFile(temporaryFile), { code: "ENOENT" });
  },
);

for (const phase of ["acquire", "upload", "release"]) {
  test(`parent cancellation during lease ${phase} awaits cleanup and fails activation`, async (t) => {
    const azure = storage();
    const beta = await release(t, "0.1.0-beta.1");
    const controller = new AbortController();
    const cancelled = new Error("Parent operation cancelled.");
    const options = {
      ...beta,
      account: "store",
      container: "tst",
      destination: "public",
      log: () => {},
    };
    await publishCdn({ ...options, run: azure.run });
    let released = false;
    const run = (args, options) => {
      if (args[2] === "lease" && args[3] === "release") {
        assert.equal(
          options?.signal,
          undefined,
          "cleanup must remain executable after cancellation",
        );
        released = true;
        if (phase === "release") controller.abort(cancelled);
      }
      if (phase === "acquire" && args[2] === "lease" && args[3] === "acquire") {
        azure.run(args);
        controller.abort(cancelled);
        options.signal.throwIfAborted();
      }
      if (phase === "upload" && args[2] === "upload" && args.includes(aliasCacheControl)) {
        controller.abort(cancelled);
        options.signal.throwIfAborted();
      }
      return azure.run(args);
    };
    await assert.rejects(
      activateCdnAliases({ ...options, run, signal: controller.signal }),
      (error) => error === cancelled,
    );
    assert.equal(released, true);
    assert.equal(azure.leases.size, 0);
    if (phase !== "release") {
      assert.ok(!azure.blobs.has("tst/scripts/otel/opentelemetry-browser.0.min.js"));
    }
  });
}

test("parent cancellation surfaces lease cleanup failure", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const controller = new AbortController();
  const options = {
    ...beta,
    account: "store",
    container: "tst",
    destination: "public",
    log: () => {},
  };
  await publishCdn({ ...options, run: azure.run });
  const run = (args, options) => {
    if (args[2] === "upload" && args.includes(aliasCacheControl)) {
      controller.abort(new Error("Parent operation cancelled."));
      options.signal.throwIfAborted();
    }
    if (args[2] === "lease" && args[3] === "release") {
      return { status: 1, stdout: "", stderr: "release failed" };
    }
    return azure.run(args);
  };
  await assert.rejects(
    activateCdnAliases({ ...options, run, signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Parent operation cancelled/);
      assert.match(error.message, /Unable to release activation lease .*release failed/);
      return true;
    },
  );
});

for (const stage of ["request", "body"]) {
  test(`parent cancellation stops CDN verification during ${stage} without subsequent requests`, async (t) => {
    const beta = await release(t, "0.1.0-beta.1");
    const controller = new AbortController();
    const cancelled = new Error("Verification cancelled.");
    let requests = 0;
    const fetch = async (_url, { signal }) => {
      requests++;
      if (stage === "request") {
        controller.abort(cancelled);
        throw signal.reason;
      }
      return {
        status: 200,
        arrayBuffer: async () => {
          controller.abort(cancelled);
          throw signal.reason;
        },
      };
    };
    await assert.rejects(
      verifyCdn({ ...beta, fetch, signal: controller.signal, log: () => {} }),
      (error) => error === cancelled,
    );
    assert.equal(requests, 1);
  });
}

test("lease acquisition, release and alias-write failures are surfaced without leaking timers", async (t) => {
  const azure = storage();
  const beta = await release(t, "0.1.0-beta.1");
  const options = {
    account: "store",
    container: "cdn",
    destination: "public",
    ...beta,
    verify: azure.verify,
    log: () => {},
  };
  await publishCdn({ ...options, run: azure.run });
  await assert.rejects(
    activateCdnAliases({
      ...options,
      run: (args) =>
        args[2] === "lease" && args[3] === "acquire"
          ? { status: 1, stdout: "", stderr: "AuthorizationPermissionMismatch" }
          : azure.run(args),
    }),
    /Unable to acquire activation lease .*AuthorizationPermissionMismatch/,
  );
  assert.equal(azure.leases.size, 0);
  await assert.rejects(
    activateCdnAliases({
      ...options,
      run: (args) => {
        if (args[2] === "upload" && args.includes(aliasCacheControl)) {
          return { status: 1, stdout: "", stderr: "alias upload failed" };
        }
        if (args[2] === "lease" && args[3] === "release") {
          return { status: 1, stdout: "", stderr: "lease release failed" };
        }
        return azure.run(args);
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /Failed to activate .*alias upload failed/);
      assert.match(error.message, /Unable to release activation lease .*lease release failed/);
      return true;
    },
  );
  assert.equal(azure.leases.size, 1, "failed release leaves a finite lease, not a permanent lock");
  for (const lease of azure.leases.values()) lease.expires = performance.now() - 1;
  await activateCdnAliases({ ...options, run: azure.run });
  assert.equal(azure.leases.size, 0, "expired lease can be acquired by a new client");
  await assert.rejects(
    activateCdnAliases({
      ...options,
      run: (args) =>
        args[2] === "lease" && args[3] === "release"
          ? { status: 1, stdout: "", stderr: "lease release failed" }
          : azure.run(args),
    }),
    /Unable to release activation lease .*lease release failed/,
  );
  for (const lease of azure.leases.values()) lease.expires = performance.now() - 1;
  await activateCdnAliases({ ...options, run: azure.run });
  assert.equal(azure.leases.size, 0);
});

test("the verification CLI reports the overridden full version it actually audited", async (t) => {
  const { version: packageVersion } = JSON.parse(await readFile(resolve(root, "package.json")));
  const selectedVersion = "9.8.7-beta.2";
  assert.notEqual(selectedVersion, packageVersion);
  const beta = await release(t, selectedVersion);
  const files = new Map(
    await Promise.all(
      getCdnUploads(selectedVersion, "public").map(async (upload) => [
        `/${upload.blob}`,
        {
          ...upload,
          bytes: await readCdnFile(selectedVersion, upload.file, beta.directory, "public"),
        },
      ]),
    ),
  );
  const server = createServer((request, response) => {
    const file = files.get(request.url);
    if (!file) return response.writeHead(404).end();
    response
      .writeHead(200, {
        "Content-Type": file.contentType,
        "Cache-Control": file.cacheControl,
        "Access-Control-Allow-Origin": "*",
      })
      .end(file.bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const child = spawn(
    process.execPath,
    [
      "scripts/verify-cdn.mjs",
      "--destination",
      "public",
      "--remote-only",
      "--version",
      selectedVersion,
      "--origin",
      `http://127.0.0.1:${server.address().port}`,
    ],
    { cwd: root, timeout: 30_000 },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  const [status] = await once(child, "close");
  assert.equal(status, 0, stderr);
  assert.ok(stdout.endsWith(`Verified 20 CDN files for ${selectedVersion}.\n`), stdout);
  assert.ok(!stdout.includes(`CDN files for ${packageVersion}.`));
});
