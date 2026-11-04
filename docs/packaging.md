# Browser package output

The [M0 planning document](../planning/M0_PLANNING.md) started with ES2022 ESM output.
`npm run build` now also emits CommonJS for npm bundlers and self-contained UMD and IIFE artifacts
for the browser:

| Artifact                             | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `dist/esm/index.js`                  | ESM package entry point                                                       |
| `dist/commonjs/index.cjs`            | CommonJS package entry point                                                  |
| `dist/esm/instrumentations.js`       | Tree-shakeable ESM instrumentation loader                                     |
| `dist/commonjs/instrumentations.cjs` | CommonJS instrumentation loader                                               |
| `dist/esm/index.min.js`              | Minified ESM bundle for browser size checks                                   |
| `dist/browser/*umd*.js`              | UMD SDK and instrumentation bundles for CommonJS, AMD, RequireJS, and globals |
| `dist/browser/*iife*.js`             | IIFE SDK and instrumentation bundles for direct classic-script loading        |
| `dist/esm/*.d.ts`                    | Public TypeScript declarations for ESM consumers                              |
| `dist/commonjs/*.d.cts`              | Public TypeScript declarations for CommonJS consumers                         |
| `dist/**/*.map`                      | Source maps with embedded source content                                      |
| `dist/esm/snippet.js`                | Configurable SDK loader snippet generator                                     |
| `dist/esm/snippet.d.ts`              | Loader snippet TypeScript declarations                                        |

Import the package through its `exports` map. The `main` and `module` fields support older bundlers
and point to the same files selected by the explicit `require` and `import` conditions. The
`package.json` metadata subpath remains available. The CommonJS entries `require()` ESM-only
OpenTelemetry packages, so they target bundlers and Node.js versions with `require(esm)` support;
CommonJS test runners such as Jest must transform those dependencies.

The `opentelemetry-browser.*` SDK bundles are self-contained and expose `Microsoft.OpenTelemetry`.
They also expose the standard OpenTelemetry APIs used by the bundled SDK, so direct-script
consumers can emit manual telemetry without loading a second API copy. They inline every
instrumentation and expose `getInstrumentations`, because a page loading them from the CDN has no
bundler to add instrumentations later. They omit the opt-in browser and user-agent resource
detectors and customer SDK Stats, which are available from the npm package only. CDN builds remove
customer reporting and pipeline accounting at build time, rather than only disabling them at runtime.
The loader snippet does not accept `azureMonitor.sdkStats`, and CDN exporters and initialization
reject that option. Internal SDK Stats remains unchanged. The
`opentelemetry-browser-instrumentations.*` bundles expose
only `Microsoft.OpenTelemetryInstrumentations` and include their own API copy, which shares state
with the SDK bundle through the OpenTelemetry global registry. Use IIFE when RequireJS may already be present; UMD deliberately registers with
AMD loaders.

`npm run test:build` checks the output inventory, ESM and CommonJS package resolution, declaration
consumption with TypeScript Node16, NodeNext, and Bundler resolution, source maps, minification,
and tree shaking. `npm run test:integration` imports the ESM bundles and loads every minified and
unminified UMD and IIFE artifact in Chromium, Firefox, and WebKit. It exercises both global and AMD
loading. `npm run test:e2e` sends page views, spans, logs and exceptions from the ESM build and the
minified CDN bundle to the real Azure Monitor ingestion service in all three engines and requires
every item to be accepted. It uses the public test resource that the Application Insights
JavaScript SDK end-to-end tests use and needs network access.
The `sideEffects: false` contract remains in place; importing the package does not initialize
telemetry.

The minified ESM artifact uses three Terser compression passes without property mangling or unsafe
compression options. The self-contained UMD and IIFE bundles use SWC as described below.

`npm run size` bundles real consumers of every published JavaScript entry point with Rollup,
tree-shakes and minifies each scenario, and reports gzip and Brotli transfer sizes. It measures the
API, SDK, distribution, Azure Monitor exporters, instrumentation loader, each selectable
instrumentation, and the complete combined configuration. Marginal deltas are always shown beside
independently measured totals. Do not add deltas because combined bundles count shared dependencies
once.

Every run regenerates `reports/bundle-size.json` and `reports/bundle-size.md`. The production build
also generates `reports/bundle-stats.html` for dependency analysis. CI renders the Markdown report
in each Node job's check summary and uploads all three files as build artifacts.
`npm run size:report` remains an alias for `npm run size`.

Every executable published entry point has absolute minified, gzip and Brotli budgets:

| Entry point          | Minified |     Gzip |  Brotli |
| -------------------- | -------: | -------: | ------: |
| `.`                  |   157 kB | 49.25 kB | 43.5 kB |
| `./instrumentations` |    64 kB |    24 kB |   22 kB |
| `./snippet`          |  6.25 kB |  2.75 kB |  2.5 kB |

The generated JSON and Markdown reports show the measured values, ceilings and result for each
entry point. During alpha releases, violations are report-only so the baselines can stabilize.
Starting with beta, `npm run size` exits unsuccessfully when any absolute budget is exceeded; the
same gate therefore blocks CI for beta, release-candidate and stable versions. The separate PR-base
comparison remains informational and does not replace the absolute gate.

`npm run size` also measures the minified self-contained browser bundles exactly as `npm run build`
emits them, so it must run after a production build. Their budgets block in every release channel,
including alpha:

| Artifact                                                   |  Minified |     Gzip |  Brotli |
| ---------------------------------------------------------- | --------: | -------: | ------: |
| `opentelemetry-browser.{iife,umd}.min.js`                  | 184.25 kB | 58.75 kB | 51.5 kB |
| `opentelemetry-browser-instrumentations.{iife,umd}.min.js` |     63 kB |    19 kB |   17 kB |

SWC minifies the browser bundles and shortens `_`-prefixed properties, the TypeScript `private`
convention used by OpenTelemetry, so source code keeps descriptive names. Members that
`sharedBrowserPatches.ts` reads on instrumentations from another bundle keep their names; add any
new cross-bundle `_` member to `crossBundleProperties` in `rollup.config.mjs`. An integration test
passes instrumentations from the minified instrumentation bundle to the minified SDK bundle.

The browser bundles contain only ES2022 syntax. `npm run test:build` parses every emitted UMD and
IIFE file as an ES2022 script and requires a budget for every minified browser bundle. It also scans
each bundle for post-ES2022 built-ins such as `Array.prototype.toSorted` or `Object.groupBy`;
the only allowed exception is ES2023 `Array.prototype.findLast`, which the upstream web-vitals code
uses. These checks set a language ceiling; they do not validate specific browser versions, which
remain provisional until exact supported versions are declared and tested.

## CDN and loader snippet

The publisher supports explicit preview and public destinations with immutable versioned filenames:

```text
https://js.monitor.azure.com/next/otel/<module>.<version>.<format>
https://js.monitor.azure.com/scripts/otel/<module>.<version>.<format>
```

Select one destination per invocation after `npm run build`:

```sh
npm run cdn:publish -- --account <storage-account> --destination public
npm run cdn:publish -- --account <storage-account> --destination next
```

Both copies retain the full package version, including its beta suffix. For `0.1.0-beta.1`, the
default SDK URLs are
`https://js.monitor.azure.com/next/otel/opentelemetry-browser.0.1.0-beta.1.min.js` and
`https://js.monitor.azure.com/scripts/otel/opentelemetry-browser.0.1.0-beta.1.min.js`.
Instrumentation bundles, UMD variants, source maps, size badges and integrity metadata accompany
the SDK in each destination. Publishing adapts the integrity URLs to the selected destination in
temporary local files without changing the prepared `cdn/` files or bundle bytes.

Omitting `--destination` retains the legacy version-derived channel location:

```text
https://js.monitor.azure.com/scripts/otel/<channel>/<module>.<version>.<format>
```

The channel is `b` for stable releases and the prerelease identifier (`alpha`, `beta` or `rc`)
otherwise. Each module (`opentelemetry-browser` and `opentelemetry-browser-instrumentations`) is
published as `min.js` and `js` (IIFE), and `umd.min.js` and `umd.js` (UMD), each with its source
map, plus `<module>.<version>.integrity.json`. The integrity file lists every file's CDN URL and
its SHA-256, SHA-384 and SHA-512 Subresource Integrity values. `<module>.<version>.size.svg` is a
badge showing the minified and gzip size of that module's `min.js` bundle.

`npm run build` prepares these files in `cdn/` from the same `dist/browser` bundles, renaming only
the source map references. `npm run cdn:publish -- --account <storage-account>` uploads them with
the Azure CLI, using Entra ID login unless `AZURE_STORAGE_SAS_TOKEN` is set, with
`public, max-age=31536000, immutable, no-transform` caching. It uploads the integrity files last,
never overwrites a published file, skips files that are already published with identical content,
and fails if a published file differs. Use `--dry-run` to list the URLs without Azure calls,
uploads or public verification. `--container` defaults to `cdn`; `--container tst` uploads to the
isolated test container and skips production CDN verification, independently of `--dry-run`.
Neither destination selection nor test mode changes npm tags, versions or beta release triggers.
Publishing never deletes or rewrites existing legacy channel assets.

### Major-version aliases and promotion

Customers can use `opentelemetry-browser.0.min.js` to receive updates within major version `0`.
These aliases deliberately omit the beta suffix. The same major-only naming applies to both
modules, every IIFE/UMD format, source maps, size badges and integrity files:

```text
https://js.monitor.azure.com/next/otel/opentelemetry-browser.0.min.js
https://js.monitor.azure.com/scripts/otel/opentelemetry-browser.0.min.js
```

Major aliases use `public, max-age=1800, no-transform` caching. Their source map references and
map `file` fields use the major-only names; their integrity metadata records the full activated
version and hashes the actual alias bundle bytes. Fully versioned files keep their one-year
immutable caching and cannot be replaced.

Successful `--destination next` publication activates next aliases after immutable-file verification.
Public versioned publication never changes public aliases. A caller publishing both destinations
must publish **public first, then next**, so next activation follows both successful uploads.
Promote an already-published version to public aliases explicitly:

```sh
npm run cdn:activate -- --account <storage-account> --destination public
```

This command requires fresh `cdn/` files for the selected full version, not stale build artifacts.
For scheduled promotion without local build artifacts, download the immutable release from storage:

```sh
node scripts/activate-cdn.mjs --account <storage-account> --destination public --version 0.1.0-beta.1 --from-storage
```

`--version` defaults to `package.json`; `--from-storage` uses that exact published version and
cleans up its temporary downloads. Activation checks every immutable object's content before any
alias write and verifies its production CDN URLs unless `--container tst` is selected. It skips
identical aliases, uses the observed ETag when replacing an alias, and requires absence when
creating one. Missing versions, content differences and failed conditional writes fail activation.
All activation clients share a storage lease on
`<destination>/.major-<major>.activation.lock` in the selected container. Its 60-second lease
renews during activation and before alias writes; a competing activation fails immediately instead
of waiting. Renewal failure cancels outstanding Azure work and stops activation; release failures
are reported, and an abandoned lease expires automatically. Azure CLI operations are bounded to
30 seconds so renewal can run while commands are in progress. The lock blob itself is not a
customer artifact and uses `no-store` caching.

Both publication and activation handle `SIGINT`/`SIGTERM` by cancelling active Azure commands,
stopping further uploads, and awaiting lease and temporary-file cleanup before exiting with
status 130/143. Cancellation kills isolated POSIX process groups or Windows process trees;
lease release is attempted separately even after cancellation. This cannot undo writes already
accepted by storage or provide an atomic multi-file rollback.

The lease serializes writers, but readers still have no atomic multi-file view: interrupted
activation can leave a partially updated set until a successful retry, and clients can retain
previous aliases until the 30-minute cache expires. Integrity files are uploaded last.
`--dry-run` makes no Azure or CDN calls; `--container tst` confines writes to the test container.
`--destination next` is also supported for an explicit activation retry.

After uploading, `cdn:publish` runs `npm run cdn:verify`, which fetches every public URL and fails
unless each returns 200 with the expected `Content-Type`, the immutable `Cache-Control` directives,
`Access-Control-Allow-Origin: *`, bytes identical to `cdn/`, and integrity files whose hashes match
the served bundles. Local integrity URLs are adapted for comparison to the selected destination.
Use `npm run cdn:verify -- --destination next` or `--destination public` to verify that destination;
omitting the option verifies the legacy channel. `--remote-only` skips the local comparison to
audit an earlier release.
Use `--major --destination public --version <full-version>` to audit promoted aliases after CDN
caches expire; it checks their short cache policy, full activated version and alias-specific hashes.

The `./snippet` helper generates the copy/paste loader. Without `src`, it loads the `min.js` IIFE
bundle for the package version from the legacy channel, so the snippet and the bundle versions
always match. Set `src` to an explicit preview/public versioned or major-alias URL to load a new
destination. A fixed `integrity` value pins the current bytes; omit it for an auto-updating alias
or update it together with the alias. It enables the
same defaults as `getInstrumentations()`, `fetch` and XHR, alongside Azure Monitor export and page
views. The loader reads the `Microsoft.OpenTelemetry` global, which a UMD bundle does not set when an AMD loader is
present. Add the generated script to the page `<head>` and replace `CHANNEL`, `VERSION`,
`YOUR_CONNECTION_STRING` and `YOUR_INTEGRITY` in the configuration object at its end:

<!-- prettier-ignore -->
```html
<script>
!(function(w,d,c){w.microsoftOpenTelemetry=new Promise(function(resolve,reject){function l(u){var s=d.createElement("script");s.src=u;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return typeof sdk.getInstrumentations==="function"?sdk.getInstrumentations(c.instrumentationOptions):[]}).then(function(i){var o=c.cfg;o.instrumentations=i;if(c.resourceAttributes)o.resource=sdk.resourceFromAttributes(c.resourceAttributes);return sdk.useMicrosoftOpenTelemetry(o)}).then(resolve,reject)};s.onerror=function(){reject(new Error("OpenTelemetry browser bundle failed to load: "+u))};d.head.appendChild(s)}l(c.src)})})(window,document,{"src":"https://js.monitor.azure.com/scripts/otel/CHANNEL/opentelemetry-browser.VERSION.min.js","crossOrigin":"anonymous","integrity":"YOUR_INTEGRITY","cfg":{"azureMonitor":{"connectionString":"YOUR_CONNECTION_STRING"}}});
</script>
```

`YOUR_INTEGRITY` is the `@min.js` `integrity` value from the release's `integrity.json`.
Initialization is asynchronous: `window.microsoftOpenTelemetry` resolves to the lifecycle handle,
or rejects when the bundle fails to load, fails its integrity check or fails to initialize. Under a
Content Security Policy, allow the snippet's hash or nonce and the CDN origin in `script-src`, and
the Azure Monitor ingestion origin in `connect-src`.

`getSdkLoaderScript()` also accepts the JSON-serializable distribution options: `samplingPercentage`,
`azureMonitor.disableBeacon`, `session`, `userContext`, and the data-only `pageView` settings
(`enabled`, `redactedQueryParams`, `softNavigationSettleTimeoutMs`, `useNavigationApiIfAvailable`).
They are inlined into the configuration object's `cfg`, which the loader passes to
`useMicrosoftOpenTelemetry` unchanged with the connection string in `cfg.azureMonitor`. Two settings
are applied by the bundle instead: `instrumentationOptions`, the `getInstrumentations()` options,
such as `{ errors: { enabled: true } }`, which default to `fetch` and XHR; and `resourceAttributes`,
string, number or boolean attributes such as `service.name` that the bundle's
`Microsoft.OpenTelemetry.resourceFromAttributes` turns into the `resource` option. Optional settings
that are not configured are omitted from the generated script. The helper throws a `TypeError` for a
value of the wrong type or one that JSON cannot represent, such as a function or regular expression.
Hooks, processors, exporters, context managers, propagators and resource detectors require the npm
package.

Three loader options mirror the Application Insights loader and add code to the generated script
only when set, so the default snippet stays small:

| Option              | Application Insights | Behavior                                                                                                                                                                                                           |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadDelay`         | `ld`                 | Milliseconds to wait before adding the bundle's script element. Negative values are rejected; the loader never blocks page load.                                                                                   |
| `cdnFallback`       | `cr`                 | When the bundle fails to load, retries it from each backup host: `js.cdn.applicationinsights.io`, `js.cdn.monitor.azure.com`, `js0.` and `js2.` variants. Requires `src` on one of them or `js.monitor.azure.com`. |
| `reportLoadFailure` | Load failure report  | After the last attempt fails, posts an `SDKLoadFailed` exception to the ingestion endpoint resolved from the connection string at generation time.                                                                 |

Unlike the Application Insights loader, fallback and failure reporting are off by default. With
`cdnFallback`, allow the backup hosts in `script-src`; with `reportLoadFailure`, the ingestion
origin must already be allowed in `connect-src`.

`npm run test:integration` loads the prepared CDN bundle cross-origin into a plain HTML page
through the built snippet, under such a policy, in Chromium, Firefox, and WebKit. It verifies that
page-view, span, `fetch` and XHR dependency telemetry reaches an Azure Monitor ingestion endpoint,
that an instrumentation enabled through `instrumentationOptions` reports telemetry tagged with the
configured `resourceAttributes`, that integrity mismatches and missing bundles reject
initialization, and that `reportLoadFailure` reports a missing bundle.

## Performance measurements

`npm run build && npm run size && npm run perf` measures the actual production
`dist/esm/index.min.js` bytes and runs the built SDK in headless Chromium using the existing
Playwright installation (`npm run test:install-browsers`). Neither this command nor normal
package usage uploads benchmark results. The workload has no network exporters: page views,
sessions, and logs are disabled, and a counting span processor verifies that every span records
and ends. Browser requests other than the harness's intercepted local modules are blocked and
fail the measurement.

This is an **ESM size-check bundle**, also included in the package, not complete application
bytes: `@opentelemetry/api` and `@opentelemetry/api-logs` remain external. The package export
resolves to `dist/esm/index.js`. Unminified entry points, source maps, and declaration files are
not added to the minified byte count.

Results use the following application-defined metric names under the
`microsoft.opentelemetry.benchmark.` prefix and the `mot-browser` suite:

| Metric suffix                                        | Test case        | Unit         | Measurement                                                  |
| ---------------------------------------------------- | ---------------- | ------------ | ------------------------------------------------------------ |
| `bundle.minified.size`                               | `bundle_esm`     | By           | Exact file bytes                                             |
| `bundle.gzip.size`                                   | `bundle_esm`     | By           | Node zlib gzip, level 9                                      |
| `bundle.brotli.size`                                 | `bundle_esm`     | By           | Node Brotli, quality 11                                      |
| `bundle.scenario.<id>.<minified\|gzip\|brotli>.size` | `bundle_<id>`    | By           | Independent scenario bytes from `reports/bundle-size.json`   |
| `sdk.init.duration`                                  | `sdk_init`       | ms           | Median awaited initialization call, after module loading     |
| `span.record.duration`                               | `recording_span` | ms           | Median time for a batch of 10,000 start/end operations       |
| `span.record.throughput`                             | `recording_span` | operations/s | Median of each batch's operations divided by elapsed seconds |

Runtime measurements use 15 samples after 5 warmup samples. Initialization excludes SDK module
loading and shutdown; each iteration shuts down and resets global providers outside the timed
region. Span measurements include the counting processor but no exporter, attributes, or
application work. They are not end-to-end ingestion throughput. The page uses cross-origin
isolation for a higher-resolution browser timer. The harness rejects nonpositive/nonfinite
timings rather than replacing them with fabricated values. No memory metrics are measured.
These workload settings and browser/host differences matter when comparing results.

Each run creates `artifacts/performance/<generated-UUID>/` (outside build-cleaned `reports/`) with:

- `raw.json`: measured package/version, source SHA and dirty flag, raw samples, completion
  timestamps, verified span counts, artifact hash, and runtime environments.
- `payload.json`: native OTLP named log events (`microsoft.opentelemetry.benchmark.result`).
- `index.min.js`: the exact measured bundle bytes, preserved for independent verification.
- `bundle.json` and `provenance.json`: byte counts, SHA-256, deterministic compression
  parameters, Node/zlib/Brotli and build-tool versions, Rollup configuration and its hash,
  lockfile hash, preparation commands, and the actual measurement invocation.
- `source.diff` and `source-files.json`: dirty source patch and changed/untracked file contents
  for local reproducibility. Review these local-only files before sharing them.

Resources identify the measured `package.name` and `package.version`, independently of the
harness (`service.name`). `benchmark.run_id` is a newly generated execution UUID;
`vcs.ref.head.revision` and `vcs.dirty` describe the checkout. Size resources
use `benchmark.environment=node-build`; runtime resources use `headless-browser` and the
actual Chromium version. No reporting OpenTelemetry SDK identity is invented for the direct
JSON serializer.

Log attributes include `test.case.name`, `test.suite.name`, `benchmark.metric`,
`benchmark.value` (finite `doubleValue`), `benchmark.unit`, and `benchmark.statistic`
(`value` for sizes, `median` for runtime). `benchmark.sample_count`,
`benchmark.operations_per_sample`, `benchmark.operation_count`, and `benchmark.warmup_count`
are OTLP `intValue` strings. Operation count excludes warmups; span duration is **per batch,
not per operation**. Timestamp strings represent measurement completion, not export time.
Every observation carries `benchmark.artifact.path`, `.format`, and `.sha256`,
`benchmark.build.config.sha256`, and `benchmark.minifier.name`/`.version`.
Size observations include `benchmark.compression.method` (`none`, `gzip`, or `brotli`);
compressed observations include `benchmark.compression.level` (9 or 11).
Scenario observations also carry `benchmark.bundle.scenario.id`, `.label`, and `.group`, plus
`benchmark.bundle.entry_point`. Their artifact is `reports/bundle-size.json` with format
`rollup-esm-scenario`; `benchmark.artifact.sha256` identifies that report and
`benchmark.build.config.sha256` identifies `scripts/measure-bundle-size.mjs`.

### Publishing measurements

For an explicitly authorized manual integration test, retain the offline run directory and use:

```sh
npm run perf:export -- --input artifacts/performance/<run-UUID> --endpoint <approved-HTTPS-OTLP-logs-URL>
```

Manual results keep their original timestamp, source revision, and dirty status.
The exporter checks the saved payload against validated raw data before sending, requires an
explicit endpoint, disables redirects, enforces bounded
request/response sizes and timeout, and never retries. Loopback HTTP is permitted only for
local transport tests. Endpoint and payload-size validation happen before creating
`export-attempt.json`, so preflight errors can be corrected without locking the saved run.
The marker is created exclusively before transmission, so
rerunning export on that directory fails rather than duplicating an ambiguous submission.
`request.json` preserves the exact transmitted bytes, whose hash and length are recorded in
`export-attempt.json`. `export-result.json` preserves the HTTP status and response, including
partial failures. A partial-success response fails explicitly;
HTTP acceptance alone does not prove downstream ingestion. Verify the actual run ID and
values in the collector's destination before claiming end-to-end success.

`npm run test:perf` tests byte measurements, native event typing and identity, invalid-data
rejection, and local-only HTTP export behavior. It is part of `npm run check`.
