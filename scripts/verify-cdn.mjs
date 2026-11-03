// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "./check-node-version.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  cdnDirectory,
  cdnOrigin,
  getCdnArtifacts,
  getCdnAliasUploads,
  getCdnMajor,
  getCdnUploads,
  getIntegrity,
  getCdnUrl,
  readCdnFile,
  prepareCdnAliases,
  root,
} from "./cdn.mjs";

const usage = `Usage: npm run cdn:verify -- [--destination next|public] [--major] [--version <full-version>] [--remote-only] [--origin <url>]

Fetches every published CDN file for this package version and checks the status, Content-Type,
Cache-Control and CORS headers, that each integrity.json hash matches the served bundle and, unless
--remote-only is set, that the served bytes equal the files prepared in cdn/ by \`npm run build\`,
with integrity URLs adapted to the selected destination. Omission retains legacy channel routing.
--major audits mutable major aliases instead, after their 30-minute CDN cache has expired.`;

const directives = (value) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(", ");
const normalizeType = (value) => (value ?? "").replace(/\s+/g, "").toLowerCase();

/** Verifies the published CDN files for `version` and returns them; throws listing every problem. */
export async function verifyCdn({
  version,
  destination,
  major = false,
  directory = cdnDirectory,
  remoteOnly = false,
  origin = cdnOrigin,
  fetch = globalThis.fetch,
  timeoutMs = 60_000,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const toServed = (url) => (origin === cdnOrigin ? url : url.replace(cdnOrigin, origin));
  const problems = [];
  const served = new Map();
  const uploads = major
    ? getCdnAliasUploads(version, destination)
    : getCdnUploads(version, destination);
  const aliasFiles =
    major && !remoteOnly
      ? new Map(
          (await prepareCdnAliases(version, directory, destination)).map(({ file, bytes }) => [
            file,
            bytes,
          ]),
        )
      : undefined;
  const fileVersion = major ? getCdnMajor(version) : version;

  for (const upload of uploads) {
    const url = toServed(upload.url);
    const fail = (problem) => problems.push(`${url}: ${problem}`);
    // One deadline covers both the headers and the body.
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: { Origin: "https://example.com" },
        cache: "no-store",
        signal,
      });
    } catch (error) {
      fail(`request failed (${error.message})`);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(`status ${response.status}`);
      continue;
    }
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      fail(
        `download failed (${signal.aborted ? `timed out after ${timeoutMs} ms` : error.message})`,
      );
      continue;
    }
    served.set(upload.url, bytes);
    const headers = response.headers;
    if (normalizeType(headers.get("content-type")) !== normalizeType(upload.contentType)) {
      fail(`Content-Type ${headers.get("content-type")}, expected ${upload.contentType}`);
    }
    if (directives(headers.get("cache-control")) !== directives(upload.cacheControl)) {
      fail(`Cache-Control ${headers.get("cache-control")}, expected ${upload.cacheControl}`);
    }
    if (headers.get("access-control-allow-origin") !== "*") {
      fail(`Access-Control-Allow-Origin ${headers.get("access-control-allow-origin")}`);
    }
    if (!remoteOnly) {
      let local;
      try {
        local = major
          ? aliasFiles.get(upload.file)
          : await readCdnFile(version, upload.file, directory, destination);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!local) fail(`missing local ${upload.file}; run \`npm run build\` or pass --remote-only`);
      else if (!local.equals(bytes)) fail("content differs from the local build");
    }
    log(`Checked ${url}`);
  }

  for (const [url, bytes] of served) {
    if (!url.endsWith(".integrity.json")) continue;
    let integrity;
    try {
      integrity = JSON.parse(bytes.toString("utf8"));
    } catch {
      problems.push(`${toServed(url)}: invalid JSON`);
      continue;
    }
    const ext = integrity.ext ?? {};
    if (integrity.version !== version) {
      problems.push(`${toServed(url)}: version ${integrity.version}, expected ${version}`);
    }
    const expected = getCdnArtifacts(version)
      .map((artifact) => ({
        ...artifact,
        file: artifact.file.replace(`.${version}.`, `.${fileVersion}.`),
      }))
      .filter(
        ({ module }) =>
          url === getCdnUrl(version, `${module}.${fileVersion}.integrity.json`, destination),
      );
    const expectedKeys = new Set(expected.map(({ format }) => `@${format}`));
    for (const key of Object.keys(ext)) {
      if (!expectedKeys.has(key)) problems.push(`${toServed(url)}: unexpected entry ${key}`);
    }
    for (const { format, file } of expected) {
      const entry = ext[`@${format}`];
      const fileUrl = getCdnUrl(version, file, destination);
      if (!entry) {
        problems.push(`${toServed(url)}: missing @${format}`);
        continue;
      }
      if (entry.url !== fileUrl) {
        problems.push(`${toServed(url)}: @${format} url ${entry.url}, expected ${fileUrl}`);
        continue;
      }
      const bundle = served.get(fileUrl);
      if (!bundle) {
        problems.push(`${toServed(url)}: ${fileUrl} was not served`);
        continue;
      }
      const actual = getIntegrity(bundle);
      for (const [algorithm, hash] of Object.entries(actual.hashes)) {
        if (entry.hashes?.[algorithm] !== hash) {
          problems.push(`${toServed(url)}: ${algorithm} does not match ${fileUrl}`);
        }
      }
      if (entry.integrity !== actual.integrity) {
        problems.push(`${toServed(url)}: integrity does not match ${fileUrl}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`CDN verification failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return [...served.keys()];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      "remote-only": { type: "boolean", default: false },
      origin: { type: "string", default: cdnOrigin },
      destination: { type: "string" },
      major: { type: "boolean", default: false },
      version: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const verified = await verifyCdn({
    version: values.version ?? version,
    destination: values.destination,
    major: values.major,
    remoteOnly: values["remote-only"],
    origin: values.origin,
  });
  process.stdout.write(`Verified ${verified.length} CDN files for ${version}.\n`);
}
