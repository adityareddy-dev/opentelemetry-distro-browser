// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cdnOrigin = "https://js.monitor.azure.com";
export const cdnDirectory = resolve(root, "cdn");
export const cacheControl = "public, max-age=31536000, immutable, no-transform";
export const aliasCacheControl = "public, max-age=1800, no-transform";

export const modules = ["opentelemetry-browser", "opentelemetry-browser-instrumentations"];
// Source format in dist/browser -> CDN format. The IIFE is the default because the loader snippet
// requires the `Microsoft.OpenTelemetry` global, which UMD skips when an AMD loader is present.
const formats = [
  ["iife.min.js", "min.js"],
  ["iife.js", "js"],
  ["umd.min.js", "umd.min.js"],
  ["umd.js", "umd.js"],
];

/** Returns the CDN release folder: `b` for stable releases, else the prerelease identifier. */
export function getCdnChannel(version) {
  const match = /^\d+\.\d+\.\d+(?:-([a-z]+)(?:\.\d+)?)?$/.exec(version);
  if (!match) throw new Error(`Unsupported CDN release version ${version}.`);
  const channel = match[1] ?? "b";
  if (!["b", "alpha", "beta", "rc"].includes(channel)) {
    throw new Error(`Unsupported CDN release channel ${channel} for version ${version}.`);
  }
  return channel;
}

/** Explicit destinations preserve the full release version; omission keeps legacy channel routing. */
export function getCdnPath(version, destination) {
  const channel = getCdnChannel(version);
  if (destination === undefined) return `scripts/otel/${channel}`;
  if (destination === "next") return "next/otel";
  if (destination === "public") return "scripts/otel";
  throw new Error(`Unsupported CDN destination ${destination}; expected next or public.`);
}

export const getCdnUrl = (version, file, destination) =>
  `${cdnOrigin}/${getCdnPath(version, destination)}/${file}`;

/** Lists each browser bundle in dist/browser with its versioned CDN file name. */
export function getCdnArtifacts(version) {
  return modules.flatMap((module) =>
    formats.map(([source, format]) => ({
      module,
      format,
      source: `${module}.${source}`,
      file: `${module}.${version}.${format}`,
    })),
  );
}

export function getCdnMajor(version) {
  getCdnChannel(version);
  return version.split(".")[0];
}

export function getCdnAliasUploads(version, destination) {
  if (destination === undefined)
    throw new Error("Major aliases require an explicit CDN destination.");
  const major = getCdnMajor(version);
  return getCdnUploads(version, destination).map((upload) => {
    const file = upload.file.replace(`.${version}.`, `.${major}.`);
    return {
      ...upload,
      file,
      source: upload.file,
      blob: `${getCdnPath(version, destination)}/${file}`,
      url: getCdnUrl(version, file, destination),
      cacheControl: aliasCacheControl,
    };
  });
}

/** Generates a consistent major-alias release from the prepared immutable files. */
export async function prepareCdnAliases(version, directory, destination) {
  const uploads = getCdnAliasUploads(version, destination);
  const files = new Map();
  const major = getCdnMajor(version);
  const integrityFiles = new Map();
  for (const artifact of getCdnArtifacts(version)) {
    const file = artifact.file.replace(`.${version}.`, `.${major}.`);
    const code = await readFile(resolve(directory, artifact.file), "utf8");
    const bytes = Buffer.from(renameSourceMapReference(code, artifact.file, file));
    const map = JSON.parse(await readFile(resolve(directory, `${artifact.file}.map`), "utf8"));
    if (map.file !== artifact.file) throw new Error(`Invalid CDN source map for ${artifact.file}.`);
    files.set(file, bytes);
    files.set(`${file}.map`, Buffer.from(JSON.stringify({ ...map, file })));
    const integrityFile = `${artifact.module}.${major}.integrity.json`;
    const json = integrityFiles.get(integrityFile) ?? {
      name: artifact.module,
      version,
      ext: {},
    };
    json.ext[`@${artifact.format}`] = {
      file,
      url: getCdnUrl(version, file, destination),
      type: getContentType(file),
      ...getIntegrity(bytes),
    };
    integrityFiles.set(integrityFile, json);
  }
  for (const badge of getCdnBadges(version)) {
    const file = badge.file.replace(`.${version}.`, `.${major}.`);
    const bundle = badge.bundle.replace(`.${version}.`, `.${major}.`);
    files.set(file, Buffer.from(renderBadge("size", getSizeBadgeMessage(files.get(bundle)))));
  }
  for (const [file, json] of integrityFiles) {
    files.set(file, Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  }
  return uploads.map((upload) => ({ ...upload, bytes: files.get(upload.file) }));
}

/** Size badge for each module's default (`min.js`) bundle, published next to it. */
export const getCdnBadges = (version) =>
  modules.map((module) => ({
    module,
    bundle: `${module}.${version}.min.js`,
    file: `${module}.${version}.size.svg`,
  }));

export function getContentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  return "application/json; charset=utf-8";
}

/** Lists the uploads for a version: bundles, source maps and badges first, integrity files last. */
export function getCdnUploads(version, destination) {
  const path = getCdnPath(version, destination);
  const files = getCdnArtifacts(version).flatMap(({ file }) => [file, `${file}.map`]);
  const badges = getCdnBadges(version).map(({ file }) => file);
  const integrityFiles = modules.map((module) => `${module}.${version}.integrity.json`);
  return [...files, ...badges, ...integrityFiles].map((file) => ({
    file,
    blob: `${path}/${file}`,
    url: getCdnUrl(version, file, destination),
    contentType: getContentType(file),
    cacheControl,
  }));
}

/** Reads prepared bytes, adapting only integrity URLs for an explicit publishing destination. */
export async function readCdnFile(version, file, directory = cdnDirectory, destination) {
  const bytes = await readFile(resolve(directory, file));
  if (destination === undefined || !file.endsWith(".integrity.json")) return bytes;
  const json = JSON.parse(bytes.toString("utf8"));
  const artifacts = getCdnArtifacts(version).filter(
    ({ module }) => file === `${module}.${version}.integrity.json`,
  );
  if (
    artifacts.length === 0 ||
    json.name !== artifacts[0].module ||
    json.version !== version ||
    Object.keys(json.ext ?? {}).length !== artifacts.length
  ) {
    throw new Error(`Invalid CDN integrity metadata in ${file}.`);
  }
  for (const artifact of artifacts) {
    const entry = json.ext[`@${artifact.format}`];
    if (entry?.file !== artifact.file) {
      throw new Error(`Invalid CDN integrity entry @${artifact.format} in ${file}.`);
    }
    entry.url = getCdnUrl(version, artifact.file, destination);
  }
  return Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
}

/** Formats the minified and gzip size of a bundle as the badge message. */
export function getSizeBadgeMessage(bytes) {
  const kib = (value) => `${(value / 1024).toFixed(1)} KiB`;
  return `${kib(bytes.byteLength)} / ${kib(gzipSync(bytes, { level: 9 }).byteLength)} gzip`;
}

// Approximate Verdana 11px advance widths; `textLength` makes the rendered text fit exactly.
const textWidth = (text) =>
  Math.ceil(
    [...text].reduce(
      (width, char) =>
        width + (/[\s.,:;/il|()]/.test(char) ? 3.9 : /[A-Z0-9]/.test(char) ? 7.6 : 6.8),
      0,
    ),
  );

/** Renders a self-contained, Shields-style flat badge without any network access. */
export function renderBadge(label, message, color = "#007ec6") {
  const escape = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const labelWidth = textWidth(label) + 10;
  const messageWidth = textWidth(message) + 10;
  const width = labelWidth + messageWidth;
  const text = (value, x, textLength) =>
    `<text x="${x * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${textLength * 10}">${value}</text>` +
    `<text x="${x * 10}" y="140" transform="scale(.1)" textLength="${textLength * 10}">${value}</text>`;
  const title = escape(`${label}: ${message}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="#555"/>` +
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>` +
    `<rect width="${width}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110">` +
    text(escape(label), labelWidth / 2, labelWidth - 10) +
    text(escape(message), labelWidth + messageWidth / 2, messageWidth - 10) +
    `</g></svg>\n`
  );
}

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("base64");

export function getIntegrity(bytes) {
  const hashes = {
    sha256: hash("sha256", bytes),
    sha384: hash("sha384", bytes),
    sha512: hash("sha512", bytes),
  };
  return {
    integrity: Object.entries(hashes)
      .map(([algorithm, value]) => `${algorithm}-${value}`)
      .join(" "),
    hashes,
  };
}

function renameSourceMapReference(code, source, file) {
  const reference = `//# sourceMappingURL=${source}.map`;
  const index = code.lastIndexOf(reference);
  if (index === -1 || code.slice(index + reference.length).trim() !== "") {
    throw new Error(`${source} does not end with its source map reference.`);
  }
  return `${code.slice(0, index)}//# sourceMappingURL=${file}.map${code.slice(index + reference.length)}`;
}

/**
 * Copies the built browser bundles to `cdn/` under immutable versioned names, with source maps,
 * a `<module>.<version>.size.svg` badge, and an `<module>.<version>.integrity.json` file per module.
 */
export async function prepareCdn({
  version,
  sourceDirectory,
  outputDirectory = cdnDirectory,
  destination,
}) {
  getCdnPath(version, destination);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const integrityFiles = new Map();
  for (const artifact of getCdnArtifacts(version)) {
    let code;
    let map;
    try {
      code = await readFile(resolve(sourceDirectory, artifact.source), "utf8");
      map = JSON.parse(await readFile(resolve(sourceDirectory, `${artifact.source}.map`), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Missing ${artifact.source}; run \`npm run build\` first.`, {
          cause: error,
        });
      }
      throw error;
    }
    const bytes = Buffer.from(renameSourceMapReference(code, artifact.source, artifact.file));
    await writeFile(resolve(outputDirectory, artifact.file), bytes);
    await writeFile(
      resolve(outputDirectory, `${artifact.file}.map`),
      JSON.stringify({ ...map, file: artifact.file }),
    );

    const integrityFile = `${artifact.module}.${version}.integrity.json`;
    const integrityJson = integrityFiles.get(integrityFile) ?? {
      name: artifact.module,
      version,
      ext: {},
    };
    integrityJson.ext[`@${artifact.format}`] = {
      file: artifact.file,
      url: getCdnUrl(version, artifact.file, destination),
      type: getContentType(artifact.file),
      ...getIntegrity(bytes),
    };
    integrityFiles.set(integrityFile, integrityJson);
  }

  for (const badge of getCdnBadges(version)) {
    const bytes = await readFile(resolve(outputDirectory, badge.bundle));
    await writeFile(
      resolve(outputDirectory, badge.file),
      renderBadge("size", getSizeBadgeMessage(bytes)),
    );
  }

  for (const [file, json] of integrityFiles) {
    await writeFile(resolve(outputDirectory, file), `${JSON.stringify(json, null, 2)}\n`);
  }
  return [...integrityFiles.keys()];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const written = await prepareCdn({
    version,
    sourceDirectory: resolve(root, "dist", "browser"),
  });
  process.stdout.write(
    `Prepared CDN files for ${getCdnUrl(version, "")} (${written.join(", ")})\n`,
  );
}
