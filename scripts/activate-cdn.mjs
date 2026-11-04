// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { root } from "./cdn.mjs";
import { activateCdnAliases, runCdnCommand } from "./publish-cdn.mjs";

const usage = `Usage: npm run cdn:activate -- --account <storage-account> --destination next|public
  [--container cdn] [--version <full-version>] [--from-storage] [--dry-run]

Explicitly promotes an already-published immutable version to mutable major aliases.
By default uses package.json and prepared cdn/ files. --from-storage downloads the selected
version's published files instead, so scheduled promotion needs no build artifacts.
Aliases use 30-minute caching and conditional writes; versioned files are never changed.
The tst container skips production CDN verification. --dry-run makes no network calls.`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      container: { type: "string", default: "cdn" },
      destination: { type: "string" },
      version: { type: "string" },
      "from-storage": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.account || !values.destination) {
    process.stdout.write(`${usage}\n`);
    process.exit(values.help ? 0 : 1);
  }
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await runCdnCommand((signal) =>
    activateCdnAliases({
      version: values.version ?? version,
      account: values.account,
      container: values.container,
      destination: values.destination,
      fromStorage: values["from-storage"],
      dryRun: values["dry-run"],
      signal,
    }),
  );
}
