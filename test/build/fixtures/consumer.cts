import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationSync,
  type MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  type MicrosoftOpenTelemetryBrowserInstrumentations,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
import type { AzureMonitorSdkStatsOptions } from "@microsoft/opentelemetry-browser";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

export const options: AzureMonitorOptions = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  sdkStats: { enabled: true } satisfies AzureMonitorSdkStatsOptions,
};
new AzureMonitorSpanExporter(options);
new AzureMonitorLogRecordExporter(options);
const asynchronousOptions: AzureMonitorOptions<Promise<string>> = {
  connectionString: Promise.resolve(options.connectionString),
};
useMicrosoftOpenTelemetry({ azureMonitor: options });
useMicrosoftOpenTelemetry({ azureMonitor: asynchronousOptions });
const syncOptions: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = {
  syncMode: 2,
  nonOverrideConfigs: { disableAjaxTracking: true },
};
useMicrosoftOpenTelemetry({ extensionConfig: { AppInsightsCfgSyncPlugin: syncOptions } });
useMicrosoftOpenTelemetry({ extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 0 } } });
// @ts-expect-error Synchronization modes are numeric, not strings.
const invalidSyncMode: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = { syncMode: "1" };
const invalidSyncExclusion: MicrosoftOpenTelemetryBrowserConfigurationSyncOptions = {
  // @ts-expect-error User configuration is not synchronizable.
  nonOverrideConfigs: { user: true },
};
void invalidSyncMode;
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
  if (syncOptions.nonOverrideConfigs) {
    // @ts-expect-error Exclusions are readonly.
    syncOptions.nonOverrideConfigs.disableAjaxTracking = false;
  }
}
const connectionString = options.connectionString;
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

useMicrosoftOpenTelemetry({ sessionRenewalMs: 60000, sessionExpirationMs: 120000 });
useMicrosoftOpenTelemetry({ sessionRenewalMs: undefined, sessionExpirationMs: undefined });
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: 60, maxDuration: 120 } });
// @ts-expect-error Native initializer inactivity timeouts do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: undefined } });
// @ts-expect-error Native initializer maximum durations do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { maxDuration: undefined } });
// @ts-expect-error Initializer renewal aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionRenewalMs: "60000" });
// @ts-expect-error Initializer expiration aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionExpirationMs: "120000" });

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
): Promise<import("@microsoft/opentelemetry-browser").BrowserInstrumentation | undefined> {
  const controls: MicrosoftOpenTelemetryBrowserInstrumentations = handle.instrumentations;
  const found = controls.get("fetch");
  await controls.setEnabled("fetch", false);
  await controls.setEnabled("fetch", true);
  const [instrumentation] = await getInstrumentations({ errors: { enabled: true } });
  await controls.add("additional", instrumentation);
  await controls.replace("additional", instrumentation);
  await controls.remove("additional");
  // @ts-expect-error Runtime additions require an explicit ID and instrumentation object.
  controls.add({});
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
  options.disableBeacon = true;
}
