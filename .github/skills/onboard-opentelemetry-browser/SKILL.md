---
name: onboard-opentelemetry-browser
description: Onboard browser applications to @microsoft/opentelemetry-browser with Azure Monitor or OTLP. Use when a customer asks how to add browser telemetry, use the CDN loader snippet, install the npm package, configure automatic or manual telemetry, or validate an integration. Also use when preparing or reviewing distro release PRs that update CHANGELOG.md and the root package.json version, to check Rayfin integration and documentation updates.
---

# Onboard OpenTelemetry Browser

Help customers add `@microsoft/opentelemetry-browser` to a browser application. Lead with the
loader snippet for the shortest Azure Monitor setup. Use the npm package when the application has a
bundler or needs instrumentation, resource, session, identity, exporter, or lifecycle options that
the snippet does not expose.

Describe only behavior available in the installed or requested package version. Keep every answer
focused on active package capabilities and customer setup. For distro release PRs, use the
release-review checklist below instead of the onboarding workflow.

## Establish the setup

Collect only the details needed for the integration:

- Whether the application uses npm and a bundler.
- Whether telemetry goes to Azure Monitor or an OTLP-compatible endpoint.
- The Azure Monitor connection string or OTLP endpoint.
- Which automatic telemetry the customer needs.
- Any Content Security Policy, consent, or data-handling constraints.

Confirm the application runs in a current stable browser. Internet Explorer and browsers that
require ES5 are not supported. Initialize browser telemetry only in client-side code; an
application may import the package during a server-rendered build, but it must not initialize the
SDK on the server.

Do not request secrets for browser code. An Application Insights connection string identifies the
destination but does not grant Azure resource access. Never put API keys, bearer tokens, or other
credentials in a browser bundle; place authenticated OTLP ingestion behind a collector or gateway.

## Explain the distribution

`@microsoft/opentelemetry-browser` configures browser OpenTelemetry traces and logs. It provides:

- Azure Monitor span and log exporters.
- OTLP/HTTP defaults or customer-supplied OpenTelemetry processors and exporters.
- Built-in `browser.page_view` log collection for initial loads and route changes.
- Optional browser instrumentations loaded through a separate, tree-shakeable entry point.
- Resource detection, W3C trace propagation, sampling, session correlation, and user context.
- A lifecycle handle with `forceFlush()` and `shutdown()`.

Page views are enabled by default. Calling `getInstrumentations()` enables fetch and XHR dependency
collection by default; console, errors, navigation, navigation timing, resource timing, user action,
and web vitals are opt-in. The distribution initializes traces and logs, not metrics.

Each `useMicrosoftOpenTelemetry()` call owns its providers, processors, exporters,
instrumentations, session, identity, and lifecycle state. Browser API patches and page-operation
correlation are coordinated across instances. Application-provided context and attributes take
precedence over managed values.

## Prefer snippet onboarding

Use the snippet when the customer wants Azure Monitor telemetry with page views and default fetch
and XHR dependency collection and does not need custom initialization options.

Add exactly one loader snippet per page. Import the ESM-only snippet helper from the package version
used by the application:

```javascript
import { getSdkLoaderScript } from "@microsoft/opentelemetry-browser/snippet";

const loader = getSdkLoaderScript({
  connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
});

console.log(`<script>${loader}</script>`);
```

Place the generated `<script>` as the first script in the page `<head>`, before application code
that makes requests or emits telemetry. With no `src`, the helper selects the immutable CDN IIFE
bundle matching the installed package version. Stable versions use the `b` CDN channel;
prereleases use their identifier, such as `alpha`, `beta`, or `rc`.

For an application without npm, use the generated copy/paste block under **Snippet setup** in this
[package README](https://github.com/microsoft/opentelemetry-distro-browser#snippet-setup). Replace
`CHANNEL`, `VERSION`, `YOUR_CONNECTION_STRING`, and `YOUR_INTEGRITY` with values from one package
release. Keep the bundle version and integrity manifest version identical.

`getSdkLoaderScript()` accepts these fields:

- `connectionString` is required and must be a non-empty Azure Monitor connection string.
- `src` optionally replaces the version-matched CDN URL and must be a non-empty string.
- `crossOrigin` optionally sets the injected script's `crossorigin` value and defaults to
  `anonymous`.
- `integrity` optionally sets Subresource Integrity metadata and must be a non-empty string.

Do not substitute the ESM artifact. A custom `src` must point to a classic script that exposes
`Microsoft.OpenTelemetry.useMicrosoftOpenTelemetry` on `window`. Prefer the IIFE artifact. A UMD
artifact does not set this global when an AMD loader is present, so the snippet rejects in that
environment.

For Subresource Integrity, read the `@min.js` entry from the release's
`opentelemetry-browser.<version>.integrity.json` file and pass its `integrity` value:

```javascript
const loader = getSdkLoaderScript({
  connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
  integrity: "sha384-...",
});
```

The manifest entry also contains the exact bundle `url` and individual `sha256`, `sha384`, and
`sha512` hashes. Pass the complete `integrity` field or one correctly prefixed hash for the exact
file selected by `src`. Keep `crossOrigin` enabled when loading an integrity-protected script from
the CDN. Retrieve the manifest from the live versioned CDN URL linked by the package README; do not
reuse a hash from another version, format, local build, or copied example.

The generated loader:

1. Injects the version-matched CDN bundle with `crossorigin="anonymous"` by default.
2. Starts Azure Monitor export and page-view collection.
3. Loads the bundle's default fetch and XHR instrumentations.
4. Assigns initialization to `window.microsoftOpenTelemetry`.

Handle initialization failures explicitly:

```javascript
window.microsoftOpenTelemetry
  .then(function (telemetry) {
    // Keep the handle when the application needs explicit flush or shutdown controls.
    window.telemetry = telemetry;
  })
  .catch(function (error) {
    console.error("Browser telemetry initialization failed", error);
  });
```

The promise rejects when the script cannot load, fails its integrity check, does not expose the
expected global, cannot construct the default instrumentations, or cannot initialize. A failed SRI
check is reported through the same script-load error as a network failure. Under a Content Security
Policy, allow the exact generated inline snippet by hash or nonce, the CDN origin in `script-src`,
and the Azure Monitor ingestion origin in `connect-src`.

After initialization resolves, the browser bundle also exposes standard OpenTelemetry APIs under
`window.Microsoft.OpenTelemetry`. Use them for manual telemetry without adding another SDK:

```javascript
window.microsoftOpenTelemetry.then(function () {
  var otel = window.Microsoft.OpenTelemetry;
  var span = otel.trace.getTracer("shop-web").startSpan("checkout");
  span.setAttribute("cart.item_count", 3);
  span.end();

  otel.logs.getLogger("shop-web").emit({
    eventName: "shop.checkout_started",
    attributes: { "cart.item_count": 3 },
  });
});
```

Use the lifecycle handle resolved by `window.microsoftOpenTelemetry` for `forceFlush()`,
`shutdown()`, and user context. Do not read the global APIs or handle before the promise resolves.

Use the npm setup instead of altering the generated loader when the customer needs additional
instrumentations, resource attributes, sessions, identity controls, sampling, custom exporters,
page-view configuration, or consent-driven initialization.

## Configure an npm application

Install the distribution, its OpenTelemetry API peer dependency, and the packages imported by the
examples below. Keep OpenTelemetry package versions aligned with the selected distro version; for
the currently published package:

```bash
npm install @microsoft/opentelemetry-browser@0.1.0-beta.1 @opentelemetry/api@1.9.1 @opentelemetry/api-logs@0.222.0 @opentelemetry/resources@2.11.0
```

Initialize telemetry before importing application code that needs instrumentation:

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import { resourceFromAttributes } from "@opentelemetry/resources";

const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
  },
  resource: resourceFromAttributes({
    "service.name": "shop-web",
    "service.version": "1.0.0",
  }),
  session: { enabled: true },
  instrumentations: await getInstrumentations({
    errors: { enabled: true },
    userAction: { enabled: true },
    webVitals: { enabled: true },
  }),
});

await import("./app.js");
```

Keep `getInstrumentations` on the `/instrumentations` entry point. Its dynamic imports preserve
code splitting and avoid adding unselected instrumentations to the main entry point. Set
`fetch: { enabled: false }` or `xhr: { enabled: false }` to disable either default.

Use standard OpenTelemetry APIs for manual telemetry:

```typescript
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const span = trace.getTracer("shop-web").startSpan("checkout");
span.setAttribute("cart.item_count", 3);
span.end();

logs.getLogger("shop-web").emit({
  eventName: "shop.checkout_started",
  attributes: { "cart.item_count": 3 },
});
```

Use spans for operations with duration or trace correlation. Use log records with a top-level
`eventName` for occurrences. Keep attribute values low-cardinality where practical and exclude
credentials, tokens, full request bodies, and unnecessary personal data.

## Handle lifecycle and identity

Telemetry batches flush automatically during supported page lifecycle events. Use the returned
handle for explicit boundaries:

```typescript
await telemetry.forceFlush();
await telemetry.shutdown();
```

Use `telemetry.userContext.setAuthenticatedUserContext(userId, accountId)` only with identifiers
approved for telemetry. Do not use raw personal information, secrets, or tokens. Authenticated
identity remains in memory unless identity persistence is enabled. Call
`clearAuthenticatedUserContext()` during sign-out.

## Validate the integration

Verify the smallest observable path after making changes:

1. Confirm `window.microsoftOpenTelemetry` resolves for snippet setup, or await
   `useMicrosoftOpenTelemetry()` for npm setup.
2. Reload the page and perform one fetch or XHR request.
3. Check the browser console for initialization, CSP, CORS, integrity, or export errors.
4. Check the Network panel for the SDK bundle and telemetry ingestion requests.
5. Confirm a page view and dependency telemetry arrive at the configured destination.
6. For manual telemetry, emit one named span or event and verify its attributes.

Do not claim success from a loaded script alone. Successful onboarding requires initialization and
an observed telemetry item at the destination. Report CSP, ad blocker, browser privacy control,
network, ingestion, and configuration failures separately.

## Review distro release PRs

1. Compare the PR head with its base. Treat a change to the root `package.json` top-level `version`
   together with a new or promoted versioned release heading in `CHANGELOG.md` as a distro release,
   including prereleases. Confirm both identify the same target version. Dependency-only version
   changes and edits limited to `Unreleased` are not release signals on their own. If an explicitly
   identified release PR has missing or mismatched release metadata, flag that separately and still
   perform the Rayfin check.
2. Check the PR description, checklist, comments, and linked evidence for confirmation that Rayfin
   integration and Rayfin documentation were updated for the target distro version. Do not assume a
   distro version bump proves either update, or invent Rayfin repository or documentation URLs.
3. Include this release-process checklist in the proposed PR description or review summary, replacing
   `<version>` with the target distro version:

   - [ ] Has the Rayfin integration been updated and validated with distro `<version>`? Link the
         integration PR or validation evidence, or explain why no change is needed.
   - [ ] Has the Rayfin documentation been updated for distro `<version>`? Link the documentation
         update, or explain why no change is needed.

4. Do not duplicate an existing Rayfin reminder or checklist for the same release. Mark an item
   complete only when linked evidence or an explicit no-change-needed rationale covers it; leave
   unconfirmed items unchecked. Treat missing confirmation as a release-process follow-up, not a
   proven code defect. Post a PR comment or edit its description only when authorized; otherwise
   provide the suggested checklist text without changing the PR.

## Use authoritative references

- [Package and onboarding README](https://www.npmjs.com/package/@microsoft/opentelemetry-browser)
- [Copy/paste snippet](https://github.com/microsoft/opentelemetry-distro-browser#snippet-setup)
- [CDN, integrity, CSP, and loader details](https://github.com/microsoft/opentelemetry-distro-browser/blob/main/docs/packaging.md#cdn-and-loader-snippet)
- [Find and configure an Application Insights connection string](https://learn.microsoft.com/azure/azure-monitor/app/connection-strings)
- [Repository privacy guidance](https://github.com/microsoft/opentelemetry-distro-browser/blob/main/PRIVACY.md)
- [Runnable Azure Monitor sample](https://github.com/microsoft/opentelemetry-distro-browser/tree/main/samples/azure-monitor)

## Keep guidance accurate

- Prefer the installed package declarations and public entry points over copied examples.
- Do not import internal `src/` modules or rely on unexported globals.
- Do not initialize telemetry merely by importing the package.
- Do not use the Application Insights JavaScript SDK's `appInsights` API; this distribution uses
  standard OpenTelemetry APIs and returns its own lifecycle handle.
- Keep snippet guidance limited to Azure Monitor, page views, and default fetch/XHR collection.
- Use the npm API for all other configuration.
