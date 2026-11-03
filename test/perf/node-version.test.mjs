// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertSupportedNodeVersion } from "../../scripts/check-node-version.mjs";

const root = new URL("../../", import.meta.url);
const requiredNode = "^22.23.4 || ^24.22.1 || >=26.12.1";

test("requires the patched Node release floors and accepts newer patches and minors", () => {
  for (const version of [
    "22.23.4",
    "22.23.5",
    "22.24.0",
    "24.22.1",
    "24.22.2",
    "24.23.0",
    "26.12.1",
    "26.12.2",
    "26.13.0",
    "27.0.0",
    "28.0.0",
  ]) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version), version);
  }
  for (const version of [
    "20.99.99",
    "22.22.99",
    "22.23.3",
    "23.99.99",
    "24.21.99",
    "24.22.0",
    "25.99.99",
    "26.11.99",
    "26.12.0",
    "24.22.1-rc.1",
    "invalid",
  ]) {
    assert.throws(() => assertSupportedNodeVersion(version), /CVE-2026-111497/, version);
  }
});

test("all manifests, lockfiles, and npm install policies enforce the same runtime requirement", async () => {
  for (const directory of ["", "samples/", "poc/"]) {
    const manifest = JSON.parse(await readFile(new URL(`${directory}package.json`, root), "utf8"));
    const lock = JSON.parse(await readFile(new URL(`${directory}package-lock.json`, root), "utf8"));
    assert.equal(manifest.engines.node, requiredNode, directory);
    assert.deepEqual(lock.packages[""].engines, manifest.engines, directory);
    assert.match(
      await readFile(new URL(`${directory}.npmrc`, root), "utf8"),
      /^engine-strict=true$/m,
      directory,
    );
    if (directory === "samples/") {
      assert.equal(lock.packages[".."].engines.node, requiredNode);
    }
  }
});

test("CI selects fresh Node versions with explicit patched minimums", async () => {
  for (const file of ["pr-validation.yml", "performance.yml", "docs.yml"]) {
    const workflow = await readFile(new URL(`.github/workflows/${file}`, root), "utf8");
    const setups = [
      ...workflow.matchAll(/uses: actions\/setup-node@[^\n]+\n\s+with:\n((?:[ \t]{10}[^\n]*\n)+)/g),
    ];
    assert.ok(setups.length > 0, file);
    for (const [, options] of setups) {
      assert.match(options, /node-version: (">=24\.22\.1 <25"|\$\{\{ matrix\.node-range \}\})/);
      assert.match(options, /check-latest: true/);
    }
    if (file === "pr-validation.yml") {
      assert.match(workflow, /node-version: "22"\n\s+node-range: ">=22\.23\.4 <23"/);
      assert.match(workflow, /node-version: "24"\n\s+node-range: ">=24\.22\.1 <25"/);
    }
  }
});

test("network entry points reject vulnerable runtimes before fetch or HTTP requests", () => {
  for (const script of [
    "scripts/perf/cdn.mjs",
    "scripts/perf/export.mjs",
    "scripts/verify-cdn.mjs",
    "scripts/publish-cdn.mjs",
    "scripts/activate-cdn.mjs",
  ]) {
    for (const version of ["22.23.3", "24.22.0", "26.12.0"]) {
      const entry = new URL(script, root).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import http from "node:http";
           import https from "node:https";
           const unexpectedNetwork = () => { throw new Error("UNEXPECTED_NETWORK"); };
           globalThis.fetch = unexpectedNetwork;
           http.get = https.get = unexpectedNetwork;
           Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
           await import(${JSON.stringify(entry)});`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${script} on ${version}: ${result.stderr}`);
      assert.match(result.stderr, /Unsupported Node\.js .*CVE-2026-111497/);
      assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
    }
  }
});
