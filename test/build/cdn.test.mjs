// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  cacheControl,
  cdnDirectory,
  getCdnArtifacts,
  getCdnBadges,
  getCdnChannel,
  getCdnPath,
  getCdnUrl,
  getSizeBadgeMessage,
  modules,
  prepareCdn,
  prepareCdnAliases,
  readCdnFile,
  renderBadge,
  root,
} from "../../scripts/cdn.mjs";
import { getCdnUploads, publishCdn } from "../../scripts/publish-cdn.mjs";
import { verifyCdn } from "../../scripts/verify-cdn.mjs";

const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sha = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("base64");

test("maps release versions to CDN channels", () => {
  assert.equal(getCdnChannel("1.2.3"), "b");
  assert.equal(getCdnChannel("0.1.0-alpha.2"), "alpha");
  assert.equal(getCdnChannel("1.0.0-beta.1"), "beta");
  assert.equal(getCdnChannel("1.0.0-rc.1"), "rc");
  assert.throws(() => getCdnChannel("1.0.0-nightly.20261008"), /Unsupported CDN release channel/);
  assert.throws(() => getCdnChannel("latest"), /Unsupported CDN release version/);
  assert.equal(
    getCdnUrl("1.2.3", "opentelemetry-browser.1.2.3.min.js"),
    "https://js.monitor.azure.com/scripts/otel/b/opentelemetry-browser.1.2.3.min.js",
  );
});

for (const [destination, path] of [
  ["next", "next/otel"],
  ["public", "scripts/otel"],
]) {
  test(`${destination} preserves full beta filenames in every upload`, () => {
    const beta = "0.1.0-beta.1";
    const uploads = getCdnUploads(beta, destination);
    assert.equal(getCdnPath(beta, destination), path);
    assert.equal(uploads.length, 20);
    assert.deepEqual(
      uploads.map(({ file }) => file),
      getCdnUploads(beta).map(({ file }) => file),
    );
    for (const upload of uploads) {
      assert.equal(upload.blob, `${path}/${upload.file}`);
      assert.equal(upload.url, `https://js.monitor.azure.com/${upload.blob}`);
      assert.ok(upload.file.includes(`.${beta}.`), upload.file);
      assert.equal(upload.cacheControl, cacheControl);
    }
    assert.ok(uploads.some(({ file }) => file === `opentelemetry-browser.${beta}.min.js`));
    assert.ok(
      uploads.some(
        ({ file }) => file === `opentelemetry-browser-instrumentations.${beta}.umd.min.js.map`,
      ),
    );
    assert.ok(uploads.slice(-2).every(({ file }) => file.endsWith(".integrity.json")));
    for (const release of ["1.2.3", "0.1.0-alpha.2", "1.0.0-rc.1"]) {
      assert.equal(getCdnPath(release, destination), path);
    }
  });

  test(`${destination} prepares and publishes destination-specific integrity without changing cdn/`, async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "otel-cdn-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await prepareCdn({
      version,
      sourceDirectory: resolve(root, "dist", "browser"),
      outputDirectory: directory,
      destination,
    });
    const uploads = getCdnUploads(version, destination);
    const original = new Map(
      await Promise.all(
        uploads.map(async ({ file }) => [file, await readFile(resolve(cdnDirectory, file))]),
      ),
    );
    const stored = new Map();
    const temporaryPaths = [];
    let writes = 0;
    const run = (args) => {
      const option = (name) => args[args.indexOf(name) + 1];
      assert.equal(option("--container-name"), "cdn");
      const blob = option("--name");
      assert.ok(blob.startsWith(`${path}/`));
      if (args[2] === "show") {
        const existing = stored.get(blob);
        return existing
          ? { status: 0, stdout: sha("md5", existing.bytes), stderr: "" }
          : { status: 3, stdout: "", stderr: "BlobNotFound" };
      }
      assert.equal(args[2], "upload");
      assert.equal(option("--overwrite"), "false");
      const file = option("--file");
      const bytes = readFileSync(file);
      assert.equal(option("--content-md5"), sha("md5", bytes));
      if (blob.endsWith(".integrity.json")) {
        assert.notEqual(file, resolve(cdnDirectory, basename(blob)));
        temporaryPaths.push(file);
      }
      stored.set(blob, {
        bytes,
        headers: {
          "Content-Type": option("--content-type"),
          "Cache-Control": option("--content-cache-control"),
          "Access-Control-Allow-Origin": "*",
        },
      });
      writes++;
      return { status: 0, stdout: "", stderr: "" };
    };
    let verifications = 0;
    const fetch = async (url) => {
      const value = stored.get(new URL(url).pathname.slice(1));
      assert.ok(value, url);
      return new Response(value.bytes, { headers: value.headers });
    };
    const options = {
      version,
      account: "store",
      container: "cdn",
      destination,
      run,
      activate: async () => {},
      log: () => {},
      verify: async (options) => {
        assert.equal(options.destination, destination);
        verifications++;
        return verifyCdn({ ...options, fetch });
      },
    };
    await publishCdn(options);
    assert.equal(writes, uploads.length);
    assert.equal(verifications, 1);
    for (const upload of uploads) {
      const bytes = stored.get(upload.blob).bytes;
      assert.deepEqual(bytes, await readFile(resolve(directory, upload.file)));
      assert.deepEqual(
        await readFile(resolve(cdnDirectory, upload.file)),
        original.get(upload.file),
      );
      if (upload.file.endsWith(".integrity.json")) {
        const json = JSON.parse(bytes);
        for (const entry of Object.values(json.ext)) {
          assert.equal(entry.url, `https://js.monitor.azure.com/${path}/${entry.file}`);
          assert.equal(entry.hashes.sha384, sha("sha384", original.get(entry.file)));
        }
      }
    }
    for (const file of temporaryPaths) await assert.rejects(readFile(file), { code: "ENOENT" });

    await publishCdn(options);
    assert.equal(writes, uploads.length, "second publish skips every identical file");
    assert.equal(verifications, 2);
    const integrityUpload = uploads.at(-1);
    const saved = stored.get(integrityUpload.blob);
    stored.set(integrityUpload.blob, { ...saved, bytes: Buffer.from("different metadata") });
    await assert.rejects(publishCdn(options), /already exists with different content/);
    assert.equal(verifications, 2, "conflicting publish does not verify");
    stored.set(integrityUpload.blob, saved);
    const json = JSON.parse(saved.bytes);
    json.ext["@min.js"].url = getCdnUrl(version, json.ext["@min.js"].file);
    stored.set(integrityUpload.blob, { ...saved, bytes: Buffer.from(JSON.stringify(json)) });
    await assert.rejects(
      verifyCdn({ version, destination, fetch, remoteOnly: true, log: () => {} }),
      /url .*expected/,
    );

    for (const failure of ["AuthorizationPermissionMismatch", "network unavailable"]) {
      await assert.rejects(
        publishCdn({
          ...options,
          run: () => ({ status: 1, stdout: "", stderr: failure }),
        }),
        new RegExp(`Unable to check .*${failure}`),
      );
    }
    let failedPath;
    await assert.rejects(
      publishCdn({
        ...options,
        run: (args) => {
          const blob = args[args.indexOf("--name") + 1];
          if (!blob.endsWith(".integrity.json")) return run(args);
          if (args[2] === "show") return { status: 3, stdout: "", stderr: "BlobNotFound" };
          failedPath = args[args.indexOf("--file") + 1];
          return { status: 1, stdout: "", stderr: "upload failed" };
        },
      }),
      /Failed to upload .*upload failed/,
    );
    await assert.rejects(readFile(failedPath), { code: "ENOENT" });
  });

  test(`${destination} dry-run is offline and tst uploads never verify production`, async () => {
    const logs = [];
    const options = {
      version,
      account: "store",
      container: "tst",
      destination,
      log: (line) => logs.push(line),
      verify: () => assert.fail("must not verify production CDN"),
      activate: async () => {},
    };
    await publishCdn({
      ...options,
      dryRun: true,
      run: () => assert.fail("dry-run must not call Azure"),
    });
    assert.equal(logs.length, 20);
    assert.ok(logs.every((line) => line.includes(`/${path}/`)));
    let uploads = 0;
    await publishCdn({
      ...options,
      run: (args) => {
        assert.equal(args[args.indexOf("--container-name") + 1], "tst");
        if (args[2] === "show") return { status: 3, stdout: "", stderr: "BlobNotFound" };
        uploads++;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(uploads, 20);
    assert.match(logs.at(-1), /Skipped public CDN verification.*tst/);

    const cli = spawnSync(
      process.execPath,
      ["scripts/publish-cdn.mjs", "--account", "store", "--destination", destination, "--dry-run"],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.includes(`/${path}/opentelemetry-browser.${version}.min.js`));
    assert.doesNotMatch(cli.stdout, /\/scripts\/otel\/beta\//);
  });
}

test("rejects invalid destinations before storage or public requests", async () => {
  assert.throws(() => getCdnUploads(version, "beta"), /Unsupported CDN destination/);
  assert.throws(() => getCdnUploads("latest", "next"), /Unsupported CDN release version/);
  const offline = () => assert.fail("invalid destination must not make network calls");
  await assert.rejects(
    publishCdn({ version, destination: "wrong", run: offline, verify: offline }),
    /Unsupported CDN destination/,
  );
  await assert.rejects(
    verifyCdn({ version, destination: "wrong", fetch: offline }),
    /Unsupported CDN destination/,
  );
  for (const script of ["publish-cdn", "verify-cdn"]) {
    const cli = spawnSync(
      process.execPath,
      [
        `scripts/${script}.mjs`,
        "--destination",
        "wrong",
        ...(script === "publish-cdn" ? ["--account", "store", "--dry-run"] : []),
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /Unsupported CDN destination/);
  }
});

test("rejects malformed destination integrity metadata", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "otel-cdn-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = `opentelemetry-browser.${version}.integrity.json`;
  const json = JSON.parse(await readFile(resolve(cdnDirectory, file)));
  delete json.ext["@min.js"];
  await writeFile(resolve(directory, file), JSON.stringify(json));
  await assert.rejects(
    readCdnFile(version, file, directory, "next"),
    /Invalid CDN integrity metadata/,
  );
  json.ext["@min.js"] = { file: "wrong.js" };
  await writeFile(resolve(directory, file), JSON.stringify(json));
  await assert.rejects(
    readCdnFile(version, file, directory, "public"),
    /Invalid CDN integrity entry/,
  );
});

test("the snippet loads this version's CDN bundle by default", async () => {
  const { getSdkLoaderScript } = await import("../../dist/esm/snippet.js");
  const script = getSdkLoaderScript({ connectionString: "InstrumentationKey=test" });
  const src = /"src":"([^"]+)"/.exec(script)?.[1];
  assert.equal(src, getCdnUrl(version, `opentelemetry-browser.${version}.min.js`));
});

test("the documented snippets match the generated loader", async () => {
  const { getSdkLoaderScript } = await import("../../dist/esm/snippet.js");
  const script = getSdkLoaderScript({
    src: "https://js.monitor.azure.com/scripts/otel/CHANNEL/opentelemetry-browser.VERSION.min.js",
    connectionString: "YOUR_CONNECTION_STRING",
    integrity: "YOUR_INTEGRITY",
  });
  for (const file of ["README.md", "docs/packaging.md"]) {
    const docs = await readFile(resolve(root, file), "utf8");
    assert.ok(docs.replaceAll("\r\n", "\n").includes(`<script>\n${script}\n</script>`), file);
  }
});

test("the build prepares versioned CDN files with source maps and integrity", async () => {
  const artifacts = getCdnArtifacts(version);
  const integrityFiles = [
    `opentelemetry-browser-instrumentations.${version}.integrity.json`,
    `opentelemetry-browser.${version}.integrity.json`,
  ];
  assert.deepEqual(
    (await readdir(cdnDirectory)).sort(),
    [
      ...artifacts.flatMap(({ file }) => [file, `${file}.map`]),
      ...getCdnBadges(version).map(({ file }) => file),
      ...integrityFiles,
    ].sort(),
  );

  for (const integrityFile of integrityFiles) {
    const integrity = JSON.parse(await readFile(resolve(cdnDirectory, integrityFile), "utf8"));
    const moduleArtifacts = artifacts.filter(({ module }) => module === integrity.name);
    assert.equal(integrity.version, version);
    assert.deepEqual(
      Object.keys(integrity.ext).sort(),
      moduleArtifacts.map(({ format }) => `@${format}`).sort(),
    );

    for (const artifact of moduleArtifacts) {
      const bytes = await readFile(resolve(cdnDirectory, artifact.file));
      const source = await readFile(resolve(root, "dist", "browser", artifact.source), "utf8");
      const entry = integrity.ext[`@${artifact.format}`];
      assert.equal(entry.file, artifact.file);
      assert.equal(entry.url, getCdnUrl(version, artifact.file));
      assert.equal(entry.type, "text/javascript; charset=utf-8");
      assert.deepEqual(entry.hashes, {
        sha256: sha("sha256", bytes),
        sha384: sha("sha384", bytes),
        sha512: sha("sha512", bytes),
      });
      assert.equal(
        entry.integrity,
        `sha256-${entry.hashes.sha256} sha384-${entry.hashes.sha384} sha512-${entry.hashes.sha512}`,
      );
      assert.equal(
        bytes.toString("utf8"),
        source.replace(
          `//# sourceMappingURL=${artifact.source}.map`,
          `//# sourceMappingURL=${artifact.file}.map`,
        ),
      );
      const map = JSON.parse(await readFile(resolve(cdnDirectory, `${artifact.file}.map`), "utf8"));
      assert.equal(map.file, artifact.file);
      assert.ok(map.sourcesContent?.length > 0);
    }
  }
});

test("the production beta bundles produce major aliases with only source map references changed", async () => {
  const major = version.split(".")[0];
  for (const destination of ["next", "public"]) {
    const aliases = await prepareCdnAliases(version, cdnDirectory, destination);
    assert.equal(aliases.length, 20);
    for (const artifact of getCdnArtifacts(version)) {
      const file = artifact.file.replace(`.${version}.`, `.${major}.`);
      const alias = aliases.find((alias) => alias.file === file);
      const source = await readFile(resolve(cdnDirectory, artifact.file), "utf8");
      assert.equal(
        alias.bytes.toString(),
        source.replace(
          `//# sourceMappingURL=${artifact.file}.map`,
          `//# sourceMappingURL=${file}.map`,
        ),
      );
      assert.equal(alias.url, getCdnUrl(version, file, destination));
      const integrity = JSON.parse(
        aliases.find((alias) => alias.file === `${artifact.module}.${major}.integrity.json`).bytes,
      );
      assert.equal(integrity.version, version);
      assert.equal(integrity.ext[`@${artifact.format}`].hashes.sha384, sha("sha384", alias.bytes));
    }
  }
});

test("publishes a size badge for each default CDN bundle", async () => {
  for (const badge of getCdnBadges(version)) {
    const bytes = await readFile(resolve(cdnDirectory, badge.bundle));
    const message = getSizeBadgeMessage(bytes);
    assert.match(message, /^\d+\.\d KiB \/ \d+\.\d KiB gzip$/);
    assert.equal(
      await readFile(resolve(cdnDirectory, badge.file), "utf8"),
      renderBadge("size", message),
    );
  }
  assert.match(renderBadge("a&b", "<1>"), /aria-label="a&#38;b: &#60;1&#62;"/);
});

/** Evaluates a CDN script in a worker-like realm: browser APIs a worker has, but no window or DOM. */
function loadInWorkerRealm(code, file) {
  const realm = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance,
    URL,
    AbortController,
    TextEncoder,
    TextDecoder,
    navigator: { userAgent: "worker", language: "en-US" },
    location: new URL("https://example.test/worker.js"),
  });
  vm.runInContext("self = globalThis;", realm);
  vm.runInContext(code, realm, { filename: file });
  return vm.runInContext("globalThis.Microsoft", realm);
}

const runtimeKeys = async (entry) =>
  Object.keys(await import(pathToFileURL(resolve(root, "dist", "esm", entry)).href));

test("every CDN bundle loads without window and exposes its documented npm API", async () => {
  const otelApi = ["context", "diag", "logs", "metrics", "propagation", "trace"];
  // The loader snippet builds its resource with this; npm consumers import it themselves.
  const loaderApi = ["resourceFromAttributes"];
  const resourceDetectors = [
    "BrowserDetector",
    "browserDetector",
    "UserAgentDetector",
    "userAgentDetector",
  ];
  const npmKeys = [
    ...new Set([
      ...(await runtimeKeys("index.js")),
      ...(await runtimeKeys("instrumentations.js")),
      ...otelApi,
      ...loaderApi,
    ]),
  ];
  // The opt-in resource detectors are npm-only; no CDN bundle carries them.
  const sdkKeys = npmKeys.filter((key) => !resourceDetectors.includes(key)).sort();
  const instrumentationKeys = (await runtimeKeys("instrumentations.js")).sort();
  assert.ok(sdkKeys.includes("useMicrosoftOpenTelemetry"));
  assert.ok(sdkKeys.includes("getInstrumentations"));
  assert.ok(resourceDetectors.every((key) => npmKeys.includes(key)));

  for (const artifact of getCdnArtifacts(version)) {
    const code = await readFile(resolve(cdnDirectory, artifact.file), "utf8");
    const microsoft = loadInWorkerRealm(code, artifact.file);
    if (artifact.module === "opentelemetry-browser") {
      assert.deepEqual(Object.keys(microsoft.OpenTelemetry).sort(), sdkKeys, artifact.file);
      assert.doesNotMatch(code, /user_agent\.original/, artifact.file);
      assert.doesNotMatch(
        code,
        /Customer SDK stats export failed|Item_Success_Count|countEnvelopes|countDrop|createStatsSpanProcessor/,
        artifact.file,
      );
      assert.match(code, /Request_Success_Count/, artifact.file);
      for (const enabled of [false, true]) {
        const options = {
          connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
          sdkStats: { enabled },
        };
        for (const Exporter of [
          microsoft.OpenTelemetry.AzureMonitorSpanExporter,
          microsoft.OpenTelemetry.AzureMonitorLogRecordExporter,
        ]) {
          assert.throws(() => new Exporter(options), /only available through the npm package/);
        }
        await assert.rejects(
          microsoft.OpenTelemetry.useMicrosoftOpenTelemetry({ azureMonitor: options }),
          /only available through the npm package/,
        );
      }
    } else {
      assert.deepEqual(
        Object.keys(microsoft.OpenTelemetryInstrumentations).sort(),
        instrumentationKeys,
        artifact.file,
      );
    }
  }
});

test("the default CDN bundle carries every instrumentation without loading other files", async () => {
  const code = await readFile(
    resolve(cdnDirectory, `opentelemetry-browser.${version}.min.js`),
    "utf8",
  );
  // Inlined, not code-split: a CDN script cannot load sibling chunks.
  assert.doesNotMatch(code, /\bimport\(/);
  const { getInstrumentations } = loadInWorkerRealm(code, "min.js").OpenTelemetry;
  const all = Object.fromEntries(
    [
      "fetch",
      "xhr",
      "console",
      "errors",
      "navigation",
      "navigationTiming",
      "resourceTiming",
      "userAction",
      "webVitals",
    ].map((name) => [name, { enabled: true }]),
  );
  const instrumentations = await getInstrumentations(all);
  assert.equal(instrumentations.length, Object.keys(all).length);
  assert.equal(new Set(instrumentations.map((i) => i.instrumentationName)).size, 9);
  assert.equal((await getInstrumentations()).length, 2, "fetch and xhr are on by default");
});

test("publishes immutable files without overwriting and uploads integrity files last", async () => {
  const uploads = getCdnUploads(version);
  assert.equal(uploads.length, getCdnArtifacts(version).length * 2 + modules.length * 2);
  for (const upload of uploads.slice(-modules.length)) {
    assert.match(upload.file, /\.integrity\.json$/);
  }
  assert.deepEqual(
    uploads.filter(({ file }) => file.endsWith(".svg")).map(({ contentType }) => contentType),
    modules.map(() => "image/svg+xml; charset=utf-8"),
  );
  assert.ok(
    uploads.every(({ blob }) => blob.startsWith(`scripts/otel/${getCdnChannel(version)}/`)),
  );

  const calls = [];
  const existingMd5 = sha("md5", await readFile(resolve(cdnDirectory, uploads[1].file)));
  const run = (args) => {
    calls.push(args);
    const name = args[args.indexOf("--name") + 1];
    if (args[2] === "show") {
      if (name === uploads[1].blob) return { status: 0, stdout: `${existingMd5}\n`, stderr: "" };
      return { status: 3, stdout: "", stderr: "ErrorCode:BlobNotFound" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const saved = process.env.AZURE_STORAGE_SAS_TOKEN;
  delete process.env.AZURE_STORAGE_SAS_TOKEN;
  const verified = [];
  try {
    await publishCdn({
      version,
      account: "store",
      container: "cdn",
      run,
      verify: async (options) => verified.push(options.version),
      log: () => {},
    });
  } finally {
    if (saved !== undefined) process.env.AZURE_STORAGE_SAS_TOKEN = saved;
  }
  assert.deepEqual(verified, [version]);

  const uploadCalls = calls.filter((args) => args[2] === "upload");
  assert.equal(uploadCalls.length, uploads.length - 1);
  assert.ok(!uploadCalls.some((args) => args.includes(uploads[1].blob)));
  const first = uploadCalls[0];
  const option = (name) => first[first.indexOf(name) + 1];
  assert.equal(option("--account-name"), "store");
  assert.equal(option("--container-name"), "cdn");
  assert.equal(option("--auth-mode"), "login");
  assert.equal(option("--name"), uploads[0].blob);
  assert.equal(option("--content-type"), "text/javascript; charset=utf-8");
  assert.equal(option("--content-cache-control"), cacheControl);
  assert.equal(
    option("--content-md5"),
    sha("md5", await readFile(resolve(cdnDirectory, uploads[0].file))),
  );
  assert.equal(option("--overwrite"), "false");
  assert.equal(cacheControl, "public, max-age=31536000, immutable, no-transform");

  await assert.rejects(
    publishCdn({
      version,
      account: "store",
      container: "cdn",
      run: () => ({ status: 0, stdout: "different\n", stderr: "" }),
    }),
    /already exists with different content/,
  );
  await assert.rejects(
    publishCdn({
      version,
      account: "store",
      container: "cdn",
      run: () => ({ status: 1, stdout: "", stderr: "AuthorizationPermissionMismatch" }),
    }),
    /Unable to check .*AuthorizationPermissionMismatch/,
  );
});

test("the publish and verify CLIs load without an import cycle", () => {
  const publish = spawnSync(
    process.execPath,
    ["scripts/publish-cdn.mjs", "--account", "store", "--dry-run"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(publish.status, 0, publish.stderr);
  assert.match(publish.stdout, new RegExp(`Would upload .*integrity\\.json`));
  const verify = spawnSync(process.execPath, ["scripts/verify-cdn.mjs", "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /npm run cdn:verify/);
});

test("verifies published CDN headers, bytes and integrity hashes", async (t) => {
  let override = () => {};
  const server = createServer(async (request, response) => {
    const file = basename(new URL(request.url, "http://localhost").pathname);
    const bytes = await readFile(resolve(cdnDirectory, file)).catch(() => undefined);
    if (!bytes) return response.writeHead(404).end();
    const headers = {
      "Content-Type": getCdnUploads(version).find((upload) => upload.file === file).contentType,
      // Azure Storage reorders directives; verification compares them as a set.
      "Cache-Control": "no-transform, public, max-age=31536000, immutable",
    };
    if (request.headers.origin) headers["Access-Control-Allow-Origin"] = "*";
    const served = { headers, body: bytes };
    override(file, served);
    response.writeHead(200, served.headers);
    // A stalled response sends part of the body and never finishes.
    if (served.stall) response.write(served.body.subarray(0, 16));
    else response.end(served.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const options = {
    version,
    origin: `http://127.0.0.1:${server.address().port}`,
    log: () => {},
  };

  const verified = await verifyCdn(options);
  assert.deepEqual(
    verified.sort(),
    getCdnUploads(version)
      .map(({ url }) => url)
      .sort(),
  );

  const bundle = `opentelemetry-browser.${version}.min.js`;
  override = (file, served) => {
    if (file === bundle) served.body = Buffer.concat([served.body, Buffer.from("\n")]);
    if (file.endsWith(".map")) delete served.headers["Access-Control-Allow-Origin"];
    if (file.endsWith(".svg")) served.headers["Cache-Control"] = "public, max-age=300";
  };
  await assert.rejects(verifyCdn({ ...options, remoteOnly: true }), (error) => {
    assert.match(error.message, new RegExp(`${bundle}\\.map: Access-Control-Allow-Origin`));
    assert.match(error.message, /\.size\.svg: Cache-Control public, max-age=300/);
    assert.match(error.message, new RegExp(`integrity\\.json: sha256 does not match .*/${bundle}`));
    assert.doesNotMatch(error.message, /differs from the local build/);
    return true;
  });
  await assert.rejects(
    verifyCdn(options),
    new RegExp(`${bundle}: content differs from the local build`),
  );

  override = (file, served) => {
    if (file.endsWith(".integrity.json")) served.headers["Content-Type"] = "text/plain";
  };
  await assert.rejects(verifyCdn(options), /integrity\.json: Content-Type text\/plain/);

  const manifest = `opentelemetry-browser.${version}.integrity.json`;
  const editManifest = (edit) => {
    override = (file, served) => {
      if (file !== manifest) return;
      const integrity = JSON.parse(served.body.toString("utf8"));
      edit(integrity);
      served.body = Buffer.from(JSON.stringify(integrity));
    };
  };
  const remote = { ...options, remoteOnly: true };

  editManifest((integrity) => (integrity.ext = {}));
  await assert.rejects(verifyCdn(remote), (error) => {
    for (const format of ["min.js", "js", "umd.min.js", "umd.js"]) {
      assert.match(
        error.message,
        new RegExp(`${manifest}: missing @${format.replaceAll(".", "\\.")}(\\n|$)`),
      );
    }
    return true;
  });

  editManifest((integrity) => delete integrity.ext["@umd.js"]);
  await assert.rejects(verifyCdn(remote), new RegExp(`${manifest}: missing @umd\\.js`));

  editManifest((integrity) => {
    integrity.ext["@min.js"].integrity = integrity.ext["@js"].integrity;
  });
  await assert.rejects(verifyCdn(remote), (error) => {
    assert.match(error.message, new RegExp(`${manifest}: integrity does not match .*/${bundle}`));
    assert.doesNotMatch(error.message, /sha\d+ does not match/);
    return true;
  });

  override = (file, served) => {
    if (file === bundle) served.stall = true;
  };
  await assert.rejects(
    verifyCdn({ ...remote, timeoutMs: 500 }),
    new RegExp(`${bundle}: download failed \\(timed out after 500 ms\\)`),
  );
});
