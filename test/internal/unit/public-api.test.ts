// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ContextManager, TextMapPropagator } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { SessionManagerConfig } from "@opentelemetry/browser-sdk/session";
import { expectTypeOf, it } from "vitest";
import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  type MicrosoftOpenTelemetryBrowserConfigurationSync,
  type MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdateResult,
  type MicrosoftOpenTelemetryBrowserInstrumentations,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserSessionOptions,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
  type MicrosoftOpenTelemetryBrowserUserContext,
  type PageViewInstrumentationConfig,
} from "../../../src/index.js";

it("exposes distro-owned configuration and lifecycle contracts", () => {
  expectTypeOf(useMicrosoftOpenTelemetry)
    .parameter(0)
    .toEqualTypeOf<MicrosoftOpenTelemetryBrowserOptions | undefined>();
  expectTypeOf(useMicrosoftOpenTelemetry).returns.toEqualTypeOf<
    Promise<MicrosoftOpenTelemetryBrowser>
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    | "resource"
    | "samplingPercentage"
    | "azureMonitor"
    | "spanProcessors"
    | "logRecordProcessors"
    | "instrumentations"
    | "pageView"
    | "session"
    | "sessionRenewalMs"
    | "sessionExpirationMs"
    | "storage"
    | "userContext"
    | "traces"
    | "redactQueryParams"
    | "extensionConfig"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["redactQueryParams"]>().toEqualTypeOf<
    readonly string[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["resource"]>().toEqualTypeOf<
    Resource | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["traces"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserTraceOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["contextManager"]>().toEqualTypeOf<
    ContextManager | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions["propagators"]>().toEqualTypeOf<
    readonly TextMapPropagator[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["session"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserSessionOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["sessionRenewalMs"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["sessionExpirationMs"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<
    Pick<MicrosoftOpenTelemetryBrowserOptions, "sessionRenewalMs" | "sessionExpirationMs">
  >().toEqualTypeOf<{
    sessionRenewalMs?: number | undefined;
    sessionExpirationMs?: number | undefined;
  }>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["userContext"]>().toEqualTypeOf<
    { enabled?: boolean } | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["storage"]>().toEqualTypeOf<
    { enabled?: boolean; namePrefix?: string } | undefined
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserSessionOptions>().toEqualTypeOf<
    "enabled" | "persist" | "inactivityTimeout" | "maxDuration"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserSessionOptions>().toEqualTypeOf<{
    enabled?: boolean;
    persist?: boolean;
    inactivityTimeout?: number;
    maxDuration?: number;
  }>();
  expectTypeOf<
    Pick<MicrosoftOpenTelemetryBrowserSessionOptions, "inactivityTimeout" | "maxDuration">
  >().toEqualTypeOf<Pick<SessionManagerConfig, "inactivityTimeout" | "maxDuration">>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["azureMonitor"]>().toEqualTypeOf<
    AzureMonitorOptions<string | Promise<string>> | undefined
  >();
  expectTypeOf<keyof AzureMonitorOptions>().toEqualTypeOf<
    "connectionString" | "disableBeacon" | "sdkStats" | "initTimeOut" | "initInMemoMaxSize"
  >();
  expectTypeOf<Pick<AzureMonitorOptions, "disableBeacon">>().toEqualTypeOf<{
    readonly disableBeacon?: boolean;
  }>();
  expectTypeOf<AzureMonitorOptions["connectionString"]>().toEqualTypeOf<string>();
  expectTypeOf<AzureMonitorOptions<Promise<string>>["connectionString"]>().toEqualTypeOf<
    Promise<string>
  >();
  expectTypeOf(AzureMonitorSpanExporter).constructorParameters.toEqualTypeOf<
    [options: AzureMonitorOptions]
  >();
  expectTypeOf(AzureMonitorLogRecordExporter).constructorParameters.toEqualTypeOf<
    [options: AzureMonitorOptions]
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["spanProcessors"]>().toEqualTypeOf<
    SpanProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["logRecordProcessors"]>().toEqualTypeOf<
    LogRecordProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["instrumentations"]>().toEqualTypeOf<
    readonly BrowserInstrumentation[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["pageView"]>().toEqualTypeOf<
    PageViewInstrumentationConfig | undefined
  >();
  expectTypeOf<Instrumentation>().toExtend<BrowserInstrumentation>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser["forceFlush"]>().toEqualTypeOf<() => Promise<void>>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser["configSync"]>().toEqualTypeOf<
    MicrosoftOpenTelemetryBrowserConfigurationSync | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserConfigurationSyncOptions["syncMode"]>().toEqualTypeOf<
    0 | 1 | 2 | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserConfigurationSync["sync"]>().toEqualTypeOf<
    () => Promise<void>
  >();
  expectTypeOf<
    MicrosoftOpenTelemetryBrowser["instrumentations"]
  >().toEqualTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations["get"]>().toEqualTypeOf<
    (id: string) => BrowserInstrumentation | undefined
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserInstrumentations>().toEqualTypeOf<
    "get" | "setEnabled" | "add" | "remove" | "replace"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations["add"]>().toEqualTypeOf<
    (id: string, instrumentation: BrowserInstrumentation) => Promise<void>
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations["replace"]>().toEqualTypeOf<
    (id: string, instrumentation: BrowserInstrumentation) => Promise<void>
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations["remove"]>().toEqualTypeOf<
    (id: string) => Promise<void>
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserInstrumentations["setEnabled"]>().toEqualTypeOf<
    (id: string, enabled: boolean) => Promise<void>
  >();
  expectTypeOf<
    MicrosoftOpenTelemetryBrowser["userContext"]
  >().toEqualTypeOf<MicrosoftOpenTelemetryBrowserUserContext>();
});

it("exposes sampling, session lifetime and unload beacon runtime updates", () => {
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowser>().toEqualTypeOf<
    "updateCfg" | "instrumentations" | "userContext" | "forceFlush" | "shutdown" | "configSync"
  >();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserConfigurationUpdate>().toEqualTypeOf<
    | "samplingPercentage"
    | "session"
    | "sessionRenewalMs"
    | "sessionExpirationMs"
    | "azureMonitor"
    | "onunloadDisableBeacon"
    | "disableFetchTracking"
    | "disableAjaxTracking"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserConfigurationUpdate>().toEqualTypeOf<{
    samplingPercentage?: number | undefined;
    session?:
      | {
          inactivityTimeout?: number | undefined;
          maxDuration?: number | undefined;
        }
      | undefined;
    sessionRenewalMs?: number | undefined;
    sessionExpirationMs?: number | undefined;
    azureMonitor?: { disableBeacon?: boolean | undefined } | undefined;
    onunloadDisableBeacon?: boolean | undefined;
    disableFetchTracking?: boolean | undefined;
    disableAjaxTracking?: boolean | undefined;
  }>();
  expectTypeOf<
    keyof NonNullable<MicrosoftOpenTelemetryBrowserConfigurationUpdate["session"]>
  >().toEqualTypeOf<"inactivityTimeout" | "maxDuration">();
  expectTypeOf<
    keyof NonNullable<MicrosoftOpenTelemetryBrowserConfigurationUpdate["azureMonitor"]>
  >().toEqualTypeOf<"disableBeacon">();
  expectTypeOf<MicrosoftOpenTelemetryBrowser["updateCfg"]>().toEqualTypeOf<
    (
      patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
      mergeExisting?: boolean,
    ) => Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult>
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult>().toEqualTypeOf<{
    readonly revision: number;
    readonly changedPaths: readonly string[];
  }>();
});
