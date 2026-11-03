// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, type SpanContext } from "@opentelemetry/api";
import {
  BrowserContextLogRecordProcessor,
  BrowserContextSpanProcessor,
} from "./context/contextProcessors.js";
import { createSession } from "./session/createSession.js";
import { createUserContext } from "./user/createUserContext.js";
import { snapshotSdkStatsOptions } from "./exporter/customerSdkStats.js";
import { createKeyValueStorage } from "./storage/keyValueStorage.js";
import { createSessionBufferStorage, sessionBufferStorage } from "./exporter/sessionBuffer.js";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beginUnloading, endUnloading } from "./exporter/common.js";
import type { AzureMonitorLogRecordExporter } from "./exporter/log.js";
import type { AzureMonitorSpanExporter } from "./exporter/trace.js";
import { createAzureMonitorProcessors } from "./exporter/createAzureMonitorProcessors.js";
import { parseConnectionString } from "./exporter/connectionStringParser.js";
import { generatePageViewId, PageViewInstrumentation } from "./instrumentation/pageView/index.js";
import { PageViewCorrelation } from "./instrumentation/pageView/pageViewCorrelation.js";
import { createInstrumentationRegistry } from "./instrumentation/instrumentationRegistry.js";
import { createRuntimeConfiguration } from "./configuration/runtimeConfiguration.js";
import {
  captureConfigurationSync,
  createConfigurationSync,
} from "./configuration/configurationSync.js";
import {
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
import { getSharedRegistry, reportError } from "./shared/globalOwnership.js";
import { runLifecycleTasks, subscribeToUnload, throwErrors } from "./shared/lifecycle.js";
import {
  getPageOperation,
  getPageOperationName,
  isPageContextRegistered,
} from "./routing/pageContext.js";
import { startTelemetryInstance, type TelemetryInstance } from "./routing/telemetryInstance.js";
import { isTraceSampled, RuntimeSampler } from "./sampling.js";
import { DEFAULT_QUERY_STRINGS_TO_REDACT } from "./shared/urlRedaction.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

/** Fork opener-copied visit state once, while retaining later same-tab document handoffs. */
function preparePageVisitStorage(): boolean {
  try {
    const storage = window.sessionStorage;
    const ownerKey = "otel.pageVisitOwner";
    const owner = storage.getItem(ownerKey);
    let copied = false;
    try {
      const opener = window.opener as Window | null;
      // Frames use their top-level tab's owner. Unlike a visit ID, this marker survives
      // opener navigation before the new tab initializes its telemetry.
      copied =
        !!owner &&
        !!opener &&
        !opener.closed &&
        opener.top?.sessionStorage.getItem(ownerKey) === owner;
    } catch {
      // A closed or cross-origin opener is inaccessible. Do not break an established tab's
      // persistence just because its opener subsequently navigates away.
    }
    if (copied) {
      // Snapshot keys before removal: Web Storage enumeration may reorder on mutation.
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (key?.startsWith("otel.pageVisit.")) storage.removeItem(key);
      }
    }
    if (!owner || copied) storage.setItem(ownerKey, generatePageViewId());
    return true;
  } catch {
    // Never consume a predecessor if ownership setup or copied-state cleanup failed.
    diag.warn("Page visit storage unavailable; using memory.");
    return false;
  }
}

/**
 * Builds the instrumentations this distribution owns and turns on by itself.
 *
 * @remarks
 * Distribution-owned instrumentations are selected by configuration rather than by import,
 * because a bundler resolves imports before the application ever supplies its options. Page view
 * is on unless it is switched off.
 *
 * Returns nothing outside a browser. This entry point is routinely imported by a server-rendered
 * build, and these instrumentations observe the DOM, so constructing one there would throw during
 * initialization and take the host application down with it.
 *
 * Each is constructed with `enabled: false` so that collection starts only once the registration
 * loop below has bound its trace and log providers.
 */
function createOwnedInstrumentations(
  options: MicrosoftOpenTelemetryBrowserOptions,
  sharedOperation: () => SpanContext | undefined,
  samplingPercentage: () => number,
  reserveVisitStorageKey: (namespace: string) => string,
): PageViewInstrumentation[] {
  if (typeof document === "undefined" || typeof location === "undefined") return [];

  const owned: PageViewInstrumentation[] = [];
  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    let visitStorageKey: string | undefined;
    if (pageView.autoTrackPageVisitTime) {
      const namePrefix = options.storage?.namePrefix ?? "";
      // An explicit prefix identifies the destination even before a deferred string resolves.
      const destination =
        !namePrefix && typeof options.azureMonitor?.connectionString === "string"
          ? parseConnectionString(options.azureMonitor.connectionString)
          : undefined;
      const namespace = JSON.stringify([
        namePrefix,
        destination?.instrumentationKey?.toLowerCase(),
        destination?.ingestionEndpoint,
      ]);
      visitStorageKey = reserveVisitStorageKey(namespace);
    }
    owned.push(
      new PageViewInstrumentation(
        {
          ...pageView,
          enabled: false,
          sharedOperation,
          visitStorageKey,
          visitStorage:
            options.storage?.enabled === false ||
            // Same-origin frames share sessionStorage, but slot ownership is realm-local.
            window.parent !== window ||
            (options.azureMonitor &&
              typeof options.azureMonitor.connectionString !== "string" &&
              !options.storage?.namePrefix) ||
            (pageView.autoTrackPageVisitTime && !preparePageVisitStorage())
              ? null
              : undefined,
        },
        options.traces?.contextManager?.active() ?? context.active(),
        (traceId) => isTraceSampled(traceId, samplingPercentage()),
      ),
    );
  }
  return owned;
}

/**
 * Restores the session when enabled, then initializes traces, logs, and selected instrumentations.
 * Captures the initial page operation from the supplied manager or global context before awaiting
 * session restoration, so synchronous context scopes are preserved.
 * Await completion before emitting telemetry.
 *
 * @remarks
 * First initialization installs an INFO console diagnostic logger, replacing the previous one.
 * Call `diag.setLogger` afterward to override it.
 *
 * Compatible copies share realm-local routing and page context, not pipelines.
 * Foreign globals stay untouched. Re-entrant registration changes reject startup.
 *
 * Share both API packages as singletons or acquire tracers and loggers after initialization.
 * Early proxies belong to their API copy. Iframes and workers have independent state.
 * @public
 */
export async function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): Promise<MicrosoftOpenTelemetryBrowser> {
  const sdkStats = snapshotSdkStatsOptions(options.azureMonitor?.sdkStats);
  const syncOptions = captureConfigurationSync(options.extensionConfig);
  let stopping = false;
  let configSync: MicrosoftOpenTelemetryBrowser["configSync"];
  let instrumentationRegistry: ReturnType<typeof createInstrumentationRegistry> | undefined;
  const sessionOptions = options.session;
  const inactivityTimeout = sessionOptions?.inactivityTimeout;
  const maxDuration = sessionOptions?.maxDuration;
  const sessionRenewalMs = options.sessionRenewalMs;
  const sessionExpirationMs = options.sessionExpirationMs;
  const azureMonitor = options.azureMonitor
    ? {
        ...options.azureMonitor,
        sdkStats,
      }
    : undefined;
  const samplingPercentage = options.samplingPercentage;
  const configuration = createRuntimeConfiguration(
    {
      samplingPercentage,
      session: {
        ...((inactivityTimeout !== undefined ||
          (sessionOptions && Object.hasOwn(sessionOptions, "inactivityTimeout"))) && {
          inactivityTimeout,
        }),
        ...((maxDuration !== undefined ||
          (sessionOptions && Object.hasOwn(sessionOptions, "maxDuration"))) && {
          maxDuration,
        }),
      },
      ...((sessionRenewalMs !== undefined || Object.hasOwn(options, "sessionRenewalMs")) && {
        sessionRenewalMs,
      }),
      ...((sessionExpirationMs !== undefined || Object.hasOwn(options, "sessionExpirationMs")) && {
        sessionExpirationMs,
      }),
      azureMonitor: { disableBeacon: azureMonitor?.disableBeacon },
    },
    () => {
      instrumentationRegistry?.check();
      return stopping;
    },
    (next) => instrumentationRegistry?.setNetworkGates(next),
    samplingPercentage !== undefined || Object.hasOwn(options, "samplingPercentage"),
  );
  const redactedQueryParams: readonly string[] = [
    ...DEFAULT_QUERY_STRINGS_TO_REDACT,
    ...(options.redactQueryParams ?? []),
  ];
  if (
    options.storage !== undefined &&
    (typeof options.storage !== "object" ||
      options.storage === null ||
      Array.isArray(options.storage))
  ) {
    throw new TypeError("storage must be a non-null, non-array object.");
  }
  const { enabled: storageEnabled = true, namePrefix = "" } = options.storage ?? {};
  if (typeof storageEnabled !== "boolean" || typeof namePrefix !== "string") {
    throw new TypeError("storage.enabled must be a boolean and storage.namePrefix a string.");
  }
  const session =
    sessionOptions?.enabled !== false
      ? createSession(
          {
            persist: storageEnabled ? sessionOptions?.persist : false,
            ...configuration.snapshot().session,
          },
          createKeyValueStorage(
            "localStorage",
            "Session storage unavailable; using an in-memory session.",
            namePrefix,
          ),
          () => configuration.snapshot().session,
        )
      : undefined;
  getSharedRegistry();
  const readSamplingPercentage = () => configuration.snapshot().samplingPercentage;
  const sampler = new RuntimeSampler(readSamplingPercentage);
  const userContext = createUserContext(
    options.userContext?.enabled,
    createKeyValueStorage(
      "localStorage",
      "User storage unavailable; anonymous ID disabled.",
      namePrefix,
    ),
    storageEnabled,
  );
  if (azureMonitor) {
    sessionBufferStorage.set(
      azureMonitor,
      storageEnabled ? createSessionBufferStorage(namePrefix) : null,
    );
  }
  let spanProcessors: SpanProcessor[] | undefined = options.spanProcessors?.slice();
  let logRecordProcessors: LogRecordProcessor[] | undefined = options.logRecordProcessors?.slice();
  const ownedProcessors: (SpanProcessor | LogRecordProcessor)[] = [];
  const azureMonitorExporters: (AzureMonitorSpanExporter | AzureMonitorLogRecordExporter)[] = [];
  let stopAzureMonitorStartup: (() => void) | undefined;
  let startAzureMonitorDiagnostics: (() => void) | undefined;
  const traceOptions = options.traces && {
    ...options.traces,
    propagators: options.traces.propagators?.slice(),
  };
  const pageViewOptions = options.pageView ?? {};
  // Preserve legacy replacement semantics unless the additive, instance-wide option is used.
  const pageView = {
    ...pageViewOptions,
    redactedQueryParams:
      options.redactQueryParams === undefined
        ? pageViewOptions.redactedQueryParams?.slice()
        : [...redactedQueryParams, ...(pageViewOptions.redactedQueryParams ?? [])],
  };
  // While another instance supplies page correlation, page views adopt its operation.
  const correlationState: { current?: PageViewCorrelation } = {};
  let pageViewInstrumentation: PageViewInstrumentation | undefined;
  let correlation: PageViewCorrelation | undefined;
  let releasePageVisitSlot: (() => void) | undefined;
  let instance: TelemetryInstance | undefined;
  let processorsTransferred = false;
  let initialized = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : (session?.getSessionId() ?? null)),
  };
  const contextProvider = {
    ...userContext.provider,
    ...sessionProvider,
    getOperationName: (traceId: string | undefined) =>
      getPageOperation(correlationState.current)
        ? getPageOperationName(correlationState.current, traceId)
        : correlation?.operationName(traceId),
  };
  const contextSpanProcessor = new BrowserContextSpanProcessor(contextProvider);
  const contextLogRecordProcessor = new BrowserContextLogRecordProcessor(contextProvider);

  let shutdownPromise: Promise<void> | undefined;
  let flushPromise: Promise<void> | undefined;
  let unloadFlushPromise: Promise<void> | undefined;
  let removeUnloadSubscription: (() => void) | undefined;
  const flushForUnload = (): void => {
    if (stopping || unloadFlushPromise) return;
    beginUnloading();
    pageViewInstrumentation?.settleForUnload();
    const operation = flushProcessors()
      .catch((error: unknown) => {
        reportError("Telemetry unload flush failed", error);
      })
      .finally(() => {
        endUnloading();
        if (unloadFlushPromise === operation) unloadFlushPromise = undefined;
      });
    unloadFlushPromise = operation;
  };
  function flushProcessors(): Promise<void> {
    const processors = [...(spanProcessors ?? []), ...(logRecordProcessors ?? [])];
    const exporterTasks = azureMonitorExporters.map((exporter) => () => exporter.forceFlush());
    return runLifecycleTasks(
      processors.map((processor) => () => processor.forceFlush()),
      "Telemetry flush failed",
      exporterTasks,
    );
  }

  function forceFlush(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    if (!flushPromise) {
      const operation = flushProcessors();
      const tracked = operation.finally(() => {
        if (flushPromise === tracked) flushPromise = undefined;
      });
      flushPromise = tracked;
    }
    return flushPromise;
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    shutdownPromise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void (async () => {
      stopping = true;
      const errors: unknown[] = [];
      for (const cleanup of [
        () => configSync?.shutdown(),
        () => {
          if (!initialized) pageViewInstrumentation?.rollbackStartup();
        },
        () => stopAzureMonitorStartup?.(),
        () => instance?.detach(),
        () => {
          void correlation?.shutdown();
        },
        () => removeUnloadSubscription?.(),
        () => session?.shutdown(),
      ]) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        instrumentationRegistry?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (!initialized) {
        try {
          instance?.abort();
        } catch (error) {
          errors.push(error);
        }
      }
      const activeFlushes = [flushPromise, unloadFlushPromise].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      );
      if (activeFlushes.length > 0) {
        const flushResults = await Promise.allSettled(activeFlushes);
        for (const result of flushResults) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      }
      try {
        await instance?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (!processorsTransferred) {
        try {
          await runLifecycleTasks(
            ownedProcessors.map((processor) => () => processor.shutdown()),
            "Telemetry processor shutdown failed",
          );
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        // Also clean up exporters after processor failures.
        await runLifecycleTasks(
          azureMonitorExporters.map((exporter) => () => exporter.shutdown()),
          "SDK stats shutdown failed",
        );
      } catch (error) {
        errors.push(error);
      }
      throwErrors(errors, "Telemetry shutdown failed");
    })()
      .finally(() => {
        const release = releasePageVisitSlot;
        releasePageVisitSlot = undefined;
        release?.();
      })
      .then(resolve, reject);
    return shutdownPromise;
  }

  const handle: MicrosoftOpenTelemetryBrowser = {
    forceFlush,
    shutdown,
    userContext: userContext.context,
    updateCfg: (patch, mergeExisting) => configuration.updateCfg(patch, mergeExisting),
    instrumentations: {
      get: (id) => instrumentationRegistry?.get(id),
      add: (id, instrumentation) =>
        configuration.enqueue(() => {
          if (!instrumentationRegistry) throw new Error("Instrumentation registry is unavailable.");
          instrumentationRegistry.add(id, instrumentation);
        }),
      remove: (id) =>
        configuration.enqueue(() => {
          if (!instrumentationRegistry) throw new Error("Instrumentation registry is unavailable.");
          instrumentationRegistry.remove(id);
        }),
      replace: (id, instrumentation) =>
        configuration.enqueue(() => {
          if (!instrumentationRegistry) throw new Error("Instrumentation registry is unavailable.");
          instrumentationRegistry.replace(id, instrumentation);
        }),
      setEnabled: (id, enabled) =>
        configuration.enqueue(() => {
          if (!instrumentationRegistry) throw new Error("Instrumentation registry is unavailable.");
          instrumentationRegistry.setEnabled(id, enabled);
        }),
    },
  };

  try {
    // Reserve before construction or callbacks can re-enter startup, with rollback already armed.
    const owned = createOwnedInstrumentations(
      { pageView, azureMonitor, storage: options.storage, traces: options.traces },
      () => getPageOperation(correlationState.current),
      () => readSamplingPercentage() ?? 100,
      (namespace) => {
        const namespaces = (getSharedRegistry().pageVisitSlots ??= new Map<string, Set<number>>());
        const slots = namespaces.get(namespace) ?? new Set<number>();
        namespaces.set(namespace, slots);
        let slot = 0;
        while (slots.has(slot)) slot++;
        slots.add(slot);
        releasePageVisitSlot = () => {
          slots.delete(slot);
          if (!slots.size) namespaces.delete(namespace);
        };
        return `otel.pageVisit.${namespace}.${slot}`;
      },
    );
    const pageInstrumentation = (pageViewInstrumentation = owned[0]);
    pageInstrumentation?.beginStartup();
    correlation = pageInstrumentation
      ? new PageViewCorrelation(
          () => pageInstrumentation.getOperationContext(),
          pageInstrumentation.pageViews,
          (traceId) => pageInstrumentation.getOperationName(traceId),
        )
      : undefined;
    correlationState.current = correlation;
    // Publish the initial page operation before caller instrumentations can emit.
    const instrumentations = [...owned, ...(options.instrumentations ?? [])];
    if (azureMonitor) {
      const { span, log, stop, startDiagnostics } = createAzureMonitorProcessors(
        azureMonitor,
        spanProcessors?.length !== 0,
        logRecordProcessors?.length !== 0,
        readSamplingPercentage,
        azureMonitorExporters,
        () => configuration.snapshot().azureMonitor.disableBeacon,
      );
      stopAzureMonitorStartup = stop;
      startAzureMonitorDiagnostics = startDiagnostics;
      // Caller processors run first, as in the JavaScript distribution, so their enrichment
      // reaches Azure Monitor even when sampling forwards a copy of the record.
      if (span) {
        ownedProcessors.push(span);
        spanProcessors = [...(spanProcessors ?? []), span];
      }
      if (log) {
        ownedProcessors.push(log);
        logRecordProcessors = [...(logRecordProcessors ?? []), log];
      }
    }
    const noDestination = !azureMonitor && !spanProcessors && !logRecordProcessors;
    await session?.start();
    spanProcessors ??= [];
    logRecordProcessors ??= [];
    await options.resource?.waitForAsyncAttributes?.();
    if (
      (traceOptions?.contextManager || traceOptions?.propagators) &&
      spanProcessors.length !== 0 &&
      isPageContextRegistered()
    ) {
      diag.warn("Trace context options ignored; page context already registered");
    }
    const instanceOptions = {
      redactedQueryParams,
      // Spread last: the caller's attributes win.
      resourceAttributes: {
        [ATTR_TELEMETRY_DISTRO_NAME]: "@microsoft/opentelemetry-browser",
        [ATTR_TELEMETRY_DISTRO_VERSION]: OPENTELEMETRY_BROWSER_VERSION,
        ...options.resource?.attributes,
      },
      sampler,
      // An empty list turns the signal off. Otherwise enrichment runs first.
      spanProcessors: spanProcessors.length ? [contextSpanProcessor, ...spanProcessors] : [],
      logRecordProcessors: logRecordProcessors.length
        ? [contextLogRecordProcessor, ...(correlation ? [correlation] : []), ...logRecordProcessors]
        : [],
      contextManager: traceOptions?.contextManager,
      correlation,
      propagators: traceOptions?.propagators,
    };
    // Ownership transfers on call, including failed startup.
    processorsTransferred = true;
    instance = await startTelemetryInstance(instanceOptions);
    // Warn only once the instance has installed the console diagnostic logger.
    startAzureMonitorDiagnostics?.();
    if (noDestination) {
      diag.warn(
        "No telemetry destination: set azureMonitor, spanProcessors or logRecordProcessors",
      );
    }
    instrumentationRegistry = createInstrumentationRegistry(
      instrumentations,
      instance,
      spanProcessors.length !== 0,
      () => stopping,
    );
    removeUnloadSubscription = subscribeToUnload(flushForUnload);
    instrumentationRegistry.enable();
    if (syncOptions) {
      const adapter = createConfigurationSync(syncOptions, configuration);
      configSync = adapter.handle;
      Object.defineProperty(handle, "configSync", { value: configSync, enumerable: true });
      adapter.start();
    }
    instance.commit();
    initialized = true;
    pageViewInstrumentation?.commitStartup();
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      reportError("Telemetry initialization cleanup failed", cleanupError);
    }
    throw error;
  }

  return handle;
}
