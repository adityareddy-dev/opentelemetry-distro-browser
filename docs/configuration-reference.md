# Beta configuration reference

This reference describes `@microsoft/opentelemetry-browser` **0.1.0-beta.1**. Start with the
[getting-started guide](../README.md#getting-started), and consult the
[event catalogue](event-catalogue.md) for emitted data. The public TypeScript contracts are in
[distribution types](../src/types.ts), [page-view options](../src/instrumentation/pageView/types.ts)
and [loader options](../src/snippet.ts).

## Initialization options

Pass these options to `await useMicrosoftOpenTelemetry(options)`. Options are captured at startup;
the [runtime update API](#runtime-configuration-updates) can change sampling, session lifetimes,
Azure Monitor beacon fallback policy and registered fetch/XHR collection gates. The handle also
supports [pause/resume for supported instrumentations](#runtime-instrumentation-controls). Other
options remain startup-only. Importing the package has no initialization side effects. Initialize
only in client-side code, before importing application code to instrument.

| Option                | Type                                          | Default and behavior                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor`        | `AzureMonitorOptions`                         | Omitted: no default Azure Monitor exporters. See [destination](#azure-monitor-destination).                                                                                                                               |
| `resource`            | OpenTelemetry `Resource`                      | SDK defaults. Supplied attributes merge over defaults; use `service.name` and `service.version` to identify the application. Attributes resolve once; the resource schema URL is not carried through.                     |
| `samplingPercentage`  | `number`                                      | Omitted: parent-based always-on trace sampling and no percentage sampling of Azure Monitor logs. See [sampling](#sampling).                                                                                               |
| `session`             | `MicrosoftOpenTelemetryBrowserSessionOptions` | Enabled and persisted, with 30-minute inactivity expiry and 24-hour maximum lifetime.                                                                                                                                     |
| `sessionRenewalMs`    | `number`, milliseconds                        | Application Insights alias for `session.inactivityTimeout`. Default: `1800000` (30 minutes); `0` restores this default. See [session options](#session-options).                                                          |
| `sessionExpirationMs` | `number`, milliseconds                        | Application Insights alias for `session.maxDuration`. Default: `86400000` (24 hours); `0` restores this default. See [session options](#session-options).                                                                 |
| `storage`             | `{ enabled?: boolean; namePrefix?: string }`  | Enabled, with unprefixed keys. See [browser storage](#browser-storage).                                                                                                                                                   |
| `userContext`         | `{ enabled?: boolean }`                       | Enabled: managed anonymous identity and authenticated identity set through the handle persist in same-origin storage.                                                                                                     |
| `traces`              | `MicrosoftOpenTelemetryBrowserTraceOptions`   | Synchronous context tracking, W3C Trace Context and Baggage propagation.                                                                                                                                                  |
| `spanProcessors`      | `SpanProcessor[]`                             | Additional trace processors. They run before the Azure Monitor default when configured, unless `[]` disables traces. Without Azure Monitor, only supplied processors export. See [enrichment](#enrichment-and-filtering). |
| `logRecordProcessors` | `LogRecordProcessor[]`                        | Additional log processors. They run before the Azure Monitor default when configured, unless `[]` disables logs. Without Azure Monitor, only supplied processors export. See [enrichment](#enrichment-and-filtering).     |
| `instrumentations`    | `readonly BrowserInstrumentation[]`           | Empty. Pass instances returned by `getInstrumentations()` or compatible upstream instances. Built-in page views are configured separately.                                                                                |
| `pageView`            | `PageViewInstrumentationConfig`               | Collection and page-operation correlation enabled. Requires a log pipeline to export page-view records.                                                                                                                   |

### Azure Monitor destination

| Option                           | Type                                  | Default and behavior                                                                                                                                                                |
| -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azureMonitor.connectionString`  | `string \| Promise<string>`, required | Application Insights connection string with a valid UUID `InstrumentationKey`. Supports explicit ingestion endpoints and cloud suffixes.                                            |
| `azureMonitor.initTimeOut`       | `number`                              | `50000` ms. Maximum promise wait. Must be finite, nonnegative, and at most `2147483647`. Zero expires immediately.                                                                  |
| `azureMonitor.initInMemoMaxSize` | `number`                              | `100` items. Maximum completed spans and emitted logs buffered together while waiting. Must be a nonnegative safe integer. Zero disables startup buffering.                         |
| `azureMonitor.disableBeacon`     | `boolean`                             | `false`. Set to `true` to disable only the unload `sendBeacon` fallback. Keepalive fetch remains first; regular fetch is unaffected. This may reduce delivery when the page closes. |

At initialization, configure beacon fallback through `azureMonitor.disableBeacon`. The root
`onunloadDisableBeacon` alias is supported only through `updateCfg`, not as an initialization or
loader option. Both runtime spellings accept booleans or explicit `undefined`, restoring `false`;
the startup native option remains an optional `boolean` for strict TypeScript consumers. Values
are not coerced to booleans. Supplying both native and alias values in one runtime update is accepted
only when their normalized values match. An explicitly supplied own `undefined` normalizes to
`false` for this comparison. Conflicts reject the whole runtime update without partial changes.

Endpoints require HTTPS except for localhost or loopback IPs. Invalid endpoints warn and fall back
to suffix-derived or public-cloud endpoints; an invalid/missing instrumentation key in a synchronous
string fails startup.
Connection strings identify a destination and do not grant read access to the resource. They are
public browser configuration, not secrets. Built-in Entra ID token authentication is not supported.

Unsent Azure Monitor telemetry is buffered in `sessionStorage` and sent first by the next page load
in the same tab. The buffer covers telemetry that is in flight when the page goes away, does not
fit the unload beacon, or fails with a retriable error; after a partial response only the
outstanding retriable envelopes stay buffered. Records are keyed by connection string and
exporter, kept until ingestion accepts or permanently rejects them or the browser takes an unload
request, and adopted only once after the page that wrote them fires `pagehide`, so hidden but
live pages and same-origin frames never send each other's telemetry. Each exporter keeps at most
512 KiB of characters and drops items older than one hour; unavailable or full storage only logs
a diagnostic warning. `storage.enabled: false` disables the buffer and `storage.namePrefix`
prefixes its keys. Requests interrupted after ingestion received them can be sent again. Custom
span and log processors are not buffered, and the buffer does not survive closing the tab.

#### Asynchronous connection strings

Pass a `Promise<string>` when the destination is loaded asynchronously:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString: fetch("/telemetry-config").then((response) => {
      if (!response.ok) throw new Error("Telemetry configuration unavailable");
      return response.text();
    }),
    initTimeOut: 50000,
    initInMemoMaxSize: 100,
  },
});
```

Awaiting `useMicrosoftOpenTelemetry()` means collection is ready; it does not wait for the
connection string. Only the Azure Monitor branches buffer while the destination is pending.
Custom processors continue receiving telemetry immediately. The queue belongs to the handle and
counts items, not bytes, across both signals before normal batching. It is not persisted.
Overflow drops new items and emits one diagnostic. A valid resolution releases retained items
in arrival order into the normal batch processors; normal batching and sampling still apply.

Timeout, rejection, or an invalid resolved string clears the queue, emits a diagnostic without
including the connection string or rejection reason, and stops Azure Monitor delivery for that
handle. Late resolution is ignored. Other handles and custom destinations are unaffected.
The two initialization limits apply only when the connection string is asynchronous.

While pending, `forceFlush()` and page-hide flushes do not wait for the promise and do not discard
the startup queue. They cannot send its contents until the destination is known. Call `forceFlush()`
again after resolution if immediate delivery is needed. Shutdown cancels pending startup and
discards buffered items; it does not wait for the connection-string promise.

Standalone `AzureMonitorSpanExporter` and `AzureMonitorLogRecordExporter` still require an
already-resolved string. Startup buffering is owned by the distribution, not the exporters.

When Azure Monitor is configured, its processor is added before non-empty custom processor lists
for each signal. They are independent processor branches, not a chain: filtering within the Azure
Monitor processor does not filter records received by custom processors. An explicit empty array
disables the entire signal, including Azure Monitor. Without Azure Monitor or custom processors,
no telemetry exports. See the [OTLP example](../README.md#otlp-and-custom-exporters)
and [OTLP sample](../samples/README.md#otlp-configuration); allow the browser origin through CORS and
never embed secrets in exporter headers.

Each handle owns its processors and instrumentations. Do not reuse those objects across handles.
Processor ownership transfers when provider startup begins, including failed startup. Construct
upstream fetch, XHR, console and navigation instances with `enabled: false`; the distribution binds
providers before enabling them. The helper already does this.

### Sampling

`samplingPercentage` must be finite and between `0` and `100`, inclusive. `0` drops sampled traces
and default Azure Monitor logs; `100` retains all eligible records. Omission preserves parent-based
trace decisions for explicit application parents. The default sampler treats the synthetic page
operation as a root for sampling, so another instance's page sampling decision does not control it.
With an explicit percentage, the decision is based on the trace ID, not the parent's sampled flag.

Explicit percentage sampling is deterministic by trace ID for spans and correlated Azure Monitor
logs. Uncorrelated Azure Monitor logs use random percentage sampling. Azure Monitor exports the
effective sample rate for retained records. Built-in page-view logs carry the page operation's
trace ID and are filtered by that ID in the default Azure Monitor percentage-sampling processor.

Custom trace processors receive the distribution's sampled spans. Custom log processors do **not**
automatically inherit Azure Monitor's log percentage filtering; supply any required log filtering
yourself. This includes built-in page-view logs: their operation's sampled flag does not itself
prevent emission to custom log processors. There is no `traces.sampler` option.

### Runtime configuration updates

The returned handle exposes `updateCfg(patch, mergeExisting = true)`, accepting
`MicrosoftOpenTelemetryBrowserConfigurationUpdate` and returning
`Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult>`. Supported paths are
`samplingPercentage`, `session.inactivityTimeout`, `session.maxDuration` and
`azureMonitor.disableBeacon`, plus the exact root aliases `sessionRenewalMs`, `sessionExpirationMs`
and `onunloadDisableBeacon`, followed by the root collection gates `disableFetchTracking` and
`disableAjaxTracking`. Only the session aliases also work at npm initialization; see
[session options](#session-options) and [destination](#azure-monitor-destination) for defaults and
conflict handling. The runtime Azure Monitor patch is limited to
`azureMonitor?: { disableBeacon?: boolean | undefined } | undefined`.

- Merge mode (the default) preserves omitted fields, including nested session and Azure Monitor
  fields. `{ session: {} }` and `{ azureMonitor: {} }` are no-ops.
- Explicit `samplingPercentage: undefined` restores parent-based trace sampling and removes Azure
  Monitor log percentage filtering, not the startup percentage or numeric `100`.
- An explicit `undefined` native lifetime or alias resets that lifetime to its native default:
  30 minutes for inactivity, 24 hours for maximum duration. `session: undefined` resets both
  lifetimes without changing sampling.
- Explicit `azureMonitor.disableBeacon: undefined`, `azureMonitor: undefined` or
  `onunloadDisableBeacon: undefined` resets beacon policy to `false`, not to the startup value.
  These resets participate in native/alias conflict checks; they do not disable the destination.
- `disableFetchTracking` and `disableAjaxTracking` accept only booleans or explicit `undefined`.
  Both default to `false`; explicit `undefined` resets the corresponding gate to `false`.
  They are runtime-only root options, not initialization or CDN loader flags.
- Passing `false` as the second argument replaces **only the supported runtime subset**. All
  omitted sampling, lifetime, beacon and collection-gate fields reset to their defaults, including
  omitted nested fields; destinations and other startup-only options are unchanged.

The frozen result contains readonly `revision` and `changedPaths`. A commit changing any supported
value increments the per-instance revision once. Changed paths use canonical names in this order:
`samplingPercentage`, `session.inactivityTimeout`, `session.maxDuration`, `azureMonitor.disableBeacon`,
`disableFetchTracking`, `disableAjaxTracking`, even when aliases are used. No-op updates retain the
revision and return `[]` for `changedPaths`.

Sampling changes affect subsequent span starts, default Azure Monitor log emissions and new page
operations. Existing span/page decisions and queued logs are not resampled. A later correlated log
can use a newer policy than its span; custom log processors still need their own filtering.

Session policy changes do not immediately rotate the ID, send telemetry or network requests,
access or reset storage, replace providers, or refresh the session's start or last-activity timestamp.
The next span start or log emission needing a managed session ID checks the new policy against
those timestamps. Shortening a lifetime rotates the ID on that next managed activity if expiry is
already due; extending or disabling a check can keep the current ID. Persisted session expiry is
checked against the configured startup lifetime policy during restore. Application-supplied
record/resource session attributes still take precedence.

Azure Monitor senders read the committed per-instance beacon policy at each fallback attempt,
including for already queued telemetry and when a keepalive request pending during an update
later fails. Updates do not cancel or switch an already dispatched request. Keepalive fetch stays
first, regular fetch is unaffected, and shared keepalive capacity, payload limits, retries and SDK
stats behavior are unchanged. A policy update sends no network request, recreates no destination
or provider, and cannot create an Azure Monitor destination if none was configured. Custom
exporters and standalone exporter options are unaffected.

Setting `disableFetchTracking: true` or `disableAjaxTracking: true` pauses collection for **all**
registered matching fetch or XHR entries in this instance, including repeated entries. Setting a
gate to `false` permits collection only for entries whose requested enabled state is still `true`;
it does not undo a manual `instrumentations.setEnabled(id, false)` pause. These gates do not import,
construct or register missing modules, enable a disabled trace pipeline, or change another
instance's collection. They do not cancel requests or undo injected headers. Already-sent fetch/XHR
requests can still finish; an XHR opened before a pause must be opened again after resume before
its send can be collected. See [runtime instrumentation controls](#runtime-instrumentation-controls).

Providers and acquired tracers/loggers remain bound to the same instance. Updates serialize per
instance with `instrumentations.setEnabled()`, and configuration input is validated and captured
before queueing. Invalid values, accessors, non-plain objects, unsupported paths and conflicting
native/alias values reject without changing configuration or revision. Gate transitions apply
before the new configuration and revision are published. Lifecycle failures reject the operation
and attempt best-effort rollback; if cleanup or rollback leaves instrumentation state uncertain,
further runtime mutations reject until shutdown. This is not universal atomicity for browser events
or in-flight work: observed events and injected headers cannot be undone. Queued and new mutations
reject once shutdown starts.

```typescript
const result = await telemetry.updateCfg({ sessionRenewalMs: 60000 });
// If changed, result.changedPaths is ["session.inactivityTimeout"].
await telemetry.updateCfg({ session: { maxDuration: 0 } }); // Keep inactivity; disable maximum expiry.
await telemetry.updateCfg({ sessionRenewalMs: undefined }); // Reset inactivity to 30 minutes.
await telemetry.updateCfg({ session: undefined }); // Reset both lifetimes; keep sampling.
await telemetry.updateCfg({ azureMonitor: { disableBeacon: true } }); // Disable only beacon fallback.
await telemetry.updateCfg({ onunloadDisableBeacon: false }); // Re-enable fallback.
await telemetry.updateCfg({ azureMonitor: { disableBeacon: undefined } }); // Reset beacon to false.
await telemetry.updateCfg({ azureMonitor: undefined }); // Reset beacon, not the destination.
await telemetry.updateCfg({ disableFetchTracking: true, disableAjaxTracking: true });
await telemetry.updateCfg({ disableFetchTracking: undefined }); // Reset only the fetch gate to false.
await telemetry.updateCfg({}, false); // Reset runtime policies, including both gates; keep destinations.
```

`session.enabled`, `session.persist` and browser storage flags are not runtime-updateable. Lifetime
updates cannot enable a disabled session or change persistence; `storage.enabled` and
`storage.namePrefix` remain unchanged. Only sampling, session lifetimes and Azure Monitor beacon
fallback policy, plus the two fetch/XHR collection gates, are supported by `updateCfg`.
Instrumentation pause/resume and supported add/remove/replace operations use the separate handle
controls below. The runtime `azureMonitor` subset does not accept `connectionString`, `initTimeOut`
or `initInMemoMaxSize`, and cannot replace or disable a destination. There is no root
`connectionString` alias.

### Optional configuration synchronization

`extensionConfig.AppInsightsCfgSyncPlugin` is a startup-only option for synchronizing a narrow
runtime subset between SDK instances in the **same JavaScript realm**. It is not accepted by the CDN loader. It
uses `CustomEvent` on `globalThis`, not HTTP, storage, network requests, tabs, iframes or workers;
those contexts have independent realm state.

| Option                | Default and behavior                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin options object | Omitted: synchronization is not configured. When configured, the handle exposes `configSync` with `sync(): Promise<void>`, `pause()`, `resume()`, and `shutdown()`.                                               |
| `syncMode`            | `2` (receive only). `0` is inert, `1` broadcasts only, and `2` receives only.                                                                                                                                     |
| `customEvtName`       | `"ai_cfgsync"`. This event name is the channel; use a different name to isolate participants.                                                                                                                     |
| `nonOverrideConfigs`  | Optional map for `samplingPercentage`, `disableFetchTracking`, and `disableAjaxTracking`. `true` excludes a field from publishing and receiving; `false` cannot widen the allowlist. Unknown keys reject startup. |
| `onError`             | Optional `(error: unknown) => void` callback. Thrown errors and rejected returns are isolated.                                                                                                                    |

Synchronization starts only after an explicit `AppInsightsCfgSyncPlugin` object is supplied, including `{}`.
Startup configuration establishes local precedence: an actual startup sampling value, including an
own `undefined` or inherited numeric value, protects sampling from received updates. A successful
local `updateCfg` permanently protects each field it supplies, including no-op updates and explicit
resets; `updateCfg(patch, false)` protects all three synchronizable fields. Failed local updates
do not create a protection. There is no API to release a protection.

Only `samplingPercentage` (a finite value from `0` through `100` or explicit `undefined`),
`disableFetchTracking`, and `disableAjaxTracking` may cross the channel. The latter two accept only
booleans in events. The SDK rejects unknown fields and session, beacon,
identity, destination, instrumentation, state, and HTTP-related settings. It validates the whole
received payload before applying locks or allow-list filtering. This intentionally strict subset is
not compatible with a full Application Insights configuration object or full plugin configuration.

An explicit local `updateCfg` remains local: it does not automatically publish, echo a received
update, replay a value on startup, or retain history. A broadcaster publishes a snapshot of every
allowed, non-excluded field, including an own `undefined` sampling reset, through:

```typescript
globalThis.dispatchEvent(new CustomEvent(channel, { detail: { cfg: patch } }));
```

For example, configure separate publisher and receiver instances on the same page:

```typescript
const publisher = await useMicrosoftOpenTelemetry({
  extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 1, customEvtName: "checkout-config" } },
});
const receiver = await useMicrosoftOpenTelemetry({
  extensionConfig: { AppInsightsCfgSyncPlugin: { customEvtName: "checkout-config" } },
});

await publisher.updateCfg({ samplingPercentage: 25 }); // Local only.
await publisher.configSync!.sync(); // Dispatch completion, not receiver acknowledgement.
await receiver.updateCfg({}); // Barrier for previously queued delivery on this receiver.
```

Receivers merge queued messages through the same `updateCfg` and instrumentation-mutation queue,
but each handle has an independent revision; there is no atomic cross-handle commit. `sync()`
resolves when dispatch is complete, not when recipients acknowledge or apply it. Receiver failures
call `onError`, do not roll back the publisher, and do not log payload contents.

`pause()` cancels queued broadcasts and delivery for its current generation without reverting
already applied values. `resume()` enables future messages only; it does not replay a snapshot.
`shutdown()` is terminal and removes the event listener. Initialization stages the listener and
removes it if startup fails before commit; telemetry shutdown also removes it.
If removal throws, shutdown attempts one bounded retry and still reports the original error.

The channel is not authentication or confidentiality protection. Any script in the same realm can
observe or forge these events, so do not synchronize secrets.

## Session and identity

### Browser storage

| Option               | Type      | Default | Behavior                                                                                                                                                                                                                                                 |
| -------------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.enabled`    | `boolean` | `true`  | `false` blocks all SDK-managed browser storage access for this handle, including later identity-control calls, the unsent telemetry buffer and page-visit persistence. Sessions and SPA visit timing use memory; managed anonymous identity is disabled. |
| `storage.namePrefix` | `string`  | `""`    | Literal prefix for `opentelemetry-session`, `opentelemetry-user`, unsent telemetry buffer and page-visit state keys. For example, `"shop-"` produces `shop-opentelemetry-session` and `shop-opentelemetry-user`.                                         |

Settings are captured at initialization and apply independently to each handle. A prefix isolates
stored sessions and identities for applications on the same origin; it is not a security boundary.
No data is migrated or removed from other prefixes. The default empty prefix preserves existing data.

Like Application Insights JavaScript, browser persistence is enabled by default. Unlike its
`isStorageUseDisabled` global helper, `storage.enabled` is instance-scoped so one application cannot
change another handle's policy. Setting it to `false` takes precedence over `session.persist` and
`userContext.enabled`; `userContext.setEnabled()` then has no effect. Authenticated identity can
still be set and cleared in memory. Disabling storage does not erase existing data, disable telemetry
collection or stop network requests. Custom processors/exporters must enforce their own storage policy.

Sessions and identities use localStorage; unsent Azure Monitor telemetry and opt-in page-visit state
use sessionStorage. No cookies are created. Application Insights `cookieCfg` and cookie domain/path settings are separate
cookie controls, not Web Storage settings. Its `enableSessionStorageBuffer` corresponds to the
unsent telemetry buffer described under Azure Monitor, which is always on here unless
`storage.enabled` is false.

Implementation references: Application Insights JavaScript's
[cookie manager](https://github.com/microsoft/ApplicationInsights-JS/blob/main/shared/AppInsightsCore/src/core/CookieMgr.ts),
[Web Storage helpers](https://github.com/microsoft/ApplicationInsights-JS/blob/main/shared/AppInsightsCore/src/utils/StorageHelperFuncs.ts)
and [send buffer](https://github.com/microsoft/ApplicationInsights-JS/blob/main/channels/applicationinsights-channel-js/src/SendBuffer.ts).

### Session options

| Option                      | Type              | Default | Behavior                                                                              |
| --------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `session.enabled`           | `boolean`         | `true`  | `false` disables managed sessions without accessing session storage.                  |
| `session.persist`           | `boolean`         | `true`  | `false` uses memory only, without reading or clearing stored sessions.                |
| `session.inactivityTimeout` | `number`, seconds | `1800`  | Time without managed-session telemetry before expiry. `0` disables inactivity expiry. |
| `session.maxDuration`       | `number`, seconds | `86400` | Maximum lifetime, including reloads. `0` means unlimited.                             |

Lifetimes must be finite and nonnegative. At initialization and in `updateCfg`, the root Application
Insights aliases `sessionRenewalMs` and `sessionExpirationMs` accept **milliseconds**, normalized to
`session.inactivityTimeout` and `session.maxDuration` in **seconds**. Native `0` disables the
corresponding expiry check; alias `0` or explicit `undefined` restores the corresponding default
(30 minutes or 24 hours), rather than disabling expiry.

Supplying a native lifetime and its alias in the same call is accepted only when their normalized
values are equal. For example, `session: { inactivityTimeout: 60 }` with `sessionRenewalMs: 60000`
is valid; `session: { inactivityTimeout: 0 }` with `sessionRenewalMs: 0` conflicts. A conflict fails
initialization or rejects the whole runtime update without partial changes. Separate updates may
replace a lifetime through either spelling.

Managed `session.id` fills only an absent value: a non-empty string supplied on the record or
resource takes precedence. Azure Monitor prefers a
valid record-level ID over the resource ID. Inaccessible session storage falls back to memory.

### User identity options and controls

`userContext.enabled` defaults to `true`. Managed `enduser.pseudo.id` persists across page loads;
authenticated user and account IDs set through the returned handle also persist by default.
Explicit record/resource identity takes precedence over managed defaults. Spans are enriched when
they start and logs when emitted; later identity changes are not retroactive.

| Handle method                                                 | Behavior                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userContext.setAuthenticatedUserContext(userId, accountId?)` | Sets `user.id` and optional `user.account.id`. Omitting the account clears the previous account. IDs must be non-empty strings.                              |
| `userContext.clearAuthenticatedUserContext()`                 | Clears this handle's authenticated identity and stored authentication. Anonymous identity may remain.                                                        |
| `userContext.setEnabled(enabled)`                             | Changes identity persistence and anonymous-ID enrichment, without clearing current in-memory authenticated identity. Disabling also removes stored identity. |

Storage is shared within the origin and configured prefix, but each active handle keeps its own state. Update every
active handle on sign-out. Scripts in the origin can read stored identity; do not use raw personal
information, tokens or secrets as IDs. Persistence writes/removals can throw: handle failures when
setting identity, changing persistence or signing out. These controls remain usable after shutdown.

For no managed session or identity storage access at initialization:

```typescript
const telemetry = await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  storage: { enabled: false },
});
```

This retains memory-only session correlation. To disable managed sessions too, add
`session: { enabled: false }`. For only memory-only sessions while preserving user persistence,
use `session: { persist: false }`. If consent must precede any
collection or network activity, defer initialization itself until consent is granted. Disabling
storage at startup does not erase previously stored values; identity removal is an explicit
`userContext.setEnabled(false)` operation while browser storage is allowed. To grant persistence
after starting with `storage.enabled: false`, shut down that handle and initialize a new one with
storage enabled. The SDK does not replay storage operations from the disabled period.

## Page-view options

| Option                                   | Type                             | Default and behavior                                                                                                                                               |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pageView.enabled`                       | `boolean`                        | `true`. `false` disables both built-in collection and its operation-correlation fallback; it does not remove code from bundles.                                    |
| `pageView.autoTrackPageVisitTime`        | `boolean`                        | `false`. Emit a separate `browser.page_visit` log for the previous page when the next page view starts. Requires built-in page views and a log pipeline to export. |
| `pageView.routeResolver`                 | `() => string \| undefined`      | Unset. Return a route pattern such as `/orders/:id`, not a concrete customer URL. Called when navigation is observed and again at settlement.                      |
| `pageView.redactedQueryParams`           | `readonly string[]`              | Built-in list below. A supplied list **replaces**, not extends, that list. Names are case-sensitive.                                                               |
| `pageView.sanitizeUrl`                   | `(url: string) => string`        | Unset. Sanitizes the page URL and referrer after built-in redaction.                                                                                               |
| `pageView.applyCustomLogRecordData`      | `(logRecord: LogRecord) => void` | Unset. Mutates the page-view log immediately before emission.                                                                                                      |
| `pageView.softNavigationSettleTimeoutMs` | `number`, milliseconds           | `10000`. Upper bound for settling soft navigations before emitting a capped duration.                                                                              |
| `pageView.useNavigationApiIfAvailable`   | `boolean`                        | `false`. Prefer the experimental Navigation API when present, otherwise use History-based observation.                                                             |

Default sensitive parameter names are `sig`, `Signature`, `AWSAccessKeyId`, `X-Goog-Signature`,
`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `code`, `token`, `access_token`,
`id_token`, `refresh_token`, `client_secret` and `password`. Matching query and fragment parameter
values become `REDACTED`. URL username/password credentials are always redacted.

To extend protection without replacing the defaults, leave `redactedQueryParams` unset and add
application-specific redaction in `sanitizeUrl`. Page-view redaction does not automatically sanitize
fetch/XHR, navigation, timing or exception URLs. Configure each instrumentation appropriately and
review the payload before enabling it.

The default name falls back from the route resolver to `document.title`, then `location.pathname`.
Use route patterns for aggregation. Soft-navigation duration is a heuristic, not a document-load
measurement. Pending page views are finalized when hidden, including tab switches; returning to a
visible tab does not itself start another page view. See [duration sources](event-catalogue.md#page-view-duration-sources).

### Page visit time

Enable `pageView.autoTrackPageVisitTime` to measure elapsed milliseconds from the previous page-view
start to the next page-view start. This includes hidden time, not just active engagement, and is
separate from the page-view load/settle duration. The option defaults to `false`, so existing
applications emit no extra telemetry. The portable `browser.page_visit` log carries the previous
page's name, sanitized URL, page-view ID and elapsed duration; Azure Monitor maps it to the separate
`PageVisitTime` custom metric. See the [event schema](event-catalogue.md#page-visit-browserpage_visit).

SPA transitions use in-memory state. Full navigations on the same origin in the same tab use
`sessionStorage` to hand the previous visit to the next instrumented page, respecting
`storage.enabled` and `storage.namePrefix`. With no nonempty prefix, a string connection string
automatically isolates state by destination. A nonempty `storage.namePrefix` is the entire
destination identity for page-visit state, for both string and deferred connection strings. Dedicate
each explicit prefix to one destination and keep it consistent across pages; changing the connection
string's form does not change the visit namespace. Reusing a prefix for different destinations can
mix their visits.

Each namespace has instance slots. Multiple instances sharing a namespace must initialize in a
consistent order across pages so their slots match; use distinct `storage.namePrefix` values to
isolate them.
When storage is disabled or unavailable, timing falls back to in-memory SPA transitions only.
For a deferred Azure Monitor connection string, supply an explicit, destination-specific
`storage.namePrefix` to enable cross-document persistence before resolution. Without it, timing
stays in memory so an unknown destination cannot consume another destination's visit.

Child frames always keep page-visit timing in memory, even with an explicit prefix. Same-origin
frames share their parent's `sessionStorage`, but have independent instance slots; a prefix alone
cannot establish browsing-context ownership. Child frames therefore neither consume nor overwrite
the parent's visit state, and do not bridge full-document navigations. Their SPA visits still work.
This restriction applies to page-visit persistence, not other SDK-managed storage.

New tabs opened with `window.open()` can receive a copy of the opener's `sessionStorage`. Before
restoring visits, the SDK compares a stable storage-owner marker with the accessible same-origin
opener's marker. A matching copy loses only its page-visit entries and receives a new owner marker;
it does not report the opener's still-active visit. Later same-tab navigations and reloads in the
popup retain persistence, even if its opener has navigated. Application storage and `window.name`
are not changed. If the opener is already closed or cross-origin before the popup first initializes
tracking, the SDK cannot compare their markers and identify the copied state.

No visit log or metric is emitted on `pagehide`, hidden visibility or unload. A final visit with no
next instrumented page is skipped. On back/forward cache (BFCache) restore, the tracker reads the
persistent successor visit rather than reusing the restored page's old in-memory visit, avoiding
duplicate reporting. Without storage, the tracker drops its visit on `pagehide` and cannot bridge
BFCache away time.

## Browser instrumentation options

Import `getInstrumentations` from `@microsoft/opentelemetry-browser/instrumentations`, await it, and
pass the returned array as `instrumentations`. Calling the helper is opt-in: without it, fetch and
XHR are not installed automatically. Its options use the upstream configuration types from
`@opentelemetry/browser-instrumentation` **0.8.1**; do not confuse them with the initialization
object or loader configuration.

| Helper key         | Constructed by default | Settings beyond `enabled`                                                                                                       |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`            | Yes                    | `ignoreUrls`, `propagateTraceHeaderCorsUrls`, `measureRequestSize`, `sanitizeUrl`, `requestHook`, `applyCustomAttributesOnSpan` |
| `xhr`              | Yes                    | `ignoreUrls`, `propagateTraceHeaderCorsUrls`, `measureRequestSize`, `sanitizeUrl`, `applyCustomAttributesOnSpan`                |
| `console`          | No                     | `logMethods`, `messageSerializer`                                                                                               |
| `errors`           | No                     | `applyCustomAttributes`                                                                                                         |
| `navigation`       | No                     | `useNavigationApiIfAvailable`, `sanitizeUrl`, `applyCustomLogRecordData`                                                        |
| `navigationTiming` | No                     | None                                                                                                                            |
| `resourceTiming`   | No                     | `initiatorTypes`, `ignoreUrls`, `batchSize`, `maxQueueSize`, `forceProcessingAfter`, `maxProcessingTime`                        |
| `userAction`       | No                     | `autoCapturedActions`, `applyCustomLogRecordData`                                                                               |
| `webVitals`        | No                     | `includeRawAttribution`, `applyCustomLogRecordData`                                                                             |

- `enabled` is a boolean. Fetch/XHR are constructed unless `false`; other modules require `true`.
  All returned instances are initially inert; registration enables them after provider binding.
- URL filters and cross-origin propagation lists accept arrays of strings or `RegExp` objects.
  `sanitizeUrl` maps a URL string to a string. Request-size measurement is off unless enabled.
  Same-origin trace propagation is supported; cross-origin propagation requires an allowed URL
  and server CORS permission for the propagation headers. Fetch/XHR require a trace pipeline.
- Fetch's `requestHook(span, request)` runs before sending; its attribute hook receives
  `(span, request, result)`. XHR's attribute hook receives `(span, xhr)`. Errors'
  `applyCustomAttributes(error)` returns additional attributes. Log-record hooks mutate a record.
- Console captures `log`, `warn`, `error`, `info` and `debug` unless `logMethods` narrows the list.
  `messageSerializer(args)` controls the message body. Avoid collecting sensitive console output.
- Navigation's `useNavigationApiIfAvailable` defaults to `false`. Prefer built-in page views:
  enabling both produces separate records that Azure Monitor maps to page views.
- The distribution limits resource timing to `initiatorTypes: ["script", "link", "css"]` and
  `maxQueueSize: 256`, unless overridden. Other upstream defaults are `batchSize: 50`,
  `forceProcessingAfter: 1000` ms and `maxProcessingTime: 50` ms.
- User actions currently capture `click` by default; `autoCapturedActions` selects actions.
  Review CSS selectors and `data-otel-*` element attributes for sensitive content.
- Web Vitals `includeRawAttribution` defaults to `false`; enabling it includes attribution JSON in
  the log body. Availability depends on browser performance APIs and user activity.

### Runtime instrumentation controls

Normal automatic startup is unchanged: the distribution binds providers and enables eligible
registered instrumentations without an extra handle call. The returned handle exposes
`instrumentations` for instance-local lookup, pause/resume and supported registration changes:

- `instrumentations.get(id: string): BrowserInstrumentation | undefined` returns the registered
  object, or `undefined` for an unknown ID. Inspection only: do not call its lifecycle methods or
  `setConfig` directly.
- `instrumentations.setEnabled(id: string, enabled: boolean): Promise<void>` sets the entry's
  requested enabled state. It rejects unknown IDs, unsupported runtime lifecycle operations and
  invalid arguments. Calls serialize with this handle's `updateCfg` and are subject to the
  collection-gate, rollback and shutdown rules above.
- `instrumentations.add(id: string, instrumentation: BrowserInstrumentation): Promise<void>`
  registers a supported object under an explicit, non-empty, unused ID.
- `instrumentations.remove(id: string): Promise<void>` disables and removes a supported entry,
  releasing ownership only after cleanup succeeds.
- `instrumentations.replace(id: string, instrumentation: BrowserInstrumentation): Promise<void>`
  replaces a supported entry while preserving its ID, registration position and requested enabled
  state. The candidate's own kind determines which network gate applies.

IDs use the upstream module suffix: `fetch`, `xhr`, `console`, `errors`, `user-action` and
`web-vitals` for supported modules. Other upstream modules also use their suffix. Custom modules
use their full instrumentation name, or `instrumentation` if unnamed. Repeated IDs receive `#2`,
`#3`, and so on in registration order, for example `fetch#2`. The built-in page-view entry uses
`@microsoft/opentelemetry-browser/page-view`, not `page-view`.

Runtime pause/resume supports only the pinned `@opentelemetry/browser-instrumentation` **0.8.1**
fetch, XHR, console, errors and user-action modules, plus the **same Web Vitals object** registered
at startup. Web Vitals pause gates emission while its underlying observers remain registered;
resume does not replace the object or register a new set of observers. Page views, navigation,
navigation timing, resource timing, other versions and custom modules remain startup/shutdown-only:
`get()` can return them, but `setEnabled()` rejects their runtime lifecycle changes.

Requested enablement is separate from effective collection. `setEnabled(id, true)` neither opens a
closed fetch/XHR gate nor revives a disabled trace pipeline. Reopening a gate preserves manual
pauses, including when a replacement `updateCfg` resets the gates. The object's `getConfig().enabled`
is not a runtime collection-status API. Controls affect only this handle, even when browser patches
are shared with other instances.

Runtime add/remove/replace supports only pinned **0.8.1** fetch, XHR, console, errors and user-action
objects. Construct candidates with `enabled: false`; they must be inactive and not owned by any
handle. Fetch/XHR candidates require an enabled trace pipeline, even when a collection gate is
closed. No modules are imported or constructed by these methods. Added entries request collection
immediately, subject to the gate; replacements preserve a manual pause. A replacement can use a
different supported kind. Existing IDs are never renumbered after removal or replacement.

Web Vitals remains startup registration and same-object pause/resume only: its observer callbacks
cannot be unregistered, so runtime add/remove/replace rejects it. Page views, navigation, timing,
custom modules and other versions also reject registration changes.

All mutation methods serialize with `updateCfg`. Candidates are claimed before provider binding;
the new object becomes visible through `get` only after successful activation. The old object stays
visible during replacement, and is released only after the new registration succeeds. Failed
mutations attempt candidate cleanup and restoration of the previous registration. Objects whose
cleanup fails remain privately owned and are included in shutdown cleanup; subsequent mutations
reject when lifecycle state is uncertain. This cannot undo observed events, sent requests or injected
headers. A removed object may be registered on another handle after successful cleanup. Shutdown
attempts every remaining object, including unpublished candidates, in reverse ownership order.
Errors-instrumentation cleanup failures receive one bounded retry using the retained listener
references. The shutdown promise still reports the original error. Other failed cleanup, or a failed
errors retry, retains ownership: upstream enabled flags can hide incomplete removal, so those
objects cannot be reused on another handle. Calling `shutdown` again returns the same promise
rather than retrying indefinitely.

```typescript
const fetchInstrumentation = telemetry.instrumentations.get("fetch"); // Inspect only.
await telemetry.instrumentations.setEnabled("fetch", false);
await telemetry.updateCfg({ disableFetchTracking: true });
await telemetry.updateCfg({ disableFetchTracking: false }); // Manual pause remains.
await telemetry.instrumentations.setEnabled("fetch", true); // Resume the registered entry.

// Construct explicitly; the root package never imports optional instrumentation modules.
const { ErrorsInstrumentation } =
  await import("@opentelemetry/browser-instrumentation/experimental/errors");
await telemetry.instrumentations.add(
  "application-errors",
  new ErrorsInstrumentation({ enabled: false }),
);
await telemetry.instrumentations.replace(
  "application-errors",
  new ErrorsInstrumentation({ enabled: false }),
);
await telemetry.instrumentations.remove("application-errors");
```

## Enrichment and filtering

There is no `addTelemetryInitializer` or `getPlugin`, the same as in the other Microsoft
OpenTelemetry distributions. Use OpenTelemetry concepts instead:

| Application Insights JavaScript              | OpenTelemetry replacement                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telemetry initializer that adds properties   | `resource` for values fixed for the page; a span processor (`onStart` or `onEnding`) or log record processor (`onEmit`) for per-record attributes.                                         |
| Telemetry initializer that drops telemetry   | Filter at the source: instrumentation `ignoreUrls`, `samplingPercentage`, or not emitting the record. A processor cannot remove a record from other processors.                            |
| Per-request or per-page-view customization   | Instrumentation hooks such as `applyCustomAttributesOnSpan` and `pageView.applyCustomLogRecordData`.                                                                                       |
| `getPlugin` to configure or replace a plugin | Inspect registered objects with `instrumentations.get(id)`; use `instrumentations.setEnabled(id, enabled)` for supported pause/resume. Configure page views through `pageView` at startup. |

Supplied processors run before the Azure Monitor exporter, so their attributes are exported,
including when `samplingPercentage` is set. Processors are registered at startup and cannot be added
later; to change enrichment at runtime, have the processor read application state:

```ts
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

let tenant = "unknown";
export const setTenant = (value: string): void => {
  tenant = value;
};

const tenantSpans: SpanProcessor = {
  onStart: (span) => span.setAttribute("app.tenant", tenant),
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
const tenantLogs: LogRecordProcessor = {
  onEmit: (record) => record.setAttribute("app.tenant", tenant),
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

await useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString },
  spanProcessors: [tenantSpans],
  logRecordProcessors: [tenantLogs],
});
```

Azure Monitor maps custom attributes to `customDimensions`.

## Context, propagation and lifecycle

`traces.contextManager` accepts an OpenTelemetry `ContextManager`. The default synchronous manager
does not preserve active context across unbound async continuations. See the
[explicit-context example](../README.md#known-beta-limitations).

`traces.propagators` accepts a readonly array of `TextMapPropagator`. Omit it for W3C Trace Context
and Baggage, or supply `[]` to disable propagation when this distribution owns the registration.
Global context and propagation are page-lifetime registrations, not per-handle isolation. The first
active trace instance supplies the owned context delegate; later propagator options are unused.
Application-registered context managers are not disabled by shutdown. Page-view instances share one
operation per navigation, while explicit application span contexts take precedence.

Global tracer/logger acquisition binds to the selected instance; shutdown does not reroute already
acquired objects into another instance. Newly acquired objects use the earliest remaining instance
that collects that signal. Share OpenTelemetry API packages as singletons in module-federated apps,
or acquire tracers/loggers after initialization. Iframes and workers have independent realm state.

| Handle method  | Behavior                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forceFlush()` | Flushes this instance. Concurrent calls share a promise; once shutdown starts, returns its promise. Each processor gets 30 seconds; timeout does not cancel an in-flight export.                                               |
| `shutdown()`   | Rejects new telemetry, stops collection, waits for active flushes and shuts down this instance's providers. Repeated calls return the same promise. Each processor shutdown gets 30 seconds; cleanup continues after failures. |

Both methods return `Promise<void>` and can reject; multiple failures are reported with
`AggregateError`. Other instances keep running after one handle shuts down. Automatic flushing on
page hide/hidden visibility is best effort, not guaranteed delivery; Azure Monitor telemetry left
unsent is retried by the next page load in the same tab through the `sessionStorage` buffer.

## CDN loader configuration

`getSdkLoaderScript()` is exported from the ESM-only `@microsoft/opentelemetry-browser/snippet` entry.
It generates a script; it does not itself initialize telemetry in the current page.

| Option                                                                       | Default and behavior                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectionString`                                                           | Required non-empty string; becomes `cfg.azureMonitor.connectionString`.                                                                                           |
| `src`                                                                        | This package version's immutable CDN IIFE URL. Custom URLs must expose `Microsoft.OpenTelemetry` as a classic script global.                                      |
| `crossOrigin`                                                                | `"anonymous"`. Applied to the injected script.                                                                                                                    |
| `integrity`                                                                  | Unset. Supply integrity metadata for the exact version and artifact.                                                                                              |
| `loadDelay`                                                                  | Immediate injection. A nonnegative delay in milliseconds adds nonblocking delayed loading.                                                                        |
| `cdnFallback`                                                                | `false`. Retry backup Azure Monitor CDN hosts; requires a recognized CDN source URL.                                                                              |
| `reportLoadFailure`                                                          | `false`. Report an `SDKLoadFailed` exception after bundle load attempts fail.                                                                                     |
| `samplingPercentage`, `azureMonitor.disableBeacon`, `session`, `userContext` | Same meanings as initialization options above.                                                                                                                    |
| `pageView`                                                                   | Data-only settings: `enabled`, `autoTrackPageVisitTime` (default `false`), `redactedQueryParams`, `softNavigationSettleTimeoutMs`, `useNavigationApiIfAvailable`. |
| `instrumentationOptions`                                                     | JSON-only helper settings. Omitted: fetch/XHR defaults.                                                                                                           |
| `resourceAttributes`                                                         | String, number or boolean attributes converted into a resource by the bundle.                                                                                     |

The generator accepts JSON-serializable settings, not functions or regular expressions. Processors,
exporters, context managers, propagators and resource detectors require npm-based initialization.
Loader options are unchanged: use `azureMonitor.disableBeacon`, not the root `onunloadDisableBeacon`
alias supported only by runtime updates. `disableFetchTracking` and `disableAjaxTracking` are also
runtime-only and are not accepted by the loader or its generated initialization `cfg`.
`configSync` is also npm startup-only and is not accepted by the loader or generated configuration.
The generated configuration's `cfg` holds initialization options; `instrumentationOptions` and
`resourceAttributes` are siblings of `cfg`. See [Packaging](packaging.md#cdn-and-loader-snippet) for
the snippet, CSP, fallback hosts, integrity manifests and failure handling.
