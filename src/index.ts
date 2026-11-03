// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Only the page-view instrumentation's configuration is public. The class itself is not exported
// because `InstrumentationBase` pulls in `@opentelemetry/api`, whose global registration is a
// module side effect that cannot be tree-shaken, so exporting it here would add it to every
// consumer's bundle whether or not they use page views. Its supporting types are internal:
// nothing a consumer can reach today needs them, and exporting them would freeze a provisional
// surface. Widen deliberately if that changes.
export type { PageViewInstrumentationConfig } from "./instrumentation/pageView/types.js";
export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export {
  BrowserDetector,
  browserDetector,
  UserAgentDetector,
  userAgentDetector,
} from "./resource/index.js";
export type { AzureMonitorOptions } from "./exporter/base.js";
export type { AzureMonitorSdkStatsOptions } from "./exporter/customerSdkStats.js";
export type {
  MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  MicrosoftOpenTelemetryBrowserConfigurationUpdateResult,
} from "./configuration/runtimeConfiguration.js";
export { AzureMonitorLogRecordExporter } from "./exporter/log.js";
export { AzureMonitorSpanExporter } from "./exporter/trace.js";
export type {
  BrowserInstrumentation,
  MicrosoftOpenTelemetryBrowserConfigurationSync,
  MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserInstrumentations,
  MicrosoftOpenTelemetryBrowserOptions,
  MicrosoftOpenTelemetryBrowserSessionOptions,
  MicrosoftOpenTelemetryBrowserTraceOptions,
  MicrosoftOpenTelemetryBrowserUserContext,
} from "./types.js";
export { useMicrosoftOpenTelemetry } from "./useMicrosoftOpenTelemetry.js";
