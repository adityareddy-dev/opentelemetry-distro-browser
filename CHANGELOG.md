# Changelog

All notable changes to this package are documented in this file.

## Unreleased

### Added

- Add explicit `next/otel/` and `scripts/otel/` CDN destinations while preserving immutable
  full-version beta filenames and legacy routing.
- Add major-only CDN auto-update aliases for SDK and instrumentation bundles, source maps, size
  badges, and integrity metadata. Activate next aliases after successful publication; activate
  public aliases only on explicit promotion, including storage-only promotion. Use 30-minute
  alias caching and renewable storage leases to serialize each destination/container/major set,
  with bounded subprocess cancellation; multi-file reads remain non-atomic.
- Add opt-in same-realm configuration synchronization through
  `extensionConfig.AppInsightsCfgSyncPlugin`. Support explicit broadcast-only and receive-only
  modes for sampling and fetch/XHR gates, with local precedence, pause/resume/shutdown controls, and
  safe receiver error callbacks. Synchronization does not use HTTP, storage, cross-document
  delivery, retained history, or automatic publishing of local updates.
- Support instance-local runtime instrumentation add/remove/replace with explicit IDs,
  provider binding, ownership transfer, network-gate preservation and best-effort rollback.
- Add instance-local `instrumentations.get(id)` and supported pause/resume via
  `instrumentations.setEnabled(id, enabled)`, serialized with `updateCfg`. Add runtime-only
  `disableFetchTracking` and `disableAjaxTracking` collection gates that preserve manual pauses.
- Refactor startup instrumentation registration into an internal per-instance registry to prepare
  for dynamic instrumentation configuration.
- Support per-instance runtime Azure Monitor beacon fallback updates and the `onunloadDisableBeacon`
  alias through `updateCfg`.
- Add internal customer SDK Stats reporting with isolated diagnostics and lifecycle handling.
  Retain retryable customer stats counts in memory for the next report, and preserve console
  instrumentation teardown and synchronous restart inside diagnostic callbacks.
- Add opt-in best-effort customer SDK Stats to standalone Azure Monitor exporters.
- Support per-instance runtime session lifetime updates and Application Insights millisecond aliases
  `sessionRenewalMs` and `sessionExpirationMs` at initialization and through `updateCfg`.
- Add npm-only distribution SDK Stats while keeping customer reporting out of CDN bundles.
  Exclude client-side sampling and queue overflow from customer counters. Report ingestion rejections
  with their HTTP status and preserve application success values for dropped requests and dependencies.
- Support per-instance runtime sampling updates through dynamic configuration
- Add opt-in `pageView.autoTrackPageVisitTime` to report previous-page visit duration as an
  Application Insights `PageVisitTime` metric across SPA and full-page navigation.
- Validate releases end to end: `npm run test:e2e` sends telemetry from the npm and CDN builds to
  real Azure Monitor ingestion in Chromium, Firefox, and WebKit; `npm run test:build` rejects
  post-ES2022 built-ins in browser bundles; and `npm run cdn:verify`, run after `cdn:publish`, checks
  every public CDN file's headers, bytes, and integrity hashes.
- Buffer unsent Azure Monitor telemetry in `sessionStorage` and send it first, once, on the next
  page load in the same tab. Covers requests in flight at navigation, envelopes that do not fit the
  unload beacon, and retriable failures, keeping only outstanding envelopes after partial
  responses. Records are released to the next document only on `pagehide`, are isolated per
  connection string and exporter, and are bounded to 512 KiB of characters per exporter and one
  hour. Unavailable or full storage only logs a warning, and `storage.enabled: false` disables the
  buffer.
- Support a deferred connection string
- Add per-instance browser storage controls to initialization and the CDN loader: `storage.enabled:
false` blocks SDK-managed storage access, including later identity-control calls, while keeping
  sessions and authenticated identity in memory. Use `storage.namePrefix` to scope session and user
  storage keys. Disabling storage
  does not erase stored data or stop telemetry collection.
- Measure actual CDN response-body sizes with `npm run perf -- --cdn` and in merged-PR performance
  runs. Preserve existing build and browser measurements, compare encoded responses with identity bytes, and report
  missing artifacts or unsupported encodings without fabricated sizes.

### Changed

- Use the selected release version consistently for CDN verification and its success output.
- Cancel active CDN publishing and promotion commands on SIGINT/SIGTERM, awaiting subprocess
  termination and lease cleanup before exiting.
- Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+ for repository tooling to address
  CVE-2026-111497. Enforce patched minimums in CI and installs, and reject unsupported
  runtimes before CDN verification/publishing and performance network operations.
- Shrink the minified CDN bundles by minifying them with SWC, which also shortens `_`-prefixed
  private properties, and by trimming exporter code. `opentelemetry-browser.min.js` drops from
  164.64 kB to 150.70 kB minified (50.40 kB to 48.22 kB gzip).
- Run supplied `spanProcessors` and `logRecordProcessors` before the Azure Monitor exporter, as in
  the JavaScript distribution. Attributes that log record processors add in `onEmit` now reach Azure
  Monitor when `samplingPercentage` is set. Document processors as the replacement for Application
  Insights telemetry initializers and `getPlugin`.

## 0.1.0-beta.1 - 2026-10-15

### Added

- Send internal Azure Monitor network SDK stats directly to the production stats collector without
  public configuration or remote configuration requests. Keep counters isolated per exporter,
  follow accepted customer redirects, exclude requests ending at disabled EU or government-cloud
  hosts even through untrusted redirects, and suppress request referrers. Stats use bounded
  best-effort fetch delivery, including keepalive on unload.
- Document CDN loader snippet setup and failure handling in the README.
- Classify named browser log events as Azure Monitor custom events regardless of severity, while
  preserving browser console records as trace messages with their severity.
- Publish a `<module>.<version>.size.svg` size badge with each CDN release, generated at build time.
- Configure the CDN loader snippet with JSON settings: `getSdkLoaderScript()` accepts
  `samplingPercentage`, `azureMonitor.disableBeacon`, `session`, `userContext`, data-only `pageView`
  settings, `instrumentationOptions` for `getInstrumentations()`, and `resourceAttributes`. The CDN
  bundle exposes `Microsoft.OpenTelemetry.resourceFromAttributes` so the loader can build the
  resource. Existing snippets keep working; regenerated snippets pass their settings in a `cfg`
  object.
- Add Application Insights-style loader options to `getSdkLoaderScript()`: `loadDelay` (`ld`),
  `cdnFallback` to retry from backup Azure Monitor CDN hosts (`cr`), and `reportLoadFailure` to send
  an `SDKLoadFailed` exception when the bundle cannot load. Each is off by default and adds code to
  the generated snippet only when enabled.
- Add Azure Monitor operation and application context tags.

### Changed

- **Behavior change:** enable session tracking by default with a 24-hour maximum lifetime and
  the existing 30-minute inactivity timeout. Apps that previously omitted `session` now write
  session state to `localStorage` and add `session.id` to telemetry. Set `session.enabled: false`
  to opt out without accessing session storage, `session.persist: false` for memory-only sessions,
  or `session.maxDuration: 0` for unlimited lifetime. Default `userContext.enabled` to `true`. Anonymous IDs and application-supplied
  authenticated user and account IDs now persist in same-origin `localStorage` across page loads
  and SDK instances. Set `userContext.enabled: false` to keep authenticated values in memory
  and disable managed identity persistence and anonymous-ID enrichment without accessing user storage.
- Remove the npm-only browser and user-agent resource detectors from the `opentelemetry-browser` CDN
  and global bundles, saving 4.1 KiB minified (1.2 KiB gzip). The npm package is unchanged.
- **Breaking:** stop creating default OTLP span and log exporters when neither `azureMonitor` nor
  processors are configured. Telemetry is no longer exported in that case and a diagnostic warning
  is logged; pass OTLP processors through `spanProcessors` and `logRecordProcessors` instead. This
  removes the OTLP exporters from every bundle, saving about 14 KiB minified (4.2 KiB gzip) on the
  npm root entry and the CDN bundles.

- Include the browser runtime and upstream OpenTelemetry SDK version in the Azure Monitor
  `ai.internal.sdkVersion` tag.
- Persist distribution-generated anonymous user IDs by default so Application Insights user
  metrics remain stable across page loads and SDK instances. Authenticated user and account IDs
  remain memory-only unless `userContext: { enabled: true }` is configured; set `enabled: false`
  to disable managed identity persistence and user metrics.

### Fixed

- Redact URL credentials and sensitive signing and OAuth parameters on captured fetch/XHR HTTP
  dependency URLs without changing requests. Add `redactQueryParams` settings for additional
  query-string and fragment parameters on these URLs and page-view URLs/referrers, including CDN
  loader configuration. Existing page-view replacement settings remain supported. Exceptions,
  log bodies, span names/status and arbitrary attributes are not scanned.
- Preserve asynchronously detected resource attributes when initializing trace and log pipelines.
- Detect OS version from high-entropy client hints
- Map resource `service.version` to the Azure Monitor `ai.application.ver` tag.
- Only gzip Azure Monitor request bodies for recognized first-party ingestion endpoints in the
  public, US Government, and China clouds. Custom ingestion endpoints, such as proxies that parse
  request bodies as JSON, now receive uncompressed JSON.
- Set Azure Monitor browser device tags on all envelopes, omit default envelope version and
  full-sampling fields, and exclude built-in page-view diagnostics and ordinals from custom
  properties and measurements while retaining application custom fields and OpenTelemetry records.
- Include every instrumentation in the `opentelemetry-browser` CDN and global bundles, exposed as
  `Microsoft.OpenTelemetry.getInstrumentations`, and enable the default `fetch` and XHR
  instrumentations from the loader snippet. Snippet users previously received no dependency
  telemetry.
- Preserve application-provided resource `session.id` values during managed context enrichment
  and Azure Monitor export, while retaining precedence for valid record-level session IDs.
- Share fetch, XHR, console and navigation patches across instances without nesting their
  telemetry contexts. Preserve per-instance filters and hooks and restore owned methods after
  the last subscriber stops. Register shared upstream instrumentations before first enablement.
- Send queued logs during navigation without waiting for earlier export responses, including
  the first page load and fixed-percentage sampling. Flush and shutdown wait for every batch
  before reporting export failures, preserve configured export deadlines, and report both
  export and cleanup failures.
- Preserve Azure Monitor telemetry by exporting correlated span events, mapping named logs to
  custom events, enforcing Breeze field limits, exposing page-view referrers as `refUri`, and
  classifying parented internal spans as `InProc` dependencies.
- Prevent pending page views from being lost during unload by settling them before pagehide or
  hidden-visibility flushes, including tab switches.

## 0.1.0-alpha.3 - 2026-10-09

### Added

- Add session lifetime options, a persistence opt-out, and Azure Monitor session tags.
- Redact credentials and sensitive query-string and fragment parameters from page-view URLs and
  referrers by default, with a configurable parameter-name replacement list.

### Changed

- Expire sessions on telemetry activity instead of idle timers.

### Fixed

- Invoke Azure Monitor export callbacks only once when they throw, without reporting callback
  errors back to the same callback as export failures.
- Fit unload telemetry with removable custom fields within one keepalive or Beacon request.

## 0.1.0-alpha.2 - 2026-10-08

### Added

- Add shared deterministic test fixtures and informational PR coverage comparisons.
- Promote the size harness into a repository tool
- Add a configurable SDK loader snippet generator that loads the package version's bundle from
  `js.monitor.azure.com` unless `src` is provided.
- Prepare versioned CDN bundles, source maps and `integrity.json` files during `npm run build`,
  and add `npm run cdn:publish` to upload them with immutable caching.
- Map page view ID and referrer to Azure Monitor envelopes
- Add parsed JavaScript stack frames to Azure Monitor browser exception telemetry while
  preserving the original stack trace.
- Add browser user context with anonymous and authenticated identities, opt-in persistence,
  sign-out controls, OpenTelemetry enrichment, and Azure Monitor `ai.user.*` mapping.
- Add an interactive storefront sample with local span and log exporters and a built-in telemetry
  viewer.
- Add CommonJS npm entries and self-contained UMD and IIFE browser bundles; the UMD bundles also
  register with AMD loaders such as RequireJS.
- Add Azure Monitor page-view performance telemetry
- Add fixed-percentage sampling for browser telemetry
- Enforce blocking minified, gzip, and Brotli budgets for the self-contained UMD and IIFE browser
  bundles, and verify they contain only ES2022 syntax.

### Changed

- Limit Azure Monitor retry waits to a 30-second budget per send so long `Retry-After` values
  fail exports promptly instead of stalling `forceFlush()` and `shutdown()`, while preserving
  the server's throttle deadline.
- Update the development dependency `source-map-js` to 1.2.2.
- Share unload listeners across instances and release them and the owned context delegate after
  the last instance stops. Bound telemetry stops immediately at shutdown, cleanup attempts every
  processor with a 30-second timeout, and page-view shutdown cancels pending frame and idle work.
- Require HTTPS for Azure Monitor endpoints, except HTTP on localhost and loopback IP addresses.
  Invalid endpoints now emit a diagnostic warning and use the existing fallback endpoints.
- Share routing and page-context state across compatible distribution copies while preserving
  foreign OpenTelemetry globals and isolated instance pipelines.
- Cover shared and duplicate APIs using emitted bundles, with independent iframe and worker
  initialization. Defer API version compatibility to the loaded API's registration.
- Reject re-entrant context-manager and propagator conflicts, and roll back only registrations
  still owned by the failed initialization.
- Clean up processors after early diagnostic, resource, or provider startup failures, and allow
  diagnostic initialization to be retried when registration fails.
- Keep cleanup running and preserve the startup error when diagnostic reporting throws.
- Remove newly installed routers when startup fails, without replacing existing owners.
- Keep global registrations provisional through instrumentation setup and finish context
  unregistration even when manager cleanup throws.
- Ignore empty connection-string fields so trailing semicolons and surrounding whitespace do not
  discard otherwise valid exporter configuration.
- Isolate telemetry pipelines per initialization: each instance owns its tracer and logger
  providers, instrumentations bind to their own instance, and global tracers and loggers bind to
  the earliest running instance that collects that signal when acquired.
- The prerelease browser lifecycle handle now includes the required `userContext` identity and
  persistence controls.
- Spans and logs without an application or resource `enduser.pseudo.id` now receive an anonymous
  one. Managed authenticated identity is applied only when neither the record nor its resource
  supplies `user.id`, `enduser.id`, or `user.account.id`. Azure Monitor envelopes map
  `enduser.pseudo.id`, `user.id`, `enduser.id`, and `user.account.id` to `ai.user.*` tags instead
  of custom dimensions.
- Empty application `session.id` attributes are now replaced with the managed session ID.
- Default OTLP span and log batch processors are created by the distribution so `forceFlush()`
  and page-hide flushing cover them.
- Suppress tracing of Azure Monitor export requests to prevent fetch instrumentation feedback loops.
- Correlate page views, spans, and logs through shared operation IDs while preserving explicit
  application span contexts.
- Fixed post-merge performance publishing for fork contributions by using the upstream
  workflow context while retaining merged-commit-only checkout and export safeguards.
- Added offline browser performance measurements and explicit result publishing after upstream
  pull requests merge into `main`, including minified, gzip, and Brotli bundle sizes.
- Run the complete unit and emitted-bundle integration suites across Chromium, Firefox, and WebKit,
  including the ESM, UMD, AMD, and IIFE browser bundles, and publish the supported-browser matrix.
- Replaced proposal-era README content with installation, initialization, configuration,
  instrumentation, OTLP, resource detection, bundle size, and published-alpha guidance.
- Cover page view and custom event e2e integration
- Enforce exporter payload limits and test unload delivery.
- Coalesce concurrent `forceFlush()` calls across trace and log processors.
- Report bundle size changes against PR base
- Populate empty Azure Monitor message bodies with `n/a` before ingestion.
- Publish minified, gzip, and Brotli measurements for every bundle-size scenario after merged
  pull requests so scenario regressions can be tracked over time.
- Add absolute size budgets for each published entry point, reported during alpha and
  enforced starting with beta.

## 0.1.0-alpha.1 - 2026-09-28

### Added

- Initial alpha release of the Microsoft OpenTelemetry distribution for browsers.
- Browser SDK initialization for tracing and logging with configurable processors, resources,
  context management, and propagation.
- Azure Monitor span and log exporters with connection-string configuration and unload flushing.
- Browser and user-agent resource detection.
- Page-view instrumentation and default browser instrumentations.
- Browser session management.
- Runnable Azure Monitor, console, and OTLP browser sample applications.
