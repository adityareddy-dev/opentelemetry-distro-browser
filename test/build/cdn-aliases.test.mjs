// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
  root,
} from "../../scripts/cdn.mjs";
import { activateCdnAliases, publishCdn } from "../../scripts/publish-cdn.mjs";
import { verifyCdn } from "../../scripts/verify-cdn.mjs";

const md5 = (bytes) => createHash("md5").update(bytes).digest("base64");

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

function storage() {
  const blobs = new Map();
  const calls = [];
  let serial = 0;
  const run = (args) => {
    calls.push(args);
    const option = (name) => args[args.indexOf(name) + 1];
    const key = `${option("--container-name")}/${option("--name")}`;
    const existing = blobs.get(key);
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
    } else {
      assert.equal(option("--overwrite"), "false");
      assert.ok(!existing, "immutable blobs must not be overwritten");
      assert.equal(option("--content-cache-control"), cacheControl);
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
  return { blobs, calls, run, verify };
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
          if (args[2] === "upload") {
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
