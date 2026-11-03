// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextManager, TextMapPropagator, TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ConsoleInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/console";
import type { ErrorsInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/errors";
import type { FetchInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import type { NavigationInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import type { NavigationTimingInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";
import type { ResourceTimingInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import type { UserActionInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import type { WebVitalsInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import type { XhrInstrumentationConfig } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import type { AzureMonitorOptions } from "./exporter/base.js";
import type { PageViewInstrumentationConfig } from "./instrumentation/pageView/types.js";
import type {
  MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  MicrosoftOpenTelemetryBrowserConfigurationUpdateResult,
} from "./configuration/runtimeConfiguration.js";

/**
 * Selects and configures the instrumentations that `getInstrumentations` constructs.
 *
 * @remarks
 * Each key configures one instrumentation, and its value is that instrumentation's own
 * configuration type, so every setting it supports is available and stays in step with its source
 * without being restated here.
 *
 * `fetch` and `xhr` are constructed unless `enabled` is `false`. Every other instrumentation is
 * constructed only when `enabled` is `true`. Nothing is constructed until `getInstrumentations`
 * is called, so a caller that never calls it registers no instrumentations at all.
 *
 * Uses `@opentelemetry/browser-instrumentation` with distro defaults and shared-patch registration.
 *
 * @public
 */
export interface InstrumentationOptions {
  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/errors`. */
  errors?: ErrorsInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/fetch`. */
  fetch?: FetchInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/xhr`. */
  xhr?: XhrInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/navigation`. */
  navigation?: NavigationInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/navigation-timing`. */
  navigationTiming?: NavigationTimingInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/resource-timing`. */
  resourceTiming?: ResourceTimingInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/user-action`. */
  userAction?: UserActionInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/web-vitals`. */
  webVitals?: WebVitalsInstrumentationConfig;

  /** Configuration for `@opentelemetry/browser-instrumentation/experimental/console`. */
  console?: ConsoleInstrumentationConfig;
}

/**
 * The trace and log registration contract implemented by OpenTelemetry instrumentations.
 *
 * @remarks
 * This browser-only subset accepts upstream instrumentation instances without exposing the
 * Node-specific declarations from `@opentelemetry/instrumentation`. Metrics are not initialized
 * by this distribution.
 *
 * @public
 */
export interface BrowserInstrumentation {
  /** Binds the instrumentation to the active tracer provider. */
  setTracerProvider(provider: TracerProvider): void;
  /** Binds log-producing instrumentations to the active logger provider. */
  setLoggerProvider?(provider: LoggerProvider): void;
  /** Returns the instrumentation's configuration without modifying it. */
  getConfig(): { enabled?: boolean };
  /** Starts observing when construction was deferred with `enabled: false`. */
  enable(): void;
  /** Stops observing before telemetry providers shut down. */
  disable(): void;
}

/**
 * Advanced configuration for browser trace context and propagation.
 *
 * @remarks
 * Uses W3C Trace Context and Baggage by default. Page-view correlation delegates to the supplied
 * context manager (or an upstream synchronous stack manager) and supplies the page operation only
 * when there is no active span. Pass explicit context across asynchronous boundaries.
 *
 * The OpenTelemetry global context and propagation APIs are page-lifetime registrations that
 * `shutdown` does not unregister. Each initialization owns its own telemetry pipelines, but the
 * first active instance that collects traces supplies context. Its delegate is disabled when the
 * last instance stops. Implicit context tracking then stops until a later initialization supplies
 * a new delegate. Application-registered context managers are never disabled. Propagators remain
 * page-lifetime registrations, so later propagator options are unused. Propagation is registered
 * even when the application already registered a context manager. Instances with page views share
 * one page operation per navigation, so their page-view IDs and correlated spans and logs match.
 *
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserTraceOptions {
  /**
   * Context manager used to track the active span across browser callbacks.
   * Explicit span contexts take precedence over the page operation.
   */
  contextManager?: ContextManager;
  /**
   * Propagators combined for extraction and injection.
   * Omit this setting for W3C Trace Context and Baggage; use an empty array to disable propagation.
   */
  propagators?: readonly TextMapPropagator[];
}

/**
 * Session options. Lifetimes can be updated through updateCfg; enabled/persist are startup-only.
 * Lifetimes must be finite and nonnegative.
 * Managed session IDs are added only when neither the record nor its resource has a non-empty
 * string `session.id`. Azure Monitor export prefers a valid record value over the resource.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserSessionOptions {
  /** Enables session tracking. Defaults to true. False disables it without accessing storage. */
  enabled?: boolean;
  /**
   * Persist in localStorage (default true). False uses memory without accessing or clearing storage.
   * `storage.enabled: false` overrides this setting.
   */
  persist?: boolean;
  /**
   * Seconds without managed-session telemetry. Defaults to 1800. Zero disables inactivity expiry.
   */
  inactivityTimeout?: number;
  /**
   * Maximum lifetime in seconds, including across reloads. Defaults to 86400 (24 hours). Zero means unlimited.
   */
  maxDuration?: number;
}

/** Startup-only same-realm event synchronization. No HTTP, storage or cross-tab transport.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationSyncOptions {
  /** 0: off, 1: broadcast only, 2: receive only (default after explicit opt-in). */
  readonly syncMode?: 0 | 1 | 2;
  /** Same-realm CustomEvent channel. Defaults to ai_cfgsync; not an authentication boundary. */
  readonly customEvtName?: string;
  /** Prevent synchronization of selected allowlisted root fields. False cannot widen the allowlist. */
  readonly nonOverrideConfigs?: Readonly<
    Partial<Record<"samplingPercentage" | "disableFetchTracking" | "disableAjaxTracking", boolean>>
  >;
  /** Receives validation or asynchronous receive failures. Thrown/rejected callbacks are isolated. */
  readonly onError?: (error: unknown) => void;
}

/** Lifecycle controls for an explicitly configured same-realm event adapter.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationSync {
  /** Explicitly broadcasts the allowed current snapshot in mode 1. Dispatch is not receiver acknowledgement. */
  sync(): Promise<void>;
  /** Stops listening/publishing and invalidates queued delivery without reverting committed values. */
  pause(): void;
  /** Resumes observation without replay. No effect after shutdown. */
  resume(): void;
  /** Permanently removes this adapter's listener. Telemetry shutdown also calls this. */
  shutdown(): void;
}

/**
 * Microsoft browser distribution configuration for traces and logs.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Explicit opt-in; absent configuration installs no synchronization adapter or listener. */
  extensionConfig?: {
    AppInsightsCfgSyncPlugin?: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions;
  };
  /** Application Insights inactivity lifetime in milliseconds. Zero restores 30 minutes. */
  sessionRenewalMs?: number | undefined;
  /** Application Insights maximum session lifetime in milliseconds. Zero restores 24 hours. */
  sessionExpirationMs?: number | undefined;
  /**
   * Fixed percentage of traces and Azure Monitor log records retained, from 0 through 100.
   * Omit this option to use the OpenTelemetry SDK's parent-based always-on trace sampler and to
   * disable percentage sampling for Azure Monitor logs.
   */
  samplingPercentage?: number;
  /** Azure Monitor destination. When provided, Azure Monitor export is enabled. */
  azureMonitor?: AzureMonitorOptions<string | Promise<string>>;
  /**
   * Resource describing the entity producing telemetry.
   *
   * @remarks
   * Build it with `resourceFromAttributes` or `detectResources` from `@opentelemetry/resources`.
   * Merged over the SDK defaults, so `service.name` set here replaces the `unknown_service`
   * placeholder. Resolved once at initialization, so only values fixed for the lifetime of the
   * page belong here. Only its attributes are used; the schema URL is not carried through.
   */
  resource?: Resource;
  /** Session tracking, enabled by default. Disabled sessions do not access storage. */
  session?: MicrosoftOpenTelemetryBrowserSessionOptions;
  /** Browser persistence controls, captured at initialization. Applies only to this handle. */
  storage?: {
    /**
     * Defaults to true. False blocks all SDK-managed browser storage access, including identity
     * controls called later. Sessions remain in memory; managed anonymous identity is disabled.
     * Does not erase existing data or disable collection, network requests, or custom processors.
     */
    enabled?: boolean;
    /**
     * Literal prefix for session, user and unsent telemetry buffer storage keys. Defaults to an
     * empty string, preserving existing keys. Use a distinct prefix to isolate applications or
     * handles on the same origin.
     * Existing unprefixed data is not read, migrated, or removed when a prefix is configured.
     */
    namePrefix?: string;
  };
  /**
   * User identity persistence configuration. `enabled` defaults to true.
   *
   * @remarks
   * By default, spans and logs receive a stable managed `enduser.pseudo.id` unless the record or
   * resource already has one. The anonymous ID is persisted in same-origin `localStorage` so user
   * metrics remain stable across page loads and SDK instances. Authenticated user and account IDs
   * set through the returned user context are also persisted by default. Set `enabled` to `false`
   * to keep authenticated values in memory and disable all managed
   * identity persistence and anonymous-ID enrichment without accessing storage.
   *
   * The storage record is shared by handles with the same storage prefix in the origin and remains across browser sessions
   * until `userContext.setEnabled(false)` is called or the application clears it. Any script
   * running in the origin can read persisted values, so do not use raw personally identifiable
   * information, secrets, or tokens as identity values. Persistence can be changed later through
   * the returned user context unless `storage.enabled` is false.
   */
  userContext?: { enabled?: boolean };
  /** Advanced trace context and propagation configuration. */
  traces?: MicrosoftOpenTelemetryBrowserTraceOptions;
  /**
   * Span processors to register with the tracer provider. When omitted, spans export to Azure
   * Monitor when `azureMonitor` is set; otherwise trace initialization is skipped. An empty array
   * always skips trace initialization. Ownership transfers when provider startup begins, including failed startup.
   * Do not share processor instances between handles.
   *
   * @remarks
   * Use these in place of Application Insights telemetry initializers. They run before the Azure
   * Monitor exporter, so attributes set in `onStart` or `onEnding` are exported. Processors are
   * fixed at startup; to change enrichment later, read application state from the processor.
   */
  spanProcessors?: SpanProcessor[];
  /**
   * Log record processors to register with the logger provider. When omitted, logs export to Azure
   * Monitor when `azureMonitor` is set; otherwise log initialization is skipped. An empty array
   * always skips log initialization. Ownership transfers when provider startup begins, including failed startup.
   * Do not share processor instances between handles.
   *
   * @remarks
   * Use these in place of Application Insights telemetry initializers. They run before the Azure
   * Monitor exporter, so attributes set in `onEmit` are exported. Processors are fixed at startup;
   * to change enrichment later, read application state from the processor.
   */
  logRecordProcessors?: LogRecordProcessor[];
  /**
   * Instrumentations owned and disabled by this handle. Do not share instances.
   * Construct upstream fetch, XHR, console and navigation with `enabled: false` before registration.
   * Shared patches keep settings isolated. Fetch/XHR require an enabled trace pipeline.
   * Fetch uses the last writer's trace headers. XHR preserves existing headers.
   */
  instrumentations?: readonly BrowserInstrumentation[];
  /**
   * Page-view collection, which this distribution owns and turns on by itself.
   *
   * @remarks
   * Emits one `browser.page_view` log record per navigation, covering the initial document load
   * and subsequent route changes. The page-view ID is its operation trace ID. Otherwise
   * unparented spans and logs share that operation; explicit span contexts are preserved.
   * Page URL and descriptive attributes stay on the page-view record, not on other telemetry.
   *
   * Collection and operation correlation are on by default; set `enabled: false` to turn both off.
   * Doing so stops collection
   * but does not remove the implementation from the bundle, because a bundler resolves imports
   * long before this object exists.
   */
  pageView?: PageViewInstrumentationConfig;
  /**
   * Additional case-sensitive query-string and fragment parameter names to redact on captured
   * fetch/XHR HTTP client URLs and page-view URLs/referrers. Built-in signing and OAuth parameters
   * and URL credentials remain protected. Captured at initialization.
   */
  redactQueryParams?: readonly string[];
}

/**
 * Mutable user identity context applied to subsequently created spans and logs.
 *
 * @remarks
 * Spans are enriched when they start and logs when they are emitted. Managed authenticated user
 * and account attributes are added only when neither the record nor its resource supplies
 * `user.id`, `enduser.id`, or `user.account.id`; identity attributes set on a span after it starts are not
 * reconciled. Controls remain usable after the lifecycle handle shuts down so applications can
 * still clear persisted identity.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserUserContext {
  /**
   * Sets authenticated identity using OpenTelemetry `user.id` and Azure Monitor
   * `ai.user.authUserId`. The optional account maps to `ai.user.accountId`; omitting it clears a
   * previously set account.
   *
   * @throws TypeError when an ID is not a non-empty string.
   * @throws Error when persistence is enabled and the identity cannot be saved. The previously
   * persisted identity is removed when possible; otherwise the error reports that clearing
   * failed. The in-memory identity is still applied.
   */
  setAuthenticatedUserContext(userId: string, accountId?: string): void;
  /**
   * Clears authenticated identity and any persisted authenticated context. If persistence is
   * enabled but the anonymous identity cannot be saved again, managed anonymous enrichment is
   * suppressed and a diagnostic warning is logged. Persistence remains enabled so a later
   * identity update can retry the write; anonymous enrichment resumes after a successful write.
   *
   * @throws Error when persistence is enabled and stale authentication cannot be removed.
   */
  clearAuthenticatedUserContext(): void;
  /**
   * Enables persistence for anonymous, authenticated and account identity, or disables all
   * persistence without changing the current in-memory authenticated identity. Managed anonymous
   * identity is applied to telemetry only while persistence is enabled. Disabling also removes
   * identity persisted by earlier page loads. The stored record is shared by handles with the same
   * storage prefix in the origin, so disabling or signing out changes that record for future page
   * loads. Each active handle keeps its own state, so update every active handle to change the
   * identity it applies to telemetry. When initialized with `storage.enabled: false`, this method
   * has no effect and never accesses storage.
   *
   * @throws Error when enabling cannot save identity, or when disabling cannot remove identity
   * this instance persisted.
   */
  setEnabled(enabled: boolean): void;
}

/**
 * Controls registered instrumentations without replacing providers or constructing new modules.
 * @remarks
 * IDs use upstream module suffixes (fetch, xhr, console, errors, user-action, web-vitals),
 * full custom names or "instrumentation". Repeated IDs receive #2, #3, and so on.
 * Runtime pause/resume supports upstream 0.8.1 fetch, XHR, console, errors, user-action and
 * the same Web Vitals object only. Page views, navigation, timing and custom modules are
 * startup/shutdown-only. Web Vitals callbacks remain registered while emission is paused.
 * Runtime add/remove/replace supports only fetch, XHR, console, errors and user-action.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserInstrumentations {
  /** Returns an owned object, or undefined. Do not call its lifecycle or setConfig directly. */
  get(id: string): BrowserInstrumentation | undefined;
  /**
   * Registers a disabled, unowned supported object under an explicit non-empty, unused ID.
   * Binds this instance's providers, then enables collection subject to its network gate.
   * Fetch/XHR require an enabled trace pipeline. No modules are imported or constructed.
   */
  add(id: string, instrumentation: BrowserInstrumentation): Promise<void>;
  /**
   * Disables and removes a supported entry, releasing ownership only after successful cleanup.
   * In-flight requests can still complete; removing Web Vitals or startup-only modules rejects.
   */
  remove(id: string): Promise<void>;
  /**
   * Replaces a supported entry with a disabled, unowned supported object, keeping its ID and
   * requested enablement. The candidate's kind determines its gate. Lifecycle failures attempt
   * rollback; uncertain objects remain owned for shutdown. Web Vitals replacement rejects.
   */
  replace(id: string, instrumentation: BrowserInstrumentation): Promise<void>;
  /**
   * Pauses/resumes collection for this instance. Serialized with updateCfg. Rejects unknown IDs,
   * unsupported modules and operations after shutdown. Resuming never opens a closed network
   * gate or enables a disabled trace pipeline. In-flight requests can still finish.
   * Lifecycle failures attempt rollback; failed rollback requires shutdown before further changes.
   */
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /** Present only after explicit configuration of AppInsightsCfgSyncPlugin. */
  readonly configSync?: MicrosoftOpenTelemetryBrowserConfigurationSync;
  /** Instance-local controls for already registered instrumentations. Startup remains automatic. */
  readonly instrumentations: MicrosoftOpenTelemetryBrowserInstrumentations;
  /**
   * Updates sampling, session lifetimes and unload-beacon policy without replacing providers.
   * The percentage must be finite and between 0 and 100. Explicit undefined restores the
   * parent-based trace sampler and disables percentage sampling for Azure Monitor logs.
   * Updates affect subsequent sampling decisions, not telemetry already sampled or queued.
   * Session durations use seconds, with zero disabling expiration. The sessionRenewalMs and
   * sessionExpirationMs aliases use milliseconds; zero restores the corresponding native default.
   * Lifetimes retain current session timestamps and take effect on the next managed activity.
   * Enabling sessions, persistence and browser storage remain startup-only settings.
   * azureMonitor.disableBeacon and its onunloadDisableBeacon alias control only this handle's
   * default Azure Monitor sendBeacon fallback. Undefined resets to false. The current policy is
   * read at each fallback attempt, including for previously queued telemetry, without cancelling
   * dispatched requests. Keepalive remains first; updates never create or change a destination.
   *
   * mergeExisting defaults to true, preserving omitted fields. False replaces the supported
   * runtime configuration, resetting omitted fields to their defaults; startup options are unchanged.
   * Calls are serialized and return a Promise with the committed revision and changed paths.
   * No-op updates retain the revision. Invalid or unsupported fields reject without changes.
   * New and queued updates reject once shutdown begins.
   * disableFetchTracking and disableAjaxTracking gate registered fetch/XHR collection only.
   * Both default to false; undefined restores false. They never register missing modules or
   * override an explicit instrumentation pause. Requests already sent are not cancelled.
   */
  updateCfg(
    patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
    mergeExisting?: boolean,
  ): Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult>;
  /** Mutable user identity and persistence controls. */
  readonly userContext: MicrosoftOpenTelemetryBrowserUserContext;
  /**
   * Flushes this instance's pending telemetry. Concurrent calls share a promise.
   * Each processor has 30 seconds to finish before rejection. Timeouts do not cancel exports.
   * All processors are attempted, and multiple failures are reported as an AggregateError.
   * Once shutdown begins, returns the shutdown promise instead.
   */
  forceFlush(): Promise<void>;
  /**
   * Stops session activity immediately, then disables registered instrumentations and shuts down
   * this instance's trace and log providers. Other instances keep running, and tracers or
   * loggers acquired afterward from the global APIs use the earliest remaining instance that
   * collects that signal.
   * Rejects new telemetry immediately and waits for active flushes before shutting down providers.
   * The last instance releases shared unload listeners and the owned context delegate without
   * unregistering global APIs. Each processor shutdown has a 30-second timeout.
   * Cleanup continues after failures. Repeated calls return the same promise, which rejects with
   * the failure or an AggregateError when multiple operations fail.
   */
  shutdown(): Promise<void>;
}
