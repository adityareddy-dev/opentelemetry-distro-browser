import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationSync,
  type MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  type MicrosoftOpenTelemetryBrowserInstrumentations,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserSessionOptions,
} from "@microsoft/opentelemetry-browser";
import type { AzureMonitorSdkStatsOptions } from "@microsoft/opentelemetry-browser";
import { getSdkLoaderScript } from "@microsoft/opentelemetry-browser/snippet";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
export const session: MicrosoftOpenTelemetryBrowserSessionOptions = {
  enabled: true,
  persist: false,
  inactivityTimeout: 1800,
  maxDuration: 86400,
};
const headers = { "x-tenant": "consumer" };
export const instrumentation: BrowserInstrumentation = {
  setTracerProvider(provider) {
    provider.getTracer("consumer");
  },
  setLoggerProvider(provider) {
    provider.getLogger("consumer");
  },
  getConfig() {
    return { enabled: false };
  },
  enable() {},
  disable() {},
};
export const options: MicrosoftOpenTelemetryBrowserOptions = {
  samplingPercentage: 25,
  session,
  instrumentations: Object.freeze([instrumentation]),
  resource: resourceFromAttributes({
    "service.name": "consumer",
    "service.version": "1.0.0",
    "deployment.environment.name": "production",
    "custom.tenant.id": "consumer",
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "https://example.test/v1/traces", headers }),
    ),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: "https://example.test/v1/logs", headers }),
    }),
  ],
};
const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";
export const azureMonitorOptions: MicrosoftOpenTelemetryBrowserOptions = {
  azureMonitor: {
    connectionString,
    sdkStats: {
      enabled: true,
      collectionIntervalMillis: 900000,
    } satisfies AzureMonitorSdkStatsOptions,
  },
};
getSdkLoaderScript({
  connectionString,
  // @ts-expect-error Customer SDK Stats is npm-only, not a loader option.
  azureMonitor: { sdkStats: { enabled: true } },
});
useMicrosoftOpenTelemetry({
  // @ts-expect-error Customer stats cannot override Microsoft's internal destination.
  azureMonitor: { connectionString, sdkStats: { endpoint: "https://example.test" } },
});
// An explicitly annotated pre-existing exporter configuration remains accepted.
const synchronousOptions: AzureMonitorOptions = { connectionString };
new AzureMonitorSpanExporter(synchronousOptions);
new AzureMonitorLogRecordExporter(synchronousOptions);
const asynchronousOptions: AzureMonitorOptions<Promise<string>> = {
  connectionString: Promise.resolve(connectionString),
};
useMicrosoftOpenTelemetry({ azureMonitor: synchronousOptions });
useMicrosoftOpenTelemetry({ azureMonitor: asynchronousOptions });
useMicrosoftOpenTelemetry({ azureMonitor: { connectionString, disableBeacon: true } });
// @ts-expect-error Network tracking gates are runtime-only.
useMicrosoftOpenTelemetry({ disableFetchTracking: true });
// @ts-expect-error Network tracking gates are runtime-only.
useMicrosoftOpenTelemetry({ disableAjaxTracking: false });
// @ts-expect-error The unload-beacon alias is runtime-only.
useMicrosoftOpenTelemetry({ onunloadDisableBeacon: true });
// @ts-expect-error The unload-beacon alias is runtime-only.
useMicrosoftOpenTelemetry({ onunloadDisableBeacon: false });
// @ts-expect-error The unload-beacon alias is runtime-only, including explicit undefined.
useMicrosoftOpenTelemetry({ onunloadDisableBeacon: undefined });
const invalidStartupBeaconReset: MicrosoftOpenTelemetryBrowserOptions = {
  // @ts-expect-error Typed initialization options must use azureMonitor.disableBeacon.
  onunloadDisableBeacon: undefined,
};
void invalidStartupBeaconReset;
// @ts-expect-error The unload-beacon alias is runtime-only.
useMicrosoftOpenTelemetry({ onunloadDisableBeacon: "true" });
// @ts-expect-error Standalone exporter options retain exact optional boolean semantics.
const _invalidBeaconOptions: AzureMonitorOptions = { connectionString, disableBeacon: undefined };
// @ts-expect-error Startup native beacon options retain exact optional boolean semantics.
useMicrosoftOpenTelemetry({ azureMonitor: { connectionString, disableBeacon: undefined } });
// @ts-expect-error Standalone trace exporters require a resolved connection string.
new AzureMonitorSpanExporter(asynchronousOptions);
// @ts-expect-error Standalone log exporters require a resolved connection string.
new AzureMonitorLogRecordExporter(asynchronousOptions);
useMicrosoftOpenTelemetry({ azureMonitor: { connectionString, sdkStats: {} } });
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => Promise<MicrosoftOpenTelemetryBrowser> = useMicrosoftOpenTelemetry;
const syncOptions: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = {
  syncMode: 1,
  customEvtName: "consumer-config",
  nonOverrideConfigs: { samplingPercentage: true, disableFetchTracking: false },
  onError: (error): void => {
    const cause: unknown = error;
    // @ts-expect-error Error callbacks receive an unknown value.
    const message: string = error;
    void cause;
    void message;
  },
};
useMicrosoftOpenTelemetry({ extensionConfig: { AppInsightsCfgSyncPlugin: {} } });
useMicrosoftOpenTelemetry({ extensionConfig: { AppInsightsCfgSyncPlugin: syncOptions } });
// @ts-expect-error Only the three event synchronization modes are supported.
const invalidSyncMode: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = { syncMode: 3 };
const invalidSyncUrl: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = {
  // @ts-expect-error HTTP configuration is not supported.
  cfgUrl: "https://example.test",
};
const invalidSyncExclusion: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = {
  // @ts-expect-error Resource configuration is not synchronizable.
  nonOverrideConfigs: { resource: true },
};
void invalidSyncMode;
void invalidSyncUrl;
void invalidSyncExclusion;

export function controlConfigSync(handle: MicrosoftOpenTelemetryBrowser): void {
  if (handle.configSync) {
    const controls: MicrosoftOpenTelemetryBrowserConfigurationSync = handle.configSync;
    const synced: Promise<void> = controls.sync();
    const paused: void = controls.pause();
    const resumed: void = controls.resume();
    const stopped: void = controls.shutdown();
    void [synced, paused, resumed, stopped];
    // @ts-expect-error Configuration synchronization controls are readonly on the handle.
    handle.configSync = controls;
  }
}
// @ts-expect-error The previous distribution-specific option is no longer supported.
useMicrosoftOpenTelemetry({ samplingRatio: 1 });
// @ts-expect-error Service configuration goes through the resource option, not serviceName.
useMicrosoftOpenTelemetry({ serviceName: "consumer" });
// @ts-expect-error Upstream SDK controls are not exposed by the distro.
useMicrosoftOpenTelemetry({ disabled: true });
useMicrosoftOpenTelemetry({ session: { enabled: false } });
useMicrosoftOpenTelemetry({ session: { enabled: true, inactivityTimeout: 60 } });
useMicrosoftOpenTelemetry({ sessionRenewalMs: 60000, sessionExpirationMs: 120000 });
useMicrosoftOpenTelemetry({ sessionRenewalMs: undefined, sessionExpirationMs: undefined });
// @ts-expect-error Native initializer inactivity timeouts do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: undefined } });
// @ts-expect-error Native initializer maximum durations do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { maxDuration: undefined } });
// @ts-expect-error Initializer renewal aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionRenewalMs: "60000" });
// @ts-expect-error Initializer expiration aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionExpirationMs: "120000" });
// @ts-expect-error Session timeouts use seconds as numbers.
useMicrosoftOpenTelemetry({ session: { maxDuration: "86400" } });
// @ts-expect-error Persistence consent is a boolean.
useMicrosoftOpenTelemetry({ session: { persist: "false" } });
// @ts-expect-error Configure exporters through standard processors, not distro-specific options.
useMicrosoftOpenTelemetry({ otlp: { endpoint: "https://example.test" } });
// @ts-expect-error Configure exporters through standard processors, not upstream exportConfig.
useMicrosoftOpenTelemetry({ exportConfig: { url: "https://example.test" } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ traces: { processors: [] } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ logs: { processors: [] } });
// @ts-expect-error Azure Monitor connection strings belong to its exporters, not the initializer.
useMicrosoftOpenTelemetry({ connectionString: "InstrumentationKey=00000000" });

export async function updateSampling(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    samplingPercentage: undefined,
  };
  await handle.updateCfg({});
  await handle.updateCfg({ samplingPercentage: 25 });
  await handle.updateCfg({ samplingPercentage: undefined });
  await handle.updateCfg(reset);
}

export async function controlInstrumentations(
  handle: MicrosoftOpenTelemetryBrowser,
): Promise<BrowserInstrumentation | undefined> {
  const controls: MicrosoftOpenTelemetryBrowserInstrumentations = handle.instrumentations;
  const found = controls.get("fetch");
  await controls.setEnabled("fetch", false);
  await controls.setEnabled("fetch", true);
  await controls.add("additional", instrumentation);
  await controls.replace("additional", instrumentation);
  await controls.remove("additional");
  // @ts-expect-error Runtime additions require an explicit ID and instrumentation object.
  controls.add(instrumentation);
  // @ts-expect-error Runtime replacement requires an instrumentation object.
  controls.replace("fetch", {});
  // @ts-expect-error The handle instrumentation controls cannot be replaced.
  handle.instrumentations = controls;
  return found;
}

export async function updateNetworkGates(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  await handle.updateCfg({ disableFetchTracking: true, disableAjaxTracking: false });
  await handle.updateCfg({ disableFetchTracking: undefined, disableAjaxTracking: undefined });
  // @ts-expect-error Runtime fetch tracking gates require booleans.
  await handle.updateCfg({ disableFetchTracking: "true" });
  // @ts-expect-error Runtime XHR tracking gates require booleans.
  await handle.updateCfg({ disableAjaxTracking: 0 });
  // @ts-expect-error Instrumentation lists are startup-only.
  await handle.updateCfg({ instrumentations: [] });
}

export async function updateSessionLifetimes(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    session: { inactivityTimeout: undefined, maxDuration: undefined },
    sessionRenewalMs: undefined,
    sessionExpirationMs: undefined,
  };
  await handle.updateCfg(reset);
  await handle.updateCfg({ session: undefined });
  await handle.updateCfg({ session: {} });
  await handle.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } });
  await handle.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: 0 });
  await handle.updateCfg({ session: { inactivityTimeout: undefined } });
  await handle.updateCfg({ session: { maxDuration: undefined } });
  await handle.updateCfg({ sessionRenewalMs: undefined });
  await handle.updateCfg({ sessionExpirationMs: undefined });
  await handle.updateCfg(
    { samplingPercentage: 25, sessionRenewalMs: 60000, sessionExpirationMs: 120000 },
    false,
  );
  // @ts-expect-error Runtime inactivity timeouts use seconds as numbers.
  await handle.updateCfg({ session: { inactivityTimeout: "60" } });
  // @ts-expect-error Runtime maximum durations use seconds as numbers.
  await handle.updateCfg({ session: { maxDuration: "120" } });
  // @ts-expect-error Runtime renewal aliases use milliseconds as numbers.
  await handle.updateCfg({ sessionRenewalMs: "60000" });
  // @ts-expect-error Runtime expiration aliases use milliseconds as numbers.
  await handle.updateCfg({ sessionExpirationMs: "120000" });
  // @ts-expect-error Session enablement is startup-only.
  await handle.updateCfg({ session: { enabled: false } });
  // @ts-expect-error Session persistence is startup-only.
  await handle.updateCfg({ session: { persist: false } });
  // @ts-expect-error Browser storage is startup-only.
  await handle.updateCfg({ storage: { enabled: false } });
}

export async function updateUnloadBeacon(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const aliasReset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    onunloadDisableBeacon: undefined,
  };
  const nativeReset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    azureMonitor: { disableBeacon: undefined },
  };
  const outerReset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    azureMonitor: undefined,
  };
  await handle.updateCfg({ azureMonitor: {} });
  await handle.updateCfg({ azureMonitor: { disableBeacon: true } });
  await handle.updateCfg({ azureMonitor: { disableBeacon: false } });
  await handle.updateCfg({ onunloadDisableBeacon: true });
  await handle.updateCfg({ onunloadDisableBeacon: false });
  await handle.updateCfg({ onunloadDisableBeacon: undefined });
  await handle.updateCfg({ azureMonitor: { disableBeacon: undefined } });
  await handle.updateCfg({ azureMonitor: undefined });
  await handle.updateCfg(aliasReset);
  await handle.updateCfg(nativeReset);
  await handle.updateCfg(outerReset);
  await handle.updateCfg({ azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: true });
  await handle.updateCfg(
    { samplingPercentage: 25, sessionRenewalMs: 60000, onunloadDisableBeacon: true },
    false,
  );
  // @ts-expect-error The runtime unload-beacon alias requires a boolean.
  await handle.updateCfg({ onunloadDisableBeacon: "false" });
  // @ts-expect-error The runtime native beacon policy requires a boolean.
  await handle.updateCfg({ azureMonitor: { disableBeacon: 1 } });
  // @ts-expect-error Runtime Azure Monitor destination mutation is not supported.
  await handle.updateCfg({ azureMonitor: { connectionString } });
  // @ts-expect-error Unsupported destination fields cannot be reset with undefined.
  await handle.updateCfg({ azureMonitor: { connectionString: undefined } });
  // @ts-expect-error Standalone exporter options remain readonly.
  synchronousOptions.disableBeacon = true;
}

export async function shutdown(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  await handle.forceFlush();
  await handle.shutdown();
}
