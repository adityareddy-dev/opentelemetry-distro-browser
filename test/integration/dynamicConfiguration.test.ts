// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, beforeEach, expect, inject, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "../../src/index.js";
import { beginUnloading, endUnloading, isUnloading } from "../../src/exporter/common.js";
import type { AzureMonitorEnvelope, CustomEventData } from "../../src/exporter/telemetryModels.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/types.js";
import { installFakeClock } from "../fixtures/clock.js";
import { withoutSdkStats } from "../fixtures/sdkStats.js";
import { createInMemoryPipeline, createSpanContext } from "../fixtures/telemetry.js";

const handles: MicrosoftOpenTelemetryBrowser[] = [];
let originalUrl: string;

beforeEach(() => {
  originalUrl = location.href;
  const nativeFetch = fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(withoutSdkStats(nativeFetch));
});

afterEach(async () => {
  try {
    await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  } finally {
    history.replaceState(null, "", originalUrl);
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
    vi.restoreAllMocks();
  }
});

async function start(options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {}) {
  const pipeline = createInMemoryPipeline();
  let tracer!: ReturnType<typeof trace.getTracer>;
  let logger!: ReturnType<typeof logs.getLogger>;
  const handle = await useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
    session: { persist: false },
    userContext: { enabled: false },
    ...options,
    instrumentations: [
      ...(options.instrumentations ?? []),
      {
        setTracerProvider(provider) {
          tracer = provider.getTracer("dynamic-configuration-bound");
        },
        setLoggerProvider(provider) {
          logger = provider.getLogger("dynamic-configuration-bound");
        },
        getConfig: () => ({ enabled: true }),
        enable() {},
        disable() {},
      },
    ],
  });
  handles.push(handle);
  return { ...pipeline, handle, client: { tracer, logger } };
}

function clients() {
  return {
    tracer: trace.getTracer("dynamic-configuration"),
    logger: logs.getLogger("dynamic-configuration"),
  };
}

function emit(client: ReturnType<typeof clients>, name: string): void {
  client.tracer.startSpan(name, {}, ROOT_CONTEXT).end();
  client.logger.emit({ eventName: name, body: name, context: ROOT_CONTEXT });
}

const beaconConnectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://beacon.example.test";

function mockBeaconTransport() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    if (init?.keepalive) throw new TypeError("deliberate keepalive failure");
    return new Response(null);
  });
  vi.mocked(globalThis.fetch).mockImplementation(withoutSdkStats(fetch));
  const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
  return {
    fetch,
    sendBeacon,
    async envelopes(): Promise<AzureMonitorEnvelope[]> {
      const batches = await Promise.all(
        sendBeacon.mock.calls.map(async ([, body]) => {
          expect(body).toBeInstanceOf(Blob);
          return JSON.parse(await (body as Blob).text()) as AzureMonitorEnvelope[];
        }),
      );
      return batches.flat();
    },
  };
}

function startBeacon(options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {}) {
  return start({
    pageView: { enabled: false },
    session: { enabled: false },
    userContext: { enabled: false },
    storage: { enabled: false },
    ...options,
  });
}

async function flushUnloading(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  beginUnloading();
  try {
    await handle.forceFlush();
  } finally {
    endUnloading();
  }
}

function expectBeaconSignals(envelopes: AzureMonitorEnvelope[], name: string): void {
  expect(envelopes).toHaveLength(2);
  expect(envelopes).toEqual(
    expect.arrayContaining(
      ["RemoteDependencyData", "EventData"].map((baseType) =>
        expect.objectContaining({
          data: expect.objectContaining({
            baseType,
            baseData: expect.objectContaining({ name }),
          }),
        }),
      ),
    ),
  );
}

it("applies beacon updates to traces and logs queued before pagehide without replacing the handle", async () => {
  const transport = mockBeaconTransport();
  const pipeline = await startBeacon({
    azureMonitor: { connectionString: beaconConnectionString },
  });
  const cached = pipeline.client;
  emit(cached, "queued-before-disabling");
  await pipeline.handle.updateCfg({ azureMonitor: { disableBeacon: true } });
  globalThis.dispatchEvent(new Event("pagehide"));
  // The actual lifecycle listener owns and releases unload state, even on export failure.
  await vi.waitFor(() => expect(isUnloading()).toBe(false));
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(transport.fetch.mock.calls.every(([, init]) => init?.keepalive === true)).toBe(true);
  expect(transport.sendBeacon).not.toHaveBeenCalled();

  transport.fetch.mockClear();
  emit(cached, "queued-before-enabling");
  await pipeline.handle.updateCfg({ azureMonitor: { disableBeacon: false } });
  await flushUnloading(pipeline.handle);
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(transport.sendBeacon).toHaveBeenCalledTimes(2);
  expectBeaconSignals(await transport.envelopes(), "queued-before-enabling");
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "queued-before-disabling",
    "queued-before-enabling",
  ]);
  expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
    "queued-before-disabling",
    "queued-before-enabling",
  ]);
});

it.each([false, true])(
  "normalizes native startup beacon policy=%s, runtime aliases and merge/replacement resets",
  async (disableBeacon) => {
    const transport = mockBeaconTransport();
    const pipeline = await startBeacon({
      azureMonitor: {
        connectionString: beaconConnectionString,
        disableBeacon,
      },
    });
    const steps: {
      patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate;
      merge?: boolean;
      disabled: boolean;
    }[] = [
      { patch: {}, disabled: disableBeacon },
      { patch: { azureMonitor: { disableBeacon: false } }, disabled: false },
      { patch: { onunloadDisableBeacon: true }, disabled: true },
      { patch: { azureMonitor: {} }, disabled: true },
      { patch: {}, disabled: true },
      { patch: { azureMonitor: { disableBeacon: undefined } }, disabled: false },
      { patch: { azureMonitor: { disableBeacon: true } }, disabled: true },
      { patch: { onunloadDisableBeacon: undefined }, disabled: false },
      { patch: { onunloadDisableBeacon: true }, disabled: true },
      { patch: {}, merge: false, disabled: false },
      { patch: { azureMonitor: { disableBeacon: true } }, disabled: true },
      { patch: { azureMonitor: {} }, merge: false, disabled: false },
    ];
    for (const [index, { patch, merge, disabled }] of steps.entries()) {
      transport.fetch.mockClear();
      transport.sendBeacon.mockClear();
      const name = `beacon-policy-${index}`;
      emit(pipeline.client, name);
      await pipeline.handle.updateCfg(patch, merge);
      if (disabled) {
        await expect(flushUnloading(pipeline.handle)).rejects.toThrow();
        expect(transport.sendBeacon).not.toHaveBeenCalled();
      } else {
        await flushUnloading(pipeline.handle);
        expectBeaconSignals(await transport.envelopes(), name);
      }
      // Replacement resets policy, not the existing destination or providers.
      expect(transport.fetch).toHaveBeenCalledTimes(2);
      expect(transport.fetch.mock.calls.every(([, init]) => init?.keepalive === true)).toBe(true);
    }
  },
);

it("rejects invalid and conflicting beacon patches atomically and captures queued boolean updates", async () => {
  const transport = mockBeaconTransport();
  const pipeline = await startBeacon({
    samplingPercentage: 100,
    azureMonitor: { connectionString: beaconConnectionString },
  });
  const getter = vi.fn(() => true);
  const patches = [
    ...[null, 0, "true"].map((disableBeacon) => ({
      samplingPercentage: 0,
      azureMonitor: { disableBeacon },
    })),
    { samplingPercentage: 0, onunloadDisableBeacon: null },
    { samplingPercentage: 0, azureMonitor: { connectionString: beaconConnectionString } },
    { samplingPercentage: 0, azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: false },
    {
      samplingPercentage: 0,
      azureMonitor: Object.defineProperty({}, "disableBeacon", { get: getter }),
    },
  ];
  for (const patch of patches) {
    await expect(
      pipeline.handle.updateCfg(patch as MicrosoftOpenTelemetryBrowserConfigurationUpdate),
    ).rejects.toThrow();
    expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  }
  expect(getter).not.toHaveBeenCalled();
  expect(
    await pipeline.handle.updateCfg({
      azureMonitor: { disableBeacon: false },
      onunloadDisableBeacon: false,
    }),
  ).toEqual({ revision: 0, changedPaths: [] });
  const patch = { azureMonitor: { disableBeacon: true } };
  const first = pipeline.handle.updateCfg(patch);
  patch.azureMonitor.disableBeacon = false;
  const second = pipeline.handle.updateCfg({ onunloadDisableBeacon: false });
  expect(await first).toEqual({ revision: 1, changedPaths: ["azureMonitor.disableBeacon"] });
  expect(await second).toEqual({ revision: 2, changedPaths: ["azureMonitor.disableBeacon"] });
  emit(pipeline.client, "invalid-patches-did-not-disable-sampling");
  await flushUnloading(pipeline.handle);
  expectBeaconSignals(await transport.envelopes(), "invalid-patches-did-not-disable-sampling");
});

it.each(["separate", "shared", "shared deferred"] as const)(
  "keeps bound trace/log beacon policies independent with %s caller options",
  async (mode) => {
    const transport = mockBeaconTransport();
    let resolve!: (value: string) => void;
    const connectionString =
      mode === "shared deferred"
        ? new Promise<string>((done) => {
            resolve = done;
          })
        : beaconConnectionString;
    const options = { azureMonitor: { connectionString } };
    const first = await startBeacon(options);
    const second = await startBeacon(
      mode === "separate"
        ? { azureMonitor: { connectionString: beaconConnectionString } }
        : options,
    );
    emit(first.client, "first-disabled");
    emit(second.client, "second-enabled");
    await first.handle.updateCfg({ azureMonitor: { disableBeacon: true } });
    if (mode === "shared deferred") {
      resolve(beaconConnectionString);
      await Promise.resolve();
    }
    await expect(flushUnloading(first.handle)).rejects.toThrow();
    await flushUnloading(second.handle);
    expectBeaconSignals(await transport.envelopes(), "second-enabled");

    transport.sendBeacon.mockClear();
    emit(first.client, "first-enabled");
    emit(second.client, "second-disabled");
    await first.handle.updateCfg({ onunloadDisableBeacon: false });
    await second.handle.updateCfg({ onunloadDisableBeacon: true });
    await flushUnloading(first.handle);
    await expect(flushUnloading(second.handle)).rejects.toThrow();
    expectBeaconSignals(await transport.envelopes(), "first-enabled");
    expect(options).toEqual({ azureMonitor: { connectionString } });
    for (const [pipeline, names] of [
      [first, ["first-disabled", "first-enabled"]],
      [second, ["second-enabled", "second-disabled"]],
    ] as const) {
      expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(names);
      expect(
        pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName),
      ).toEqual(names);
    }
  },
);

it.each([false, true])(
  "does not create an Azure destination when only custom exporters are present=%s",
  async (custom) => {
    const transport = mockBeaconTransport();
    const pipeline = await startBeacon(
      custom ? {} : { spanProcessors: undefined, logRecordProcessors: undefined },
    );
    emit(pipeline.client, "before-beacon-update");
    await pipeline.handle.updateCfg({ azureMonitor: { disableBeacon: true } });
    await pipeline.handle.updateCfg({ onunloadDisableBeacon: false });
    emit(pipeline.client, "after-beacon-update");
    await flushUnloading(pipeline.handle);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.sendBeacon).not.toHaveBeenCalled();
    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual(
      custom ? ["before-beacon-update", "after-beacon-update"] : [],
    );
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual(
      custom ? ["before-beacon-update", "after-beacon-update"] : [],
    );
  },
);

it.each([false, true])(
  "uses current beacon policy before deferred resolution and after initialization, initially disabled=%s",
  async (initiallyDisabled) => {
    const transport = mockBeaconTransport();
    let resolve!: (value: string) => void;
    const connectionString = new Promise<string>((done) => {
      resolve = done;
    });
    const pipeline = await startBeacon({
      azureMonitor: { connectionString, disableBeacon: initiallyDisabled },
    });
    emit(pipeline.client, "queued-before-resolution");
    await pipeline.handle.updateCfg({ azureMonitor: { disableBeacon: !initiallyDisabled } });
    await pipeline.handle.forceFlush();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.sendBeacon).not.toHaveBeenCalled();
    resolve(beaconConnectionString);
    // Resolution constructs both exporters and drains the startup queue in one microtask.
    await Promise.resolve();
    if (initiallyDisabled) {
      await flushUnloading(pipeline.handle);
      expectBeaconSignals(await transport.envelopes(), "queued-before-resolution");
    } else {
      await expect(flushUnloading(pipeline.handle)).rejects.toThrow();
      expect(transport.sendBeacon).not.toHaveBeenCalled();
    }
    expect(transport.fetch).toHaveBeenCalledTimes(2);

    transport.fetch.mockClear();
    transport.sendBeacon.mockClear();
    emit(pipeline.client, "queued-after-initialization");
    await pipeline.handle.updateCfg({ onunloadDisableBeacon: initiallyDisabled });
    if (initiallyDisabled) {
      await expect(flushUnloading(pipeline.handle)).rejects.toThrow();
      expect(transport.sendBeacon).not.toHaveBeenCalled();
    } else {
      await flushUnloading(pipeline.handle);
      expectBeaconSignals(await transport.envelopes(), "queued-after-initialization");
    }
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "queued-before-resolution",
      "queued-after-initialization",
    ]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "queued-before-resolution",
      "queued-after-initialization",
    ]);
  },
);

it.each(["trace", "log"] as const)(
  "exports matching session IDs when %s activity first observes runtime lifetime changes",
  async (firstSignal) => {
    const clock = installFakeClock();
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const pipeline = await start({
      session: { persist: false, inactivityTimeout: 1, maxDuration: 2 },
      storage: { enabled: false },
    });
    const { handle } = pipeline;
    const { tracer, logger } = clients();
    async function emitAndFlush(name: string) {
      const emitTrace = () => tracer.startSpan(name, {}, ROOT_CONTEXT).end();
      const emitLog = () => logger.emit({ eventName: name, body: name, context: ROOT_CONTEXT });
      if (firstSignal === "trace") {
        emitTrace();
        emitLog();
      } else {
        emitLog();
        emitTrace();
      }
      const flushed = handle.forceFlush();
      await clock.advance(0);
      await flushed;
      const spans = pipeline.spanExporter.getFinishedSpans();
      const records = pipeline.logExporter.getFinishedLogRecords();
      expect(records.map((record) => record.eventName)).toEqual(spans.map((span) => span.name));
      expect(records.map((record) => record.attributes["session.id"])).toEqual(
        spans.map((span) => span.attributes["session.id"]),
      );
      const id = spans.at(-1)?.attributes["session.id"];
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      return id;
    }
    try {
      const initial = await emitAndFlush("initial");
      await clock.advance(400);
      expect(await emitAndFlush("recent-activity")).toBe(initial);
      await clock.advance(2100);
      // Both original limits have elapsed, but no activity has observed them yet.
      await handle.updateCfg({ session: { inactivityTimeout: 3, maxDuration: 4 } });
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(2);
      expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(2);
      await clock.advance(899);
      expect(await emitAndFlush("extended-with-original-timestamps")).toBe(initial);
      await clock.advance(101);
      await handle.updateCfg({ session: { maxDuration: 3.5 } });
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(3);
      expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(3);
      const maximumRotation = await emitAndFlush("shortened-maximum-boundary");
      expect(maximumRotation).not.toBe(initial);
      await clock.advance(500);
      await handle.updateCfg({ session: { inactivityTimeout: 0.5, maxDuration: 0 } });
      const inactivityRotation = await emitAndFlush("shortened-inactivity-boundary");
      expect(inactivityRotation).not.toBe(maximumRotation);
      await handle.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } });
      await clock.advance(25 * 60 * 60_000);
      expect(await emitAndFlush("native-zero-disables-expiration")).toBe(inactivityRotation);
      await handle.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: 0 });
      expect(await emitAndFlush("alias-zero-restores-default-maximum")).not.toBe(
        inactivityRotation,
      );
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(7);
      expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(7);
    } finally {
      try {
        const stopped = handle.shutdown();
        await clock.advance(0);
        await stopped;
        expect(vi.getTimerCount()).toBe(0);
        expect(local).not.toHaveBeenCalled();
        expect(session).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      } finally {
        clock.restore();
      }
    }
  },
);

it("keeps cached span and log clients on independent sessions through lifetime extension and rotation", async () => {
  const started = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(started);
  const first = await start({
    resource: resourceFromAttributes({ "service.name": "session-first" }),
    session: { persist: false, inactivityTimeout: 1, maxDuration: 0 },
  });
  const cachedFirst = clients();
  const second = await start({
    resource: resourceFromAttributes({ "service.name": "session-second" }),
    session: { persist: false, inactivityTimeout: 10, maxDuration: 0 },
  });
  // Instrumentation receives the second instance's providers, not the default global route.
  const cachedSecond = second.client;
  emit(cachedFirst, "initial");
  emit(cachedSecond, "initial");
  clock.mockReturnValue(started + 1500);
  await first.handle.updateCfg({ session: { inactivityTimeout: 3 } });
  emit(cachedFirst, "extended-after-old-expiry");
  emit(cachedSecond, "unaffected-extension");
  clock.mockReturnValue(started + 2500);
  await first.handle.updateCfg({ session: { inactivityTimeout: 0.5 } });
  emit(cachedFirst, "shortened");
  emit(cachedSecond, "unaffected-shortening");
  await first.handle.updateCfg({ session: { inactivityTimeout: 0 } });
  clock.mockReturnValue(started + 4000);
  await second.handle.updateCfg({ session: { maxDuration: 3 } });
  emit(cachedFirst, "unaffected-maximum");
  emit(cachedSecond, "shortened-maximum");
  await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);

  const firstIds = first.spanExporter
    .getFinishedSpans()
    .map((span) => span.attributes["session.id"]);
  const secondIds = second.spanExporter
    .getFinishedSpans()
    .map((span) => span.attributes["session.id"]);
  expect(firstIds).toHaveLength(4);
  expect(secondIds).toHaveLength(4);
  expect(firstIds[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(secondIds[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(firstIds[0]).not.toBe(secondIds[0]);
  expect(firstIds[1]).toBe(firstIds[0]);
  expect(firstIds[2]).not.toBe(firstIds[0]);
  expect(firstIds[3]).toBe(firstIds[2]);
  expect(secondIds.slice(0, 3)).toEqual([secondIds[0], secondIds[0], secondIds[0]]);
  expect(secondIds[3]).not.toBe(secondIds[0]);
  for (const [pipeline, ids, service] of [
    [first, firstIds, "session-first"],
    [second, secondIds, "session-second"],
  ] as const) {
    expect(
      pipeline.logExporter.getFinishedLogRecords().map((record) => record.attributes["session.id"]),
    ).toEqual(ids);
    for (const record of [
      ...pipeline.spanExporter.getFinishedSpans(),
      ...pipeline.logExporter.getFinishedLogRecords(),
    ]) {
      expect(record.resource.attributes["service.name"]).toBe(service);
    }
  }
});

it("converts startup and runtime session aliases and rejects normalized conflicts without changing sampling", async () => {
  const started = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(started);
  const pipeline = await start({
    samplingPercentage: 100,
    session: { persist: false, maxDuration: 0 },
    sessionRenewalMs: 1000,
  });
  const cached = clients();
  emit(cached, "initial");
  clock.mockReturnValue(started + 1500);
  await pipeline.handle.updateCfg({ sessionRenewalMs: 3000 });
  emit(cached, "extended");
  await expect(
    pipeline.handle.updateCfg({
      samplingPercentage: 0,
      session: { inactivityTimeout: 0 },
      sessionRenewalMs: 0,
    }),
  ).rejects.toThrow();
  clock.mockReturnValue(started + 3000);
  emit(cached, "conflict-was-atomic");
  await pipeline.handle.updateCfg({ sessionRenewalMs: 0 });
  clock.mockReturnValue(started + 3000 + 1800_000 - 1);
  emit(cached, "alias-zero-is-default-not-zero-ms");
  clock.mockReturnValue(started + 3000 + 2 * 1800_000 - 1);
  emit(cached, "alias-default-boundary");
  await pipeline.handle.forceFlush();

  const spans = pipeline.spanExporter.getFinishedSpans();
  expect(spans.map((span) => span.name)).toEqual([
    "initial",
    "extended",
    "conflict-was-atomic",
    "alias-zero-is-default-not-zero-ms",
    "alias-default-boundary",
  ]);
  const ids = spans.map((span) => span.attributes["session.id"]);
  expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(ids.slice(0, 4)).toEqual([ids[0], ids[0], ids[0], ids[0]]);
  expect(ids[4]).not.toBe(ids[0]);
  expect(
    pipeline.logExporter.getFinishedLogRecords().map((record) => record.attributes["session.id"]),
  ).toEqual(ids);
});

it.each([
  { field: "inactivityTimeout", defaultSeconds: 1800 },
  { field: "maxDuration", defaultSeconds: 86400 },
] as const)(
  "replacement restores sampling and $field defaults on cached clients without restarting the session",
  async ({ field, defaultSeconds }) => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const pipeline = await start({
      samplingPercentage: 100,
      session: { persist: false, inactivityTimeout: 0, maxDuration: 0 },
    });
    const cached = clients();
    emit(cached, "initial");
    clock.mockReturnValue(started + defaultSeconds * 1000 - 1);
    if (field === "maxDuration") emit(cached, "recent-activity");
    await pipeline.handle.updateCfg({}, false);
    cached.tracer
      .startSpan(
        "default-unsampled-parent",
        {},
        trace.setSpanContext(ROOT_CONTEXT, {
          ...createSpanContext(),
          traceFlags: 0,
        }),
      )
      .end();
    clock.mockReturnValue(started + defaultSeconds * 1000);
    emit(cached, "default-boundary");
    await pipeline.handle.forceFlush();

    const spans = pipeline.spanExporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(
      field === "maxDuration"
        ? ["initial", "recent-activity", "default-boundary"]
        : ["initial", "default-boundary"],
    );
    const ids = spans.map((span) => span.attributes["session.id"]);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    if (field === "maxDuration") expect(ids[1]).toBe(ids[0]);
    expect(ids.at(-1)).not.toBe(ids[0]);
    expect(
      pipeline.logExporter.getFinishedLogRecords().map((record) => record.attributes["session.id"]),
    ).toEqual(ids);
    await pipeline.handle.shutdown();
    await expect(pipeline.handle.updateCfg({ session: { maxDuration: 0 } })).rejects.toThrow(
      "stopped",
    );
    emit(cached, "stale-client");
    expect(pipeline.spanExporter.getFinishedSpans()).toEqual([]);
    expect(pipeline.logExporter.getFinishedLogRecords()).toEqual([]);
  },
);

it("keeps cached tracers and loggers bound to their instance across 0/100/reset updates", async () => {
  const first = await start({ resource: resourceFromAttributes({ "service.name": "first" }) });
  const cached = clients();
  const second = await start({ resource: resourceFromAttributes({ "service.name": "second" }) });
  emit(cached, "initial");
  await first.handle.updateCfg({ samplingPercentage: 0 });
  emit(cached, "dropped-span");
  await first.handle.updateCfg({ samplingPercentage: 100 });
  emit(cached, "all");
  await first.handle.updateCfg({ samplingPercentage: undefined });
  emit(cached, "reset");
  await second.handle.updateCfg({ samplingPercentage: 0 });
  emit(cached, "other-instance-isolated");
  await Promise.all([first.handle.forceFlush(), second.handle.forceFlush()]);

  expect(first.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "initial",
    "all",
    "reset",
    "other-instance-isolated",
  ]);
  const records = first.logExporter.getFinishedLogRecords();
  expect(records.map((record) => record.eventName)).toEqual([
    "initial",
    "dropped-span",
    "all",
    "reset",
    "other-instance-isolated",
  ]);
  expect(records.every((record) => record.resource.attributes["service.name"] === "first")).toBe(
    true,
  );
  expect(
    first.spanExporter
      .getFinishedSpans()
      .every((span) => span.resource.attributes["service.name"] === "first"),
  ).toBe(true);
  expect(second.spanExporter.getFinishedSpans()).toEqual([]);
  expect(second.logExporter.getFinishedLogRecords()).toEqual([]);
});

it("restores parent-based sampling rather than treating an undefined reset as 100 percent", async () => {
  const pipeline = await start({ samplingPercentage: 100 });
  const { tracer } = clients();
  const parent = trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 });
  tracer.startSpan("explicit-100", {}, parent).end();
  expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  tracer.startSpan("omitted-retains-policy", {}, parent).end();
  await pipeline.handle.updateCfg({ samplingPercentage: undefined });
  tracer.startSpan("unsampled-parent", {}, parent).end();
  tracer.startSpan("default-root", {}, ROOT_CONTEXT).end();
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "explicit-100",
    "omitted-retains-policy",
    "default-root",
  ]);
});

it("updates Azure spans, logs and page decisions without filtering caller log processors", async () => {
  const runId = crypto.randomUUID();
  const ingestionEndpoint = `${inject("ingestionEndpoint")}${runId}`;
  let pages = 0;
  const pipeline = await start({
    samplingPercentage: 0,
    azureMonitor: {
      connectionString: `InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=${ingestionEndpoint}`,
    },
    pageView: { applyCustomLogRecordData: () => pages++ },
  });
  const cached = clients();
  await vi.waitFor(() => expect(pages).toBe(1));
  emit(cached, "zero");
  await pipeline.handle.forceFlush();
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith(ingestionEndpoint)),
  ).toHaveLength(0);
  await pipeline.handle.updateCfg({ samplingPercentage: 100 });
  emit(cached, "hundred");
  // A route creates a new page operation using the current policy, not the startup policy.
  history.pushState(null, "", `${location.pathname}?dynamic-sampling=${runId}`);
  await vi.waitFor(() => expect(pages).toBe(2));
  await pipeline.handle.forceFlush();
  await pipeline.handle.updateCfg({ samplingPercentage: undefined });
  emit(cached, "native");
  cached.logger.emit({
    eventName: "native-unsampled-parent",
    body: "native-unsampled-parent",
    context: trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 }),
  });
  await pipeline.handle.forceFlush();

  const endpoint = new URL(ingestionEndpoint);
  const envelopes: AzureMonitorEnvelope[] = await fetch(
    `${endpoint.origin}/captured?runId=${runId}`,
  ).then((response) => response.json());
  expect(
    envelopes
      .filter(
        (envelope): envelope is AzureMonitorEnvelope<CustomEventData> =>
          envelope.data.baseType === "EventData",
      )
      .map((envelope) => envelope.data.baseData.name),
  ).toEqual(["hundred", "native", "native-unsampled-parent"]);
  expect(envelopes.filter((envelope) => envelope.data.baseType === "PageViewData")).toHaveLength(1);
  expect(
    envelopes.filter((envelope) => envelope.data.baseType === "RemoteDependencyData"),
  ).toHaveLength(2);
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "hundred",
    "native",
  ]);
  const records = pipeline.logExporter.getFinishedLogRecords();
  expect(records.filter((record) => record.eventName === "browser.page_view")).toHaveLength(2);
  expect(
    records
      .filter((record) => record.eventName !== "browser.page_view")
      .map((record) => record.eventName),
  ).toEqual(["zero", "hundred", "native", "native-unsampled-parent"]);
});

it("rejects invalid percentages and unknown paths atomically without advancing the revision", async () => {
  const pipeline = await start();
  const cached = clients();
  const patches = [
    ...[-1, 101, NaN, Infinity, "0", null].map((samplingPercentage) => ({ samplingPercentage })),
    { samplingPercentage: 0, unsupported: true },
  ];
  for (const patch of patches) {
    await expect(
      pipeline.handle.updateCfg(patch as MicrosoftOpenTelemetryBrowserConfigurationUpdate),
    ).rejects.toThrow();
    expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  }
  emit(cached, "still-sampled");
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "still-sampled",
  ]);
});

it("serializes captured patches, resets omissions in replacement mode and keeps no-op revisions", async () => {
  const pipeline = await start({ samplingPercentage: 100 });
  const cached = clients();
  const patch = { samplingPercentage: 0 };
  const first = pipeline.handle.updateCfg(patch);
  patch.samplingPercentage = 100;
  const second = pipeline.handle.updateCfg({ samplingPercentage: 100 });
  expect(await first).toEqual({ revision: 1, changedPaths: ["samplingPercentage"] });
  expect(await second).toEqual({ revision: 2, changedPaths: ["samplingPercentage"] });
  expect(await pipeline.handle.updateCfg({})).toEqual({ revision: 2, changedPaths: [] });
  expect(await pipeline.handle.updateCfg({}, false)).toEqual({
    revision: 3,
    changedPaths: ["samplingPercentage"],
  });
  expect(await pipeline.handle.updateCfg({}, false)).toEqual({ revision: 3, changedPaths: [] });
  emit(cached, "replacement-reset");
  const parent = trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 });
  cached.tracer.startSpan("default-unsampled-parent", {}, parent).end();
  await pipeline.handle.forceFlush();
  expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "replacement-reset",
  ]);
});

it("rejects queued and future updates once shutdown starts", async () => {
  const pipeline = await start();
  const queued = Promise.allSettled([
    pipeline.handle.updateCfg({ samplingPercentage: 0 }),
    pipeline.handle.updateCfg({ samplingPercentage: 100 }),
  ]);
  const shutdown = pipeline.handle.shutdown();
  expect((await queued).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  await shutdown;
  await expect(pipeline.handle.updateCfg({ samplingPercentage: 100 })).rejects.toThrow("stopped");
});

function syncHandle(pipeline: Awaited<ReturnType<typeof start>>) {
  expect(pipeline.handle.configSync).toBeDefined();
  return pipeline.handle.configSync!;
}

function dispatchConfiguration(name: string, cfg: object): void {
  globalThis.dispatchEvent(new CustomEvent(name, { detail: { cfg } }));
}

it("keeps default instances isolated until synchronization is explicitly configured", async () => {
  const publisher = await start({ samplingPercentage: 100 });
  const receiver = await start({ samplingPercentage: 100 });
  expect(publisher.handle.configSync).toBeUndefined();
  expect(receiver.handle.configSync).toBeUndefined();

  await publisher.handle.updateCfg({ samplingPercentage: 0 });
  emit(receiver.client, "default-instance-remains-local");
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "default-instance-remains-local",
  ]);
});

it("broadcasts only when requested and applies received sampling to cached clients", async () => {
  const publisher = await start({
    samplingPercentage: 100,
    extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 1 } },
  });
  const receiver = await start({
    extensionConfig: { AppInsightsCfgSyncPlugin: {} },
  });
  const cached = receiver.client;

  await publisher.handle.updateCfg({ samplingPercentage: 0 });
  emit(cached, "not-yet-broadcast");
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "not-yet-broadcast",
  ]);

  await syncHandle(publisher).sync();
  cached.tracer.startSpan("received-zero", {}, ROOT_CONTEXT).end();
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "not-yet-broadcast",
  ]);
});

it("synchronizes an explicit undefined sampling reset without adopting a receiver startup value", async () => {
  const publisher = await start({
    samplingPercentage: 0,
    extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 1 } },
  });
  const protectedReceiver = await start({
    samplingPercentage: 0,
    extensionConfig: { AppInsightsCfgSyncPlugin: {} },
  });
  const receiver = await start({
    extensionConfig: { AppInsightsCfgSyncPlugin: {} },
  });

  await publisher.handle.updateCfg({ samplingPercentage: 100 });
  await syncHandle(publisher).sync();
  emit(protectedReceiver.client, "startup-zero-is-private");
  emit(receiver.client, "received-100-before-reset");
  await Promise.all([protectedReceiver.handle.forceFlush(), receiver.handle.forceFlush()]);
  expect(protectedReceiver.spanExporter.getFinishedSpans()).toEqual([]);
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "received-100-before-reset",
  ]);

  await publisher.handle.updateCfg({ samplingPercentage: undefined });
  await syncHandle(publisher).sync();
  const parent = trace.setSpanContext(ROOT_CONTEXT, { ...createSpanContext(), traceFlags: 0 });
  receiver.client.tracer.startSpan("reset-restores-parent-sampling", {}, parent).end();
  receiver.client.tracer.startSpan("reset-keeps-root-sampling", {}, ROOT_CONTEXT).end();
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "received-100-before-reset",
    "reset-keeps-root-sampling",
  ]);
});

it("keeps all synchronized fields private after a local replacement", async () => {
  const publisher = await start({
    samplingPercentage: 0,
    extensionConfig: { AppInsightsCfgSyncPlugin: { syncMode: 1 } },
  });
  const receiver = await start({
    samplingPercentage: 100,
    extensionConfig: { AppInsightsCfgSyncPlugin: {} },
  });
  await receiver.handle.updateCfg({}, false);
  await syncHandle(publisher).sync();
  emit(receiver.client, "replacement-locks-sampling");
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "replacement-locks-sampling",
  ]);
});

it("uses a custom channel and honors nonOverrideConfigs for the three allowed fields", async () => {
  const channel = `cfg-sync-${crypto.randomUUID()}`;
  const publisher = await start({
    samplingPercentage: 0,
    extensionConfig: {
      AppInsightsCfgSyncPlugin: {
        syncMode: 1,
        customEvtName: channel,
        nonOverrideConfigs: { disableFetchTracking: true },
      },
    },
  });
  const receiver = await start({
    samplingPercentage: 100,
    extensionConfig: {
      AppInsightsCfgSyncPlugin: {
        customEvtName: channel,
        nonOverrideConfigs: { samplingPercentage: true },
      },
    },
  });
  await publisher.handle.updateCfg({ disableFetchTracking: true, disableAjaxTracking: true });
  await syncHandle(publisher).sync();
  emit(receiver.client, "receiver-sampling-is-excluded");
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "receiver-sampling-is-excluded",
  ]);
});

it("does not reopen an explicitly paused fetch instrumentation after a received gate update", async () => {
  const channel = `cfg-sync-${crypto.randomUUID()}`;
  const receiver = await start({
    extensionConfig: { AppInsightsCfgSyncPlugin: { customEvtName: channel } },
    instrumentations: [new FetchInstrumentation({ enabled: false })],
  });
  await receiver.handle.instrumentations.setEnabled("fetch", false);
  dispatchConfiguration(channel, { disableFetchTracking: true });
  dispatchConfiguration(channel, { disableFetchTracking: false });
  await vi.waitFor(async () => {
    await receiver.handle.forceFlush();
    expect(receiver.spanExporter.getFinishedSpans()).toEqual([]);
  });
  await fetch("data:text/plain,config-sync-manual-pause");
  await receiver.handle.forceFlush();
  expect(receiver.spanExporter.getFinishedSpans()).toEqual([]);
});

it("isolates malformed events, removes listeners on shutdown, and preserves other receivers", async () => {
  const channel = `cfg-sync-${crypto.randomUUID()}`;
  const errors = vi.fn();
  const first = await start({
    extensionConfig: { AppInsightsCfgSyncPlugin: { customEvtName: channel, onError: errors } },
  });
  const second = await start({
    extensionConfig: { AppInsightsCfgSyncPlugin: { customEvtName: channel } },
  });
  const malformed = Object.defineProperty({}, "samplingPercentage", {
    get: () => 0,
  });
  dispatchConfiguration(channel, malformed);
  await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
  dispatchConfiguration(channel, { samplingPercentage: 0 });
  await second.handle.updateCfg({});
  second.client.tracer.startSpan("second-received-after-error", {}, ROOT_CONTEXT).end();
  await second.handle.forceFlush();
  expect(second.spanExporter.getFinishedSpans()).toEqual([]);

  await first.handle.shutdown();
  dispatchConfiguration(channel, { samplingPercentage: 100 });
  first.client.tracer.startSpan("shutdown-receiver-stays-stopped", {}, ROOT_CONTEXT).end();
  expect(first.spanExporter.getFinishedSpans()).toEqual([]);
});
