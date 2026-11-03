// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  cdnDirectory,
  getCdnAliasUploads,
  getCdnMajor,
  getCdnPath,
  getCdnUploads,
  prepareCdnAliases,
  readCdnFile,
  root,
} from "./cdn.mjs";
import { verifyCdn } from "./verify-cdn.mjs";

export { getCdnUploads };

const usage = `Usage: npm run cdn:publish -- --account <storage-account> [--container cdn] [--destination next|public] [--dry-run]

Uploads the files prepared in cdn/ by \`npm run build\` to
<container>/next/otel/ or <container>/scripts/otel/ when a destination is selected;
omitting --destination retains <container>/scripts/otel/<channel>/.
Full versioned filenames and immutable caching are preserved. Existing files are never overwritten;
an identical existing file is skipped and a different one fails the publish. After uploading, it
runs \`npm run cdn:verify\` against the selected public CDN URLs, except for the isolated tst container.
--dry-run lists URLs without Azure calls or public verification.
Next publication activates major aliases after verification; public aliases require cdn:activate.

Authentication uses Azure CLI Entra ID login (--auth-mode login) unless
AZURE_STORAGE_SAS_TOKEN is set.`;

const quote = (value) => (/^[\w./:=@-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`);

function az(args, { signal } = {}) {
  // `az` is a batch file on Windows, which Node only starts through a shell.
  const windows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("az", windows ? args.map(quote) : args, {
      shell: windows,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let failure;
    let termination;
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      if (windows && child.pid) {
        // Killing cmd.exe alone leaves the Azure CLI subprocess running.
        termination = new Promise((done) => {
          const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          kill.once("error", (error) => {
            failure = new AggregateError(
              [failure, error],
              "Unable to stop Azure CLI process tree.",
            );
            child.kill("SIGKILL");
            done();
          });
          kill.once("close", (status) => {
            if (status !== 0) {
              failure = new AggregateError(
                [failure],
                `Unable to stop Azure CLI process tree (exit ${status}).`,
              );
              child.kill("SIGKILL");
            }
            done();
          });
        });
      } else child.kill("SIGKILL");
    };
    const abort = () => terminate(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => terminate(new Error("Azure CLI timed out after 30 seconds.")),
      30_000,
    );
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", async (status) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await termination;
      if (failure) reject(failure);
      else resolve({ status, stdout, stderr });
    });
  });
}

/** A finite, renewable storage lease serializes all clients writing one major alias set. */
async function withActivationLease(
  { version, destination, target, directory, run, log, renewalIntervalMs },
  activate,
) {
  const blob = `${getCdnPath(version, destination)}/.major-${getCdnMajor(version)}.activation.lock`;
  const existing = await run([
    "storage",
    "blob",
    "show",
    ...target,
    "--name",
    blob,
    "--output",
    "none",
  ]);
  if (existing.status !== 0) {
    if (!/BlobNotFound|ResourceNotFound|does not exist/i.test(existing.stderr)) {
      throw new Error(`Unable to check activation lock ${blob}: ${existing.stderr.trim()}`);
    }
    const file = resolve(directory, "activation.lock");
    await writeFile(file, "");
    const created = await run([
      "storage",
      "blob",
      "upload",
      ...target,
      "--name",
      blob,
      "--file",
      file,
      "--content-type",
      "application/octet-stream",
      "--content-cache-control",
      "no-store",
      "--content-md5",
      createHash("md5").update("").digest("base64"),
      "--overwrite",
      "false",
      "--if-none-match",
      "*",
      "--only-show-errors",
    ]);
    if (created.status !== 0) {
      if (!/BlobAlreadyExists|ConditionNotMet/i.test(created.stderr)) {
        throw new Error(`Unable to create activation lock ${blob}: ${created.stderr.trim()}`);
      }
      log(`Activation lock ${blob} was initialized by another client.`);
    }
  }
  const id = randomUUID();
  const leaseArgs = [
    ...target,
    "--blob-name",
    blob,
    "--timeout",
    "20",
    "--output",
    "none",
    "--only-show-errors",
  ];
  let expires = performance.now() + 60_000;
  const acquired = await run([
    "storage",
    "blob",
    "lease",
    "acquire",
    ...leaseArgs,
    "--lease-duration",
    "60",
    "--proposed-lease-id",
    id,
  ]);
  if (acquired.status !== 0) {
    throw new Error(`Unable to acquire activation lease ${blob}: ${acquired.stderr.trim()}`);
  }
  const controller = new AbortController();
  let failure;
  let renewing;
  let timer;
  let stopped = false;
  const renew = () => {
    if (renewing) return renewing;
    renewing = (async () => {
      try {
        controller.signal.throwIfAborted();
        if (performance.now() >= expires) throw new Error(`Activation lease ${blob} expired.`);
        const started = performance.now();
        const renewed = await run(
          ["storage", "blob", "lease", "renew", ...leaseArgs, "--lease-id", id],
          { signal: controller.signal },
        );
        if (renewed.status !== 0) {
          throw new Error(`Unable to renew activation lease ${blob}: ${renewed.stderr.trim()}`);
        }
        expires = started + 60_000;
      } catch (error) {
        failure = error;
        controller.abort(error);
        throw error;
      }
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      renew().then(schedule, (error) => log(`Activation stopped: ${error.message}`));
    }, renewalIntervalMs);
  };
  schedule();
  const errors = [];
  let result;
  try {
    result = await activate({ renew, signal: controller.signal });
    if (failure) throw failure;
  } catch (error) {
    if (failure && failure !== error) errors.push(failure);
    errors.push(error);
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (renewing) {
      try {
        await renewing;
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
      }
    }
    try {
      const released = await run([
        "storage",
        "blob",
        "lease",
        "release",
        ...leaseArgs,
        "--lease-id",
        id,
      ]);
      if (released.status !== 0) {
        errors.push(
          new Error(`Unable to release activation lease ${blob}: ${released.stderr.trim()}`),
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
  return result;
}

export async function publishCdn({
  version,
  account,
  container,
  destination,
  directory = cdnDirectory,
  dryRun = false,
  run = az,
  verify = verifyCdn,
  activate = activateCdnAliases,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const uploads = getCdnUploads(version, destination);
  const present = new Set(
    await readdir(directory).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    }),
  );
  const missing = uploads.filter(({ file }) => !present.has(file));
  if (missing.length > 0) {
    throw new Error(
      `Missing CDN files (${missing.map(({ file }) => file).join(", ")}); run \`npm run build\` first.`,
    );
  }

  const target = ["--account-name", account, "--container-name", container];
  if (!process.env.AZURE_STORAGE_SAS_TOKEN) target.push("--auth-mode", "login");

  let temporaryDirectory;
  try {
    for (const upload of uploads) {
      let path = resolve(directory, upload.file);
      if (dryRun) {
        log(`Would upload ${upload.file} -> ${upload.url}`);
        continue;
      }
      const bytes = await readCdnFile(version, upload.file, directory, destination);
      const md5 = createHash("md5").update(bytes).digest("base64");
      const existing = await run([
        "storage",
        "blob",
        "show",
        ...target,
        "--name",
        upload.blob,
        "--query",
        "properties.contentSettings.contentMd5",
        "--output",
        "tsv",
      ]);
      if (existing.status === 0) {
        if (existing.stdout.trim() !== md5) {
          throw new Error(`${upload.url} already exists with different content.`);
        }
        log(`Skipped ${upload.url} (already published)`);
        continue;
      }
      if (!/BlobNotFound|ResourceNotFound|does not exist/i.test(existing.stderr)) {
        throw new Error(`Unable to check ${upload.url}: ${existing.stderr.trim()}`);
      }

      if (destination !== undefined && upload.file.endsWith(".integrity.json")) {
        temporaryDirectory ??= await mkdtemp(resolve(tmpdir(), "otel-cdn-"));
        path = resolve(temporaryDirectory, upload.file);
        await writeFile(path, bytes);
      }
      const uploaded = await run([
        "storage",
        "blob",
        "upload",
        ...target,
        "--name",
        upload.blob,
        "--file",
        path,
        "--content-type",
        upload.contentType,
        "--content-cache-control",
        upload.cacheControl,
        "--content-md5",
        md5,
        "--overwrite",
        "false",
        "--only-show-errors",
      ]);
      if (uploaded.status !== 0) {
        throw new Error(`Failed to upload ${upload.url}: ${uploaded.stderr.trim()}`);
      }
      log(`Uploaded ${upload.url}`);
    }
    if (!dryRun) {
      if (container === "tst") log("Skipped public CDN verification for isolated tst container.");
      else await verify({ version, directory, destination, log });
    }
    if (destination === "next") {
      await activate({
        version,
        account,
        container,
        destination,
        directory,
        dryRun,
        run,
        log,
        verify: async () => {},
      });
    }
    return uploads;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Activates mutable major aliases only after checking the complete immutable release. */
export async function activateCdnAliases({
  version,
  account,
  container = "cdn",
  destination,
  directory = cdnDirectory,
  fromStorage = false,
  dryRun = false,
  run = az,
  verify = verifyCdn,
  renewalIntervalMs = 15_000,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const aliases = getCdnAliasUploads(version, destination);
  if (!Number.isFinite(renewalIntervalMs) || renewalIntervalMs <= 0 || renewalIntervalMs > 15_000) {
    throw new Error("Activation lease renewal interval must be between 0 and 15000 ms.");
  }
  const uploads = getCdnUploads(version, destination);
  if (dryRun) {
    for (const alias of aliases) log(`Would activate ${version} -> ${alias.url}`);
    return aliases;
  }
  const target = ["--account-name", account, "--container-name", container];
  if (!process.env.AZURE_STORAGE_SAS_TOKEN) target.push("--auth-mode", "login");
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "otel-cdn-"));
  try {
    if (fromStorage) directory = temporaryDirectory;
    // Check every immutable object before changing any alias, including in the isolated tst container.
    for (const upload of uploads) {
      const existing = await run([
        "storage",
        "blob",
        "show",
        ...target,
        "--name",
        upload.blob,
        "--query",
        "properties.contentSettings.contentMd5",
        "--output",
        "tsv",
      ]);
      if (existing.status !== 0) {
        throw new Error(`Unable to activate unpublished ${upload.url}: ${existing.stderr.trim()}`);
      }
      if (fromStorage) {
        const downloaded = await run([
          "storage",
          "blob",
          "download",
          ...target,
          "--name",
          upload.blob,
          "--file",
          resolve(directory, upload.file),
          "--only-show-errors",
        ]);
        if (downloaded.status !== 0) {
          throw new Error(`Unable to download ${upload.url}: ${downloaded.stderr.trim()}`);
        }
      }
      const bytes = await readCdnFile(version, upload.file, directory, destination);
      const md5 = createHash("md5").update(bytes).digest("base64");
      if (existing.stdout.trim() !== md5) {
        throw new Error(`Published ${upload.url} differs from the activation release.`);
      }
    }
    const prepared = await prepareCdnAliases(version, directory, destination);
    if (container !== "tst") await verify({ version, directory, destination, log });
    return await withActivationLease(
      {
        version,
        destination,
        target,
        directory: temporaryDirectory,
        run,
        log,
        renewalIntervalMs,
      },
      async ({ renew, signal }) => {
        for (const alias of prepared) {
          await renew();
          const md5 = createHash("md5").update(alias.bytes).digest("base64");
          const existing = await run(
            [
              "storage",
              "blob",
              "show",
              ...target,
              "--name",
              alias.blob,
              "--query",
              "{md5:properties.contentSettings.contentMd5,etag:properties.etag,cacheControl:properties.contentSettings.cacheControl}",
              "--output",
              "json",
            ],
            { signal },
          );
          let conditions;
          if (existing.status === 0) {
            const properties = JSON.parse(existing.stdout);
            if (properties.md5 === md5 && properties.cacheControl === alias.cacheControl) {
              log(`Skipped ${alias.url} (already activated)`);
              continue;
            }
            if (typeof properties.etag !== "string" || properties.etag.length === 0) {
              throw new Error(
                `Missing ETag for ${alias.url}; refusing unconditional alias replacement.`,
              );
            }
            conditions = ["--if-match", properties.etag];
          } else if (/BlobNotFound|ResourceNotFound|does not exist/i.test(existing.stderr)) {
            conditions = ["--if-none-match", "*"];
          } else {
            throw new Error(`Unable to check ${alias.url}: ${existing.stderr.trim()}`);
          }
          const path = resolve(temporaryDirectory, alias.file);
          await writeFile(path, alias.bytes);
          await renew();
          const uploaded = await run(
            [
              "storage",
              "blob",
              "upload",
              ...target,
              "--name",
              alias.blob,
              "--file",
              path,
              "--content-type",
              alias.contentType,
              "--content-cache-control",
              alias.cacheControl,
              "--content-md5",
              md5,
              "--overwrite",
              "true",
              ...conditions,
              "--only-show-errors",
            ],
            { signal },
          );
          if (uploaded.status !== 0) {
            throw new Error(`Failed to activate ${alias.url}: ${uploaded.stderr.trim()}`);
          }
          log(`Activated ${alias.url} from ${version}`);
        }
        return aliases;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      container: { type: "string", default: "cdn" },
      destination: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.account) {
    process.stdout.write(`${usage}\n`);
    process.exit(values.help ? 0 : 1);
  }
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await publishCdn({
    version,
    account: values.account,
    container: values.container,
    destination: values.destination,
    dryRun: values["dry-run"],
  });
}
