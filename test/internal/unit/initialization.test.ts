// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  SpanKind,
  context,
  diag,
  propagation,
  trace,
  type ContextManager,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
import { BrowserBatchLogRecordProcessor } from "../../../src/browserBatchLogRecordProcessor.js";
import { BatchSpanProcessor, SamplingDecision } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  browserDetector,
  OPENTELEMETRY_BROWSER_VERSION,
  userAgentDetector,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { isUnloading } from "../../../src/exporter/common.js";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/index.js";
import { noopLoggerProvider, noopTracerProvider } from "../../../src/routing/instanceRouter.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import { getRegisteredGlobal, getSharedRegistry } from "../../../src/shared/globalOwnership.js";
import { DEFAULT_QUERY_STRINGS_TO_REDACT } from "../../../src/shared/urlRedaction.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";
import { AZURE_MONITOR_SAMPLE_RATE, RuntimeSampler } from "../../../src/sampling.js";
import { AzureMonitorSamplingLogRecordProcessor } from "../../../src/samplingLogRecordProcessor.js";

vi.mock("../../../src/routing/telemetryInstance.js", { spy: true });

const handles = new Set<MicrosoftOpenTelemetryBrowser>();
const azureMonitor = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
};

/** Stands in for an instance's providers so a test controls their shutdown. */
function fakeInstance() {
  return {
    tracerProvider: noopTracerProvider,
    loggerProvider: noopLoggerProvider,
    commit: vi.fn(),
    abort: vi.fn(),
    detach: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.mocked(startTelemetryInstance).mockClear();
});

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  // Upstream shutdown does not unregister globals; isolate tests explicitly.
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

it("prepends session enrichment without changing the caller's processor arrays", async () => {
  const pipeline = createInMemoryPipeline();
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    ...pipeline.options,
    session: { enabled: true },
    pageView: { enabled: false },
  };
  Object.freeze(options.spanProcessors);
  Object.freeze(options.logRecordProcessors);
  const upstreamHandle = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(upstreamHandle);

  const handle = await useMicrosoftOpenTelemetry(Object.freeze(options));
  handles.add(handle);
  expect(startTelemetryInstance).toHaveBeenCalledExactlyOnceWith({
    redactedQueryParams: DEFAULT_QUERY_STRINGS_TO_REDACT,
    resourceAttributes: {
      "telemetry.distro.name": "@microsoft/opentelemetry-browser",
      "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
    },
    sampler: expect.any(RuntimeSampler),
    spanProcessors: [
      expect.objectContaining({ onStart: expect.any(Function) }),
      pipeline.spanProcessor,
    ],
    logRecordProcessors: [
      expect.objectContaining({ onEmit: expect.any(Function) }),
      pipeline.logProcessor,
    ],
    contextManager: undefined,
    correlation: undefined,
    propagators: undefined,
  });
  expect(options.spanProcessors).toEqual([pipeline.spanProcessor]);
  expect(options.logRecordProcessors).toEqual([pipeline.logProcessor]);
  await handle.forceFlush();
  await handle.shutdown();
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("adds Azure Monitor batch exporters after context enrichment and caller processors", async () => {
  const pipeline = createInMemoryPipeline();
  const upstreamHandle = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(upstreamHandle);
  const addDocumentListener = vi.spyOn(document, "addEventListener");

  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test",
    },
    session: { enabled: true },
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: pipeline.options.logRecordProcessors,
    pageView: { enabled: false },
  });
  handles.add(handle);

  expect(startTelemetryInstance).toHaveBeenCalledOnce();
  const sdkOptions = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0];
  if (!sdkOptions) throw new Error("Expected telemetry instance options");
  expect(sdkOptions.spanProcessors).toHaveLength(3);
  expect(sdkOptions.spanProcessors[0]).toEqual(
    expect.objectContaining({ onStart: expect.any(Function) }),
  );
  expect(sdkOptions.spanProcessors[1]).toBe(pipeline.spanProcessor);
  expect(sdkOptions.spanProcessors[2]).toBeInstanceOf(BatchSpanProcessor);
  expect(sdkOptions.logRecordProcessors).toHaveLength(3);
  expect(sdkOptions.logRecordProcessors[0]).toEqual(
    expect.objectContaining({ onEmit: expect.any(Function) }),
  );
  expect(sdkOptions.logRecordProcessors[1]).toBe(pipeline.logProcessor);
  expect(sdkOptions.logRecordProcessors[2]).toBeInstanceOf(BrowserBatchLogRecordProcessor);
  expect(sdkOptions.logRecordProcessors[2]).toBeInstanceOf(AzureMonitorSamplingLogRecordProcessor);
  expect(
    addDocumentListener.mock.calls.filter(([eventName]) => eventName === "visibilitychange"),
  ).toHaveLength(1);

  await handle.shutdown();
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("honors an inherited startup sampling getter and captures its value once", async () => {
  const read = vi.fn(() => 0);
  class Options {
    get samplingPercentage() {
      return read();
    }
    pageView = { enabled: false };
    session = { enabled: false };
    userContext = { enabled: false };
  }
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
  const handle = await useMicrosoftOpenTelemetry(new Options());
  handles.add(handle);
  const sampler = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0].sampler;
  if (!sampler) throw new Error("Expected telemetry instance sampler");
  expect(read).toHaveBeenCalledOnce();
  const sample = () =>
    sampler.shouldSample(
      ROOT_CONTEXT,
      "00000000000000000000000000000001",
      "operation",
      SpanKind.INTERNAL,
      {},
      [],
    );
  expect(sample().decision).toBe(SamplingDecision.NOT_RECORD);
  await handle.updateCfg({ samplingPercentage: 100 });
  expect(sample().decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  expect(read).toHaveBeenCalledOnce();
});

it.each([undefined, {}, { AppInsightsCfgSyncPlugin: undefined }])(
  "does not install configuration sync without opt-in: %j",
  async (extensionConfig) => {
    const addListener = vi.spyOn(globalThis, "addEventListener");
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
    const handle = await useMicrosoftOpenTelemetry({
      extensionConfig,
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
      storage: { enabled: false },
    });
    handles.add(handle);

    expect(Object.hasOwn(handle, "configSync")).toBe(false);
    expect(handle.configSync).toBeUndefined();
    expect(addListener.mock.calls.filter(([name]) => name === "ai_cfgsync")).toHaveLength(0);
  },
);

it.each(["inherited", "own undefined", "omitted"] as const)(
  "protects startup sampling from sync only when supplied: %s",
  async (kind) => {
    const options: MicrosoftOpenTelemetryBrowserOptions = {
      extensionConfig: { AppInsightsCfgSyncPlugin: {} },
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
      storage: { enabled: false },
    };
    if (kind === "inherited") Object.setPrototypeOf(options, { samplingPercentage: 0 });
    if (kind === "own undefined") options.samplingPercentage = undefined;
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    expect(Object.hasOwn(handle, "configSync")).toBe(true);
    expect(handle.configSync).toBeDefined();
    const sampler = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0].sampler;
    if (!sampler) throw new Error("Expected telemetry instance sampler");
    const sample = () =>
      sampler.shouldSample(
        ROOT_CONTEXT,
        "00000000000000000000000000000001",
        "operation",
        SpanKind.INTERNAL,
        {},
        [],
      ).decision;
    expect(sample()).toBe(
      kind === "inherited" ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
    );

    globalThis.dispatchEvent(
      new CustomEvent("ai_cfgsync", {
        detail: { cfg: { samplingPercentage: kind === "inherited" ? 100 : 0 } },
      }),
    );
    await handle.updateCfg({});
    expect(sample()).toBe(
      kind === "own undefined" ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
    );
  },
);

it("reads the startup extension getter once and does not broadcast automatically", async () => {
  const read = vi.fn(() => {
    if (read.mock.calls.length > 1) throw new Error("extensionConfig read twice");
    return { AppInsightsCfgSyncPlugin: { syncMode: 1 as const } };
  });
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    pageView: { enabled: false },
    session: { enabled: false },
    userContext: { enabled: false },
    storage: { enabled: false },
  };
  Object.defineProperty(options, "extensionConfig", { enumerable: true, get: read });
  const dispatch = vi.spyOn(globalThis, "dispatchEvent");
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
  const handle = await useMicrosoftOpenTelemetry(options);
  handles.add(handle);

  expect(read).toHaveBeenCalledOnce();
  expect(handle.configSync).toBeDefined();
  expect(dispatch.mock.calls.filter(([event]) => event.type === "ai_cfgsync")).toHaveLength(0);
  await handle.configSync!.sync();
  expect(dispatch.mock.calls.filter(([event]) => event.type === "ai_cfgsync")).toHaveLength(1);
  expect(read).toHaveBeenCalledOnce();
});

it("rejects nested sync option accessors before SDK startup or storage access", async () => {
  const getter = vi.fn(() => 2);
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const addListener = vi.spyOn(globalThis, "addEventListener");
  for (const extensionConfig of [
    Object.defineProperty({}, "AppInsightsCfgSyncPlugin", { get: getter }),
    { AppInsightsCfgSyncPlugin: Object.defineProperty({}, "syncMode", { get: getter }) },
    {
      AppInsightsCfgSyncPlugin: {
        nonOverrideConfigs: Object.defineProperty({}, "samplingPercentage", { get: getter }),
      },
    },
  ]) {
    await expect(useMicrosoftOpenTelemetry({ extensionConfig })).rejects.toThrow(TypeError);
  }
  expect(getter).not.toHaveBeenCalled();
  expect(startTelemetryInstance).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  expect(addListener).not.toHaveBeenCalled();
});

it.each(["fake", "real"] as const)(
  "rolls back %s startup when sync listener registration throws after installation",
  async (kind) => {
    const upstream = fakeInstance();
    if (kind === "fake") vi.mocked(startTelemetryInstance).mockResolvedValueOnce(upstream);
    const pipeline = createInMemoryPipeline();
    const instrumentation = {
      setTracerProvider: vi.fn(),
      getConfig: vi.fn(() => ({ enabled: false })),
      enable: vi.fn(),
      disable: vi.fn(),
    };
    const commitPageView = vi.spyOn(PageViewInstrumentation.prototype, "commitStartup");
    const rollbackPageView = vi.spyOn(PageViewInstrumentation.prototype, "rollbackStartup");
    const globals = (["trace", "logs", "context", "propagation"] as const).map((name) =>
      getRegisteredGlobal(name),
    );
    const failure = new Error("listener registration failed");
    const nativeAdd = globalThis.addEventListener.bind(globalThis);
    const nativeRemove = globalThis.removeEventListener.bind(globalThis);
    let installed: EventListenerOrEventListenerObject | null = null;
    let removals = 0;
    vi.spyOn(globalThis, "removeEventListener").mockImplementation((name, listener, options) => {
      if (name === "ai_cfgsync" && listener === installed) {
        removals++;
        if (removals === 1) throw new Error("first removal failed");
      }
      nativeRemove(name, listener, options);
    });
    vi.spyOn(globalThis, "addEventListener").mockImplementation((name, listener, options) => {
      nativeAdd(name, listener, options);
      if (name === "ai_cfgsync") {
        installed = listener;
        expect(instrumentation.enable).toHaveBeenCalledOnce();
        expect(upstream.commit).not.toHaveBeenCalled();
        expect(commitPageView).not.toHaveBeenCalled();
        globalThis.dispatchEvent(
          new CustomEvent(name, { detail: { cfg: { samplingPercentage: 0 } } }),
        );
        throw failure;
      }
    });

    await expect(
      useMicrosoftOpenTelemetry({
        ...pipeline.options,
        extensionConfig: { AppInsightsCfgSyncPlugin: {} },
        instrumentations: [instrumentation],
        session: { enabled: false },
        userContext: { enabled: false },
        storage: { enabled: false },
      }),
    ).rejects.toBe(failure);
    expect(installed).not.toBeNull();
    expect(removals).toBe(2);
    expect(instrumentation.disable).toHaveBeenCalledOnce();
    expect(commitPageView).not.toHaveBeenCalled();
    expect(rollbackPageView).toHaveBeenCalledOnce();
    if (kind === "fake") {
      expect(upstream.commit).not.toHaveBeenCalled();
      expect(upstream.abort).toHaveBeenCalledOnce();
      expect(upstream.shutdown).toHaveBeenCalledOnce();
      await pipeline.shutdown();
    } else {
      expect(
        (["trace", "logs", "context", "propagation"] as const).map(getRegisteredGlobal),
      ).toEqual(globals);
    }
    const sampler = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0].sampler;
    if (!sampler) throw new Error("Expected telemetry instance sampler");
    expect(
      sampler.shouldSample(
        ROOT_CONTEXT,
        "00000000000000000000000000000001",
        "operation",
        SpanKind.INTERNAL,
        {},
        [],
      ).decision,
    ).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    const observed = vi.fn(() => []);
    const cfg = new Proxy({}, { ownKeys: observed });
    globalThis.dispatchEvent(new CustomEvent("ai_cfgsync", { detail: { cfg } }));
    expect(observed).not.toHaveBeenCalled();
  },
);

it("captures an enumerable startup beacon getter once", async () => {
  const read = vi.fn(() => true);
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    azureMonitor: { ...azureMonitor },
    session: { enabled: false },
    userContext: { enabled: false },
    storage: { enabled: false },
    pageView: { enabled: false },
  };
  Object.defineProperty(options.azureMonitor, "disableBeacon", { enumerable: true, get: read });
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
  const handle = await useMicrosoftOpenTelemetry(options);
  handles.add(handle);
  expect(await handle.updateCfg({ onunloadDisableBeacon: true })).toEqual({
    revision: 0,
    changedPaths: [],
  });
  expect(read).toHaveBeenCalledOnce();
  expect(startTelemetryInstance).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
  "ignores the runtime-only beacon alias at startup: %s",
  async (onunloadDisableBeacon) => {
    const options = {
      azureMonitor: { ...azureMonitor, disableBeacon: true },
      onunloadDisableBeacon,
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
      storage: { enabled: false },
    };
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    expect(await handle.updateCfg({ onunloadDisableBeacon: true })).toEqual({
      revision: 0,
      changedPaths: [],
    });
    expect(await handle.updateCfg({ onunloadDisableBeacon: false })).toEqual({
      revision: 1,
      changedPaths: ["azureMonitor.disableBeacon"],
    });
    expect(startTelemetryInstance).toHaveBeenCalledOnce();
  },
);

it.each(["true", null, 1])(
  "rejects invalid native beacon startup policy before side effects: %s",
  async (disableBeacon) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    await expect(
      useMicrosoftOpenTelemetry({
        azureMonitor: { ...azureMonitor, disableBeacon },
      } as unknown as MicrosoftOpenTelemetryBrowserOptions),
    ).rejects.toThrow();
    expect(startTelemetryInstance).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  },
);

it.each([undefined, 25])(
  "keeps a stable runtime sampler with initial percentage %s",
  async (samplingPercentage) => {
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());

    const handle = await useMicrosoftOpenTelemetry({
      samplingPercentage,
      azureMonitor: {
        connectionString:
          "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test",
      },
      pageView: { enabled: false },
    });
    handles.add(handle);

    const sdkOptions = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0];
    const sampler = sdkOptions?.sampler;
    if (!sampler) throw new Error("Expected telemetry instance sampler");
    expect(sampler).toBeInstanceOf(RuntimeSampler);
    expect(sdkOptions?.logRecordProcessors[1]).toBeInstanceOf(
      AzureMonitorSamplingLogRecordProcessor,
    );
    const sampledId = "00000000000000000000000000000001";
    const droppedId = "ffffffffffffffffffffffffffffffff";
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: sampledId,
      spanId: "0000000000000001",
      traceFlags: 0,
    });
    const sample = (traceId: string, parentContext = ROOT_CONTEXT) =>
      sampler.shouldSample(parentContext, traceId, "operation", SpanKind.INTERNAL, {}, []);
    expect(sample(sampledId).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(sample(droppedId).decision).toBe(
      samplingPercentage === undefined
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD,
    );
    expect(sample(sampledId).attributes?.[AZURE_MONITOR_SAMPLE_RATE]).toBe(samplingPercentage);
    expect(sample(sampledId, parent).decision).toBe(
      samplingPercentage === undefined
        ? SamplingDecision.NOT_RECORD
        : SamplingDecision.RECORD_AND_SAMPLED,
    );

    await handle.updateCfg({ samplingPercentage: 0 });
    expect(sample(sampledId).decision).toBe(SamplingDecision.NOT_RECORD);
    await handle.updateCfg({ samplingPercentage: 100 });
    expect(sample(droppedId, parent).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    await handle.updateCfg({ samplingPercentage: undefined });
    expect(sample(droppedId).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(sample(sampledId, parent).decision).toBe(SamplingDecision.NOT_RECORD);
    expect(sample(sampledId).attributes?.[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
    expect(startTelemetryInstance).toHaveBeenCalledOnce();
    expect(vi.mocked(startTelemetryInstance).mock.calls[0]?.[0]?.sampler).toBe(sampler);
  },
);

it("honors explicit per-signal disabling with Azure Monitor configured", async () => {
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());

  const handle = await useMicrosoftOpenTelemetry({
    azureMonitor: {
      connectionString:
        "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test",
    },
    spanProcessors: [],
    logRecordProcessors: [],
    pageView: { enabled: false },
  });
  handles.add(handle);

  expect(startTelemetryInstance).toHaveBeenCalledOnce();
  const sdkOptions = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0];
  expect(sdkOptions?.spanProcessors).toEqual([]);
  expect(sdkOptions?.logRecordProcessors).toEqual([]);
});

it.each(["both", "context manager", "propagators", "no propagators"] as const)(
  "registers %s without sharing or mutating trace configuration",
  async (configuration) => {
    const pipeline = createInMemoryPipeline();
    const active = vi.fn(() => ROOT_CONTEXT);
    const contextManager: ContextManager = {
      active,
      bind: (_ctx, target) => target,
      disable() {
        return this;
      },
      enable() {
        return this;
      },
      with: (_ctx, callback, thisArg, ...args) => callback.apply(thisArg, args),
    };
    const propagator = {
      fields: () => ["x-test-context"],
      inject: vi.fn(),
      extract: vi.fn((ctx) => ctx),
    };
    const propagators = Object.freeze(configuration === "no propagators" ? [] : [propagator]);
    const withContextManager = configuration === "both" || configuration === "context manager";
    const traces = Object.freeze({
      ...(withContextManager ? { contextManager } : {}),
      ...(configuration !== "context manager" ? { propagators } : {}),
    });
    const options: MicrosoftOpenTelemetryBrowserOptions = {
      spanProcessors: [pipeline.spanProcessor],
      logRecordProcessors: [],
      pageView: { enabled: false },
      traces,
    };
    Object.freeze(options.spanProcessors);

    const handle = await useMicrosoftOpenTelemetry(Object.freeze(options));
    handles.add(handle);

    expect(startTelemetryInstance).toHaveBeenCalledExactlyOnceWith({
      redactedQueryParams: DEFAULT_QUERY_STRINGS_TO_REDACT,
      resourceAttributes: {
        "telemetry.distro.name": "@microsoft/opentelemetry-browser",
        "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
      },
      sampler: expect.any(RuntimeSampler),
      spanProcessors: [
        expect.objectContaining({ onStart: expect.any(Function) }),
        pipeline.spanProcessor,
      ],
      logRecordProcessors: [],
      contextManager: withContextManager ? contextManager : undefined,
      correlation: undefined,
      propagators: configuration === "context manager" ? undefined : propagators,
    });
    context.active();
    expect(active).toHaveBeenCalledTimes(withContextManager ? 1 : 0);
    expect(propagation.fields()).toEqual(
      configuration === "context manager"
        ? ["traceparent", "tracestate", "baggage"]
        : configuration === "no propagators"
          ? []
          : ["x-test-context"],
    );
    expect(options.traces).toBe(traces);
    expect(options.traces?.propagators).toBe(traces.propagators);
  },
);

it.each([undefined, {}, { contextManager: undefined, propagators: undefined }])(
  "registers upstream context defaults for %j",
  async (traces) => {
    const handle = await useMicrosoftOpenTelemetry({
      traces,
      azureMonitor,
      pageView: { enabled: false },
      logRecordProcessors: [],
    });
    handles.add(handle);

    expect(startTelemetryInstance).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ contextManager: undefined, propagators: undefined }),
    );
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    const parent = trace.wrapSpanContext({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    });
    context.with(trace.setSpan(context.active(), parent), () => {
      expect(trace.getActiveSpan()).toBe(parent);
    });
  },
);

it("warns when another initialization claims page context during resource detection", async () => {
  const pendingPipeline = createInMemoryPipeline();
  let resolveAttribute!: (value: string) => void;
  const resource = detectResources({
    detectors: [
      {
        detect: () => ({
          attributes: {
            "service.name": new Promise<string>((resolve) => {
              resolveAttribute = resolve;
            }),
          },
        }),
      },
    ],
  });
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const waitForAttributes = resource.waitForAsyncAttributes!.bind(resource);
  vi.spyOn(resource, "waitForAsyncAttributes").mockImplementation(() => {
    markWaiting();
    return waitForAttributes();
  });
  const createPropagator = (field: string) => ({
    fields: () => [field],
    inject: vi.fn(),
    extract: vi.fn((ctx) => ctx),
  });
  const warn = vi.spyOn(diag, "warn");
  const pending = useMicrosoftOpenTelemetry({
    ...pendingPipeline.options,
    resource,
    traces: { propagators: [createPropagator("x-pending")] },
  });
  await waiting;
  const ownerPipeline = createInMemoryPipeline();
  handles.add(
    await useMicrosoftOpenTelemetry({
      ...ownerPipeline.options,
      traces: { propagators: [createPropagator("x-owner")] },
    }),
  );
  resolveAttribute("checkout-web");
  handles.add(await pending);

  expect(propagation.fields()).toEqual(["x-owner"]);
  expect(warn).toHaveBeenCalledWith(
    "Trace context options ignored; page context already registered",
  );
});

it("identifies the distribution without displacing the upstream SDK defaults", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const handle = await useMicrosoftOpenTelemetry(pipeline.options);
  handles.add(handle);
  trace.getTracer("manual").startSpan("checkout").end();
  await handle.shutdown();
  handles.delete(handle);

  expect(spanExport.mock.calls[0][0][0].resource.attributes).toMatchObject({
    "telemetry.distro.name": "@microsoft/opentelemetry-browser",
    "telemetry.distro.version": OPENTELEMETRY_BROWSER_VERSION,
    "service.name": "unknown_service",
    "telemetry.sdk.language": "webjs",
    "telemetry.sdk.name": "opentelemetry",
  });
});

it("lets a service.name attribute replace the unknown_service placeholder", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    resource: resourceFromAttributes({
      "service.name": "checkout-web",
      "service.version": "4.2.1",
      "deployment.environment.name": "production",
    }),
  });
  handles.add(handle);
  trace.getTracer("manual").startSpan("checkout").end();
  await handle.shutdown();
  handles.delete(handle);

  expect(spanExport.mock.calls[0][0][0].resource.attributes).toMatchObject({
    "service.name": "checkout-web",
    "service.version": "4.2.1",
    "deployment.environment.name": "production",
  });
});

it("resolves asynchronous resource detector attributes before SDK startup", async () => {
  let resolveOsVersion: ((value: string) => void) | undefined;
  const osVersion = new Promise<string>((resolve) => {
    resolveOsVersion = resolve;
  });
  const resource = detectResources({
    detectors: [{ detect: () => ({ attributes: { "user_agent.os.version": osVersion } }) }],
  });
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(fakeInstance());

  const initialization = useMicrosoftOpenTelemetry({ resource });
  await Promise.resolve();
  expect(startTelemetryInstance).not.toHaveBeenCalled();

  resolveOsVersion?.("11");
  const handle = await initialization;
  handles.add(handle);

  expect(startTelemetryInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceAttributes: expect.objectContaining({ "user_agent.os.version": "11" }),
    }),
  );
});

it("preserves asynchronously detected resource attributes in spans and logs", async () => {
  const pipeline = createInMemoryPipeline();
  const resource = detectResources({
    detectors: [
      {
        detect: () => ({
          attributes: {
            "service.name": new Promise<string>((resolve) => {
              setTimeout(() => resolve("checkout-web"), 0);
            }),
            "service.version": "4.2.1",
          },
        }),
      },
    ],
  });
  const handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, resource });
  handles.add(handle);
  await resource.waitForAsyncAttributes?.();

  trace.getTracer("manual").startSpan("checkout").end();
  logs.getLogger("manual").emit({ body: "checkout completed" });
  await handle.forceFlush();

  const expected = { "service.name": "checkout-web", "service.version": "4.2.1" };
  expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(1);
  expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(1);
  expect(pipeline.spanExporter.getFinishedSpans()[0].resource.attributes).toMatchObject(expected);
  expect(pipeline.logExporter.getFinishedLogRecords()[0].resource.attributes).toMatchObject(
    expected,
  );
});

it("does not share one attributes object across initializations", async () => {
  vi.mocked(startTelemetryInstance)
    .mockResolvedValueOnce(fakeInstance())
    .mockResolvedValueOnce(fakeInstance());

  handles.add(await useMicrosoftOpenTelemetry());
  handles.add(await useMicrosoftOpenTelemetry());

  const [first, second] = vi.mocked(startTelemetryInstance).mock.calls;
  expect(first[0]?.resourceAttributes).not.toBe(second[0]?.resourceAttributes);
});

it("force flushes both signal processors", async () => {
  const pipeline = createInMemoryPipeline();
  const spanFlush = vi.spyOn(pipeline.spanProcessor, "forceFlush");
  const logFlush = vi.spyOn(pipeline.logProcessor, "forceFlush");
  const handle = await useMicrosoftOpenTelemetry(pipeline.options);
  handles.add(handle);

  await handle.forceFlush();

  expect(spanFlush).toHaveBeenCalledOnce();
  expect(logFlush).toHaveBeenCalledOnce();
});

it("owns and force flushes default Azure Monitor processors without per-processor hide flushing", async () => {
  const succeed = (_items: unknown, done: (result: { code: number }) => void) => done({ code: 0 });
  const spanExport = vi
    .spyOn(AzureMonitorSpanExporter.prototype, "export")
    .mockImplementation(succeed);
  const logExport = vi
    .spyOn(AzureMonitorLogRecordExporter.prototype, "export")
    .mockImplementation(succeed);
  const spanFlush = vi.spyOn(BatchSpanProcessor.prototype, "forceFlush");
  const logFlush = vi.spyOn(BrowserBatchLogRecordProcessor.prototype, "forceFlush");
  const handle = await useMicrosoftOpenTelemetry({ azureMonitor, pageView: { enabled: false } });
  handles.add(handle);

  const config = vi.mocked(startTelemetryInstance).mock.calls[0]?.[0];
  expect(config?.spanProcessors).toEqual([
    expect.objectContaining({ onStart: expect.any(Function) }),
    expect.any(BatchSpanProcessor),
  ]);
  expect(config?.logRecordProcessors).toEqual([
    expect.objectContaining({ onEmit: expect.any(Function) }),
    expect.any(BrowserBatchLogRecordProcessor),
  ]);

  trace.getTracer("default-export").startSpan("operation").end();
  logs.getLogger("default-export").emit({ body: "record" });
  await handle.forceFlush();
  expect(spanExport).toHaveBeenCalledOnce();
  expect(logExport).toHaveBeenCalledOnce();
  expect(spanFlush).toHaveBeenCalledOnce();
  expect(logFlush).toHaveBeenCalledOnce();

  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => {
    expect(spanFlush).toHaveBeenCalledTimes(2);
    expect(logFlush).toHaveBeenCalledTimes(2);
  });
  await vi.waitFor(() => expect(isUnloading()).toBe(false));
  // Upstream batch processors listen on document; non-bubbling events bypass the handle.
  document.dispatchEvent(new Event("pagehide"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(spanFlush).toHaveBeenCalledTimes(2);
  expect(logFlush).toHaveBeenCalledTimes(2);
});

it("coalesces concurrent force flushes across both signals", async () => {
  let finishFlush!: () => void;
  const pendingFlush = new Promise<void>((resolve) => {
    finishFlush = resolve;
  });
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => pendingFlush),
    shutdown: vi.fn(async () => {}),
  };
  const logProcessor = {
    onEmit() {},
    forceFlush: vi.fn(() => pendingFlush),
    shutdown: vi.fn(async () => {}),
  };
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logProcessor],
    pageView: { enabled: false },
  });
  handles.add(handle);

  const first = handle.forceFlush();
  const second = handle.forceFlush();
  expect(second).toBe(first);
  await Promise.resolve();
  expect(spanProcessor.forceFlush).toHaveBeenCalledOnce();
  expect(logProcessor.forceFlush).toHaveBeenCalledOnce();
  finishFlush();
  await Promise.all([first, second]);
});

it("starts an unload flush while a manual flush is pending", async () => {
  const finishFlushes: Array<() => void> = [];
  const unloadStates: boolean[] = [];
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => {
      unloadStates.push(isUnloading());
      return new Promise<void>((resolve) => finishFlushes.push(resolve));
    }),
    shutdown: vi.fn(async () => {}),
  };
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    pageView: { enabled: false },
  });
  handles.add(handle);

  const manualFlush = handle.forceFlush();
  await vi.waitFor(() => expect(spanProcessor.forceFlush).toHaveBeenCalledOnce());
  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect(spanProcessor.forceFlush).toHaveBeenCalledTimes(2));

  expect(unloadStates).toEqual([false, true]);
  finishFlushes[1]();
  await vi.waitFor(() => expect(isUnloading()).toBe(false));
  finishFlushes[0]();
  await manualFlush;
});

it("turns synchronous force flush errors into rejections and permits retry", async () => {
  const failure = new Error("synchronous flush failure");
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => {
      if (spanProcessor.forceFlush.mock.calls.length === 1) throw failure;
      return Promise.resolve();
    }),
    shutdown: vi.fn(async () => {}),
  };
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    pageView: { enabled: false },
  });
  handles.add(handle);

  const first = handle.forceFlush();
  expect(first).toBeInstanceOf(Promise);
  await expect(first).rejects.toBe(failure);
  await expect(handle.forceFlush()).resolves.toBeUndefined();
  expect(spanProcessor.forceFlush).toHaveBeenCalledTimes(2);
});

it("waits for every processor flush before reporting failures", async () => {
  const failure = new Error("span flush failure");
  let finishLogFlush!: () => void;
  const logFlush = new Promise<void>((resolve) => {
    finishLogFlush = resolve;
  });
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => {
      throw failure;
    }),
    shutdown: vi.fn(async () => {}),
  };
  const logProcessor = {
    onEmit() {},
    forceFlush: vi.fn(() => logFlush),
    shutdown: vi.fn(async () => {}),
  };
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logProcessor],
    pageView: { enabled: false },
  });
  handles.add(handle);

  const flush = handle.forceFlush();
  let settled = false;
  void flush.catch(() => {}).finally(() => (settled = true));
  await vi.waitFor(() => expect(logProcessor.forceFlush).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finishLogFlush();
  await expect(flush).rejects.toBe(failure);
});

it("clears unload state when a processor throws synchronously during flush", async () => {
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => {
      if (spanProcessor.forceFlush.mock.calls.length === 1) {
        throw new Error("synchronous flush failure");
      }
      return Promise.resolve();
    }),
    shutdown: vi.fn(async () => {}),
  };
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    pageView: { enabled: false },
  });
  handles.add(handle);

  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => {
    expect(spanProcessor.forceFlush).toHaveBeenCalledOnce();
    expect(isUnloading()).toBe(false);
  });

  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => {
    expect(spanProcessor.forceFlush).toHaveBeenCalledTimes(2);
    expect(isUnloading()).toBe(false);
  });
});

it("keeps shared unload mode active until every handle finishes flushing", async () => {
  const finishFlushes: Array<() => void> = [];
  const createProcessor = () => ({
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => new Promise<void>((resolve) => finishFlushes.push(resolve))),
    shutdown: vi.fn(async () => {}),
  });
  const firstProcessor = createProcessor();
  const secondProcessor = createProcessor();
  const firstHandle = await useMicrosoftOpenTelemetry({
    spanProcessors: [firstProcessor],
    pageView: { enabled: false },
  });
  const secondHandle = await useMicrosoftOpenTelemetry({
    spanProcessors: [secondProcessor],
    pageView: { enabled: false },
  });
  handles.add(firstHandle);
  handles.add(secondHandle);

  globalThis.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => {
    expect(firstProcessor.forceFlush).toHaveBeenCalledOnce();
    expect(secondProcessor.forceFlush).toHaveBeenCalledOnce();
  });
  expect(isUnloading()).toBe(true);
  finishFlushes[0]();
  await Promise.resolve();
  expect(isUnloading()).toBe(true);
  finishFlushes[1]();
  await vi.waitFor(() => expect(isUnloading()).toBe(false));
});

it("waits for an active manual flush before shutting down providers", async () => {
  let finishFlush!: () => void;
  const pendingFlush = new Promise<void>((resolve) => {
    finishFlush = resolve;
  });
  const spanProcessor = {
    onStart() {},
    onEnd() {},
    forceFlush: vi.fn(() => pendingFlush),
    shutdown: vi.fn(async () => {}),
  };
  const upstreamHandle = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(upstreamHandle);
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [spanProcessor],
    pageView: { enabled: false },
  });

  const flush = handle.forceFlush();
  await vi.waitFor(() => expect(spanProcessor.forceFlush).toHaveBeenCalledOnce());
  const shutdown = handle.shutdown();
  expect(handle.forceFlush()).toBe(shutdown);
  expect(upstreamHandle.shutdown).not.toHaveBeenCalled();
  finishFlush();
  await Promise.all([flush, shutdown]);
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("propagates initialization failures without returning a success-shaped handle", async () => {
  const failure = new Error("initialization failed");
  vi.mocked(startTelemetryInstance).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry()).rejects.toThrow(failure);
});

it.each([undefined, {}])(
  "skips both providers without a telemetry destination %j",
  async (options) => {
    getSharedRegistry().diagInitialized = false;
    // Capture what reaches the logger the SDK installs, proving the warning follows installation.
    const installed = { warn: vi.fn(), error() {}, info() {}, debug() {}, verbose() {} };
    const setLogger = diag.setLogger.bind(diag);
    vi.spyOn(diag, "setLogger").mockImplementation((_logger, level) => setLogger(installed, level));
    const warn = installed.warn;
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const detectBrowser = vi.spyOn(browserDetector, "detect");
    const detectUserAgent = vi.spyOn(userAgentDetector, "detect");
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    expect(registerTrace).not.toHaveBeenCalled();
    expect(registerLogs).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No telemetry destination"));
    expect(detectBrowser).not.toHaveBeenCalled();
    expect(detectUserAgent).not.toHaveBeenCalled();
  },
);

it("exports correlated manual telemetry through custom processors", async () => {
  const pipeline = createInMemoryPipeline();
  Object.freeze(pipeline.options.spanProcessors);
  Object.freeze(pipeline.options.logRecordProcessors);
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const logExport = vi.spyOn(pipeline.logExporter, "export");
  const handle = await useMicrosoftOpenTelemetry(Object.freeze(pipeline.options));
  handles.add(handle);
  const span = trace.getTracer("manual", "1.2.3").startSpan("checkout");
  logs.getLogger("manual", "1.2.3").emit({
    eventName: "checkout.started",
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
  await handle.shutdown();
  handles.delete(handle);

  const exportedSpan = spanExport.mock.calls[0][0][0];
  const exportedLog = logExport.mock.calls[0][0][0];
  expect(exportedSpan.name).toBe("checkout");
  expect(exportedLog.eventName).toBe("checkout.started");
  expect(exportedLog.spanContext).toEqual(span.spanContext());
  for (const record of [exportedSpan, exportedLog]) {
    expect(record.instrumentationScope).toMatchObject({ name: "manual", version: "1.2.3" });
  }
  expect(pipeline.options.spanProcessors).toEqual([pipeline.spanProcessor]);
  expect(pipeline.options.logRecordProcessors).toEqual([pipeline.logProcessor]);
});

it.each(
  [true, false].flatMap((enabled) =>
    [undefined, []].flatMap((spanProcessors) =>
      [undefined, []].map((logRecordProcessors) => ({
        enabled,
        spanProcessors,
        logRecordProcessors,
      })),
    ),
  ),
)(
  "preserves per-signal disabling and default export (%j)",
  async ({ enabled, spanProcessors, logRecordProcessors }) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const spanExport = vi
      .spyOn(AzureMonitorSpanExporter.prototype, "export")
      .mockImplementation((_spans, callback) => callback({ code: 0 }));
    const logExport = vi
      .spyOn(AzureMonitorLogRecordExporter.prototype, "export")
      .mockImplementation((_records, callback) => callback({ code: 0 }));
    const handle = await useMicrosoftOpenTelemetry({
      session: { enabled },
      azureMonitor,
      pageView: { enabled: false },
      spanProcessors,
      logRecordProcessors,
    });
    handles.add(handle);
    expect(registerTrace).toHaveBeenCalledTimes(spanProcessors === undefined ? 1 : 0);
    expect(registerLogs).toHaveBeenCalledTimes(logRecordProcessors === undefined ? 1 : 0);
    const span = trace.getTracer("default-export").startSpan("default");
    expect(span.isRecording()).toBe(spanProcessors === undefined);
    span.end();
    const logger = logs.getLogger("default-export");
    expect(logger.enabled()).toBe(logRecordProcessors === undefined);
    logger.emit({ eventName: "default" });
    await handle.shutdown();
    expect(spanExport).toHaveBeenCalledTimes(spanProcessors === undefined ? 1 : 0);
    expect(logExport).toHaveBeenCalledTimes(logRecordProcessors === undefined ? 1 : 0);
    const ids = [
      ...spanExport.mock.calls.flatMap(([spans]) => spans),
      ...logExport.mock.calls.flatMap(([records]) => records),
    ].map((record) => record.attributes["session.id"]);
    for (const id of ids) {
      if (enabled) {
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(id).toBe(ids[0]);
      } else expect(id).toBeUndefined();
    }
  },
);

it.each([true, false])(
  "preserves caller log filtering with sessions enabled=%s",
  async (enabled) => {
    const pipeline = createInMemoryPipeline();
    const firstEmit = vi.fn();
    const onEmit = vi.spyOn(pipeline.logProcessor, "onEmit");
    const filter = vi.fn<NonNullable<LogRecordProcessor["enabled"]>>(
      (options) =>
        options.eventName === "allowed" && options.severityNumber === SeverityNumber.WARN,
    );
    const handle = await useMicrosoftOpenTelemetry({
      session: { enabled },
      pageView: { enabled: false },
      spanProcessors: [],
      logRecordProcessors: [
        {
          enabled: () => false,
          onEmit: firstEmit,
          forceFlush: async () => {},
          shutdown: async () => {},
        },
        Object.assign(pipeline.logProcessor, { enabled: filter }),
      ],
    });
    handles.add(handle);
    const logger = logs.getLogger("filtered", "1.0");
    const rejected = {
      eventName: "blocked",
      severityNumber: SeverityNumber.WARN,
      context: ROOT_CONTEXT,
    };
    expect(logger.enabled(rejected)).toBe(false);
    logger.emit(rejected);
    logger.emit({ eventName: "allowed", severityNumber: SeverityNumber.INFO });
    expect(firstEmit).not.toHaveBeenCalled();
    expect(onEmit).not.toHaveBeenCalled();
    const accepted = { ...rejected, eventName: "allowed" };
    expect(logger.enabled(accepted)).toBe(true);
    logger.emit(accepted);
    expect(filter).toHaveBeenLastCalledWith({
      ...accepted,
      instrumentationScope: expect.objectContaining({ name: "filtered", version: "1.0" }),
    });
    expect(onEmit).toHaveBeenCalledOnce();
    const id = onEmit.mock.calls[0][0].attributes["session.id"];
    if (enabled) expect(id).toMatch(/^[0-9a-f]{32}$/);
    else expect(id).toBeUndefined();
  },
);

it("reports an upstream shutdown failure while shutting down both signals", async () => {
  const failure = new Error("processor shutdown failed");
  const pipeline = createInMemoryPipeline();
  const traceShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: [
      {
        onEmit() {},
        async forceFlush() {},
        async shutdown() {
          throw failure;
        },
      },
    ],
  });
  await expect(handle.shutdown()).rejects.toThrow("processor shutdown failed");
  expect(traceShutdown).toHaveBeenCalledOnce();
});
