// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ROOT_CONTEXT,
  context,
  diag,
  propagation,
  trace,
  type ContextAPI,
  type DiagAPI,
  type PropagationAPI,
  type TraceAPI,
  type Tracer,
} from "@opentelemetry/api";
import { logs, type LoggerProvider } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { expect, inject, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../src/index.js";
import type {
  BrowserInstrumentation,
  InstrumentationOptions,
} from "../../src/instrumentation/browserInstrumentation/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";
import { loadBrowserScript as loadScript } from "../fixtures/browserBundle.js";

interface BrowserBundle {
  readonly context: ContextAPI;
  readonly diag: DiagAPI;
  readonly logs: LoggerProvider & { getLoggerProvider(): LoggerProvider; disable(): void };
  readonly propagation: PropagationAPI;
  readonly trace: TraceAPI;
  readonly OPENTELEMETRY_BROWSER_VERSION: string;
  getInstrumentations(options?: InstrumentationOptions): Promise<BrowserInstrumentation[]>;
  useMicrosoftOpenTelemetry(
    options?: MicrosoftOpenTelemetryBrowserOptions,
  ): Promise<MicrosoftOpenTelemetryBrowser>;
}

interface InstrumentationBundle {
  getInstrumentations(options?: InstrumentationOptions): Promise<BrowserInstrumentation[]>;
}

interface AmdDefine {
  (dependencies: string[], factory: (exports: Record<string, unknown>) => void): void;
  amd?: object;
}

declare global {
  interface Window {
    Microsoft?: {
      OpenTelemetry?: BrowserBundle;
      OpenTelemetryInstrumentations?: InstrumentationBundle;
    };
    define?: AmdDefine;
  }
}

function getBrowserBundle(): BrowserBundle | undefined {
  return window.Microsoft?.OpenTelemetry;
}

function getInstrumentationBundle(): InstrumentationBundle | undefined {
  return window.Microsoft?.OpenTelemetryInstrumentations;
}

function preserveAmdDefine(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "define");
  return () => {
    if (descriptor) {
      Object.defineProperty(window, "define", descriptor);
    } else {
      delete window.define;
    }
  };
}

function captureAmdDefine<T>(): { define: AmdDefine; getRegistration: (file: string) => T } {
  let registration: { dependencies: string[]; exports: Record<string, unknown> } | undefined;
  const define: AmdDefine = (dependencies, factory) => {
    const exports = {};
    factory(exports);
    registration = { dependencies, exports };
  };
  define.amd = {};
  return {
    define,
    // The UMD wrapper calls `define` while the script executes, so it has run before `load` fires.
    getRegistration: (file) => {
      if (!registration) throw new Error(`${file} did not call AMD define`);
      expect(registration.dependencies).toEqual(["exports"]);
      return registration.exports as unknown as T;
    },
  };
}

async function exercise(bundle: BrowserBundle): Promise<void> {
  await expect(
    bundle.useMicrosoftOpenTelemetry({
      azureMonitor: {
        connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
        sdkStats: { enabled: true },
      },
    }),
  ).rejects.toThrow("Customer SDK Stats is only available through the npm package.");
  // The opt-in resource detectors are npm-only.
  for (const name of [
    "BrowserDetector",
    "browserDetector",
    "UserAgentDetector",
    "userAgentDetector",
  ]) {
    expect(name in bundle).toBe(false);
  }
  // Every instrumentation is inlined, so constructing them all loads nothing else.
  const instrumentations = await bundle.getInstrumentations({
    console: { enabled: true },
    errors: { enabled: true },
    navigation: { enabled: true },
    navigationTiming: { enabled: true },
    resourceTiming: { enabled: true },
    userAction: { enabled: true },
    webVitals: { enabled: true },
  });
  expect(
    instrumentations.map(
      (instrumentation) =>
        (instrumentation as unknown as { instrumentationName: string }).instrumentationName,
    ),
  ).toEqual([
    "@opentelemetry/browser-instrumentation/fetch",
    "@opentelemetry/browser-instrumentation/xhr",
    "@opentelemetry/browser-instrumentation/console",
    "@opentelemetry/browser-instrumentation/errors",
    "@opentelemetry/browser-instrumentation/navigation",
    "@opentelemetry/browser-instrumentation/navigation-timing",
    "@opentelemetry/browser-instrumentation/resource-timing",
    "@opentelemetry/browser-instrumentation/user-action",
    "@opentelemetry/browser-instrumentation/web-vitals",
  ]);

  const pipeline = createInMemoryPipeline();
  const telemetry = await bundle.useMicrosoftOpenTelemetry({
    ...pipeline.options,
    pageView: { enabled: false },
  });
  try {
    bundle.trace.getTracer("module-format-test").startSpan("module-format").end();
    bundle.logs.getLogger("module-format-test").emit({ eventName: "module-format" });
    await telemetry.forceFlush();

    expect(pipeline.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "module-format",
    ]);
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.eventName)).toEqual([
      "module-format",
    ]);
  } finally {
    try {
      await telemetry.shutdown();
    } finally {
      bundle.trace.disable();
      bundle.logs.disable();
      bundle.propagation.disable();
      bundle.context.disable();
      bundle.diag.disable();
    }
  }
}

it.each([
  "opentelemetry-browser.umd.js",
  "opentelemetry-browser.umd.min.js",
  "opentelemetry-browser.iife.js",
  "opentelemetry-browser.iife.min.js",
])("loads and initializes the %s global bundle", async (file) => {
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    const bundle = getBrowserBundle();
    if (!bundle) throw new Error(`${file} did not define Microsoft.OpenTelemetry`);
    expect(bundle.OPENTELEMETRY_BROWSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    await exercise(bundle);
  } finally {
    script?.remove();
    delete window.Microsoft;
    restoreDefine();
  }
});

it.each(["opentelemetry-browser.umd.js", "opentelemetry-browser.umd.min.js"])(
  "loads and initializes the %s bundle through AMD/RequireJS",
  async (file) => {
    const restoreDefine = preserveAmdDefine();
    const { define, getRegistration } = captureAmdDefine<BrowserBundle>();
    window.define = define;

    let script: HTMLScriptElement | undefined;
    try {
      script = await loadScript(file);
      await exercise(getRegistration(file));
    } finally {
      script?.remove();
      restoreDefine();
    }
  },
);

it.each(["source", "bundle"] as const)(
  "synchronizes sampling from the %s publisher across source and minified IIFE copies",
  async (publisherCopy) => {
    const restoreDefine = preserveAmdDefine();
    const microsoft = Object.getOwnPropertyDescriptor(window, "Microsoft");
    delete window.define;
    delete window.Microsoft;
    const channel = `module-format-sync-${crypto.randomUUID()}`;
    const events: Event[] = [];
    const observe = (event: Event) => events.push(event);
    const handles: MicrosoftOpenTelemetryBrowser[] = [];
    let script: HTMLScriptElement | undefined;
    let bundle: BrowserBundle | undefined;
    globalThis.addEventListener(channel, observe);
    try {
      script = await loadScript("opentelemetry-browser.iife.min.js");
      bundle = getBrowserBundle();
      if (!bundle) throw new Error("The minified IIFE bundle did not load");
      const publisherInit =
        publisherCopy === "source" ? useMicrosoftOpenTelemetry : bundle.useMicrosoftOpenTelemetry;
      const receiverInit =
        publisherCopy === "source" ? bundle.useMicrosoftOpenTelemetry : useMicrosoftOpenTelemetry;

      async function start(
        initialize: typeof useMicrosoftOpenTelemetry,
        role: "publisher" | "receiver",
      ) {
        const pipeline = createInMemoryPipeline();
        let tracer!: Tracer;
        const handle = await initialize({
          ...pipeline.options,
          resource: resourceFromAttributes({ "service.name": `sync-${role}` }),
          pageView: { enabled: false },
          session: { enabled: false },
          userContext: { enabled: false },
          ...(role === "publisher" ? { samplingPercentage: 0 } : {}),
          extensionConfig: {
            AppInsightsCfgSyncPlugin: {
              ...(role === "publisher" ? { syncMode: 1 as const } : {}),
              customEvtName: channel,
            },
          },
          instrumentations: [
            {
              setTracerProvider(provider) {
                tracer = provider.getTracer("sync-bundle");
              },
              getConfig: () => ({ enabled: true }),
              enable() {},
              disable() {},
            },
          ],
        });
        handles.push(handle);
        expect(tracer).toBeDefined();
        return { ...pipeline, handle, tracer };
      }

      const publisher = await start(publisherInit, "publisher");
      const receiver = await start(receiverInit, "receiver");
      const publisherSync = publisher.handle.configSync;
      const receiverSync = receiver.handle.configSync;
      if (!publisherSync || !receiverSync) throw new Error("Configuration sync was not enabled");

      await publisher.handle.updateCfg({ disableFetchTracking: true, disableAjaxTracking: true });
      receiver.tracer.startSpan("before-publish", {}, ROOT_CONTEXT).end();
      await receiver.handle.forceFlush();
      expect(events).toHaveLength(0);
      expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "before-publish",
      ]);

      await publisherSync.sync();
      await receiver.handle.updateCfg({}); // Wait for the receiver's queued event update.
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(CustomEvent);
      const detail = (events[0] as CustomEvent<{ cfg: Record<string, unknown> }>).detail;
      expect(detail.cfg).toEqual({
        samplingPercentage: 0,
        disableFetchTracking: true,
        disableAjaxTracking: true,
      });
      receiver.tracer.startSpan("received-zero", {}, ROOT_CONTEXT).end();
      await receiver.handle.forceFlush();
      expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "before-publish",
      ]);

      receiverSync.pause();
      await publisher.handle.updateCfg({ samplingPercentage: 100 });
      expect(events).toHaveLength(1);
      await publisherSync.sync();
      await receiver.handle.updateCfg({});
      receiverSync.resume();
      receiver.tracer.startSpan("paused-delivery", {}, ROOT_CONTEXT).end();
      await receiver.handle.forceFlush();
      expect(events).toHaveLength(2);
      expect(receiver.spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        "before-publish",
      ]);

      await publisherSync.sync();
      await receiver.handle.updateCfg({});
      receiver.tracer.startSpan("received-100", {}, ROOT_CONTEXT).end();
      publisher.tracer.startSpan("publisher-100", {}, ROOT_CONTEXT).end();
      await Promise.all([publisher.handle.forceFlush(), receiver.handle.forceFlush()]);
      expect(events).toHaveLength(3);
      const receiverSpans = receiver.spanExporter.getFinishedSpans();
      const publisherSpans = publisher.spanExporter.getFinishedSpans();
      expect(receiverSpans.map((span) => span.name)).toEqual(["before-publish", "received-100"]);
      expect(publisherSpans.map((span) => span.name)).toEqual(["publisher-100"]);
      expect(receiverSpans.map((span) => span.resource.attributes["service.name"])).toEqual([
        "sync-receiver",
        "sync-receiver",
      ]);
      expect(publisherSpans[0]?.resource.attributes["service.name"]).toBe("sync-publisher");
    } finally {
      try {
        await Promise.all(handles.map((handle) => handle.shutdown()));
      } finally {
        globalThis.removeEventListener(channel, observe);
        for (const api of [bundle, { trace, logs, propagation, context, diag }]) {
          api?.trace.disable();
          api?.logs.disable();
          api?.propagation.disable();
          api?.context.disable();
          api?.diag.disable();
        }
        script?.remove();
        if (microsoft) Object.defineProperty(window, "Microsoft", microsoft);
        else delete window.Microsoft;
        restoreDefine();
      }
    }
  },
);

it("records dependencies from the minified instrumentation bundle in the minified SDK bundle", async () => {
  // Each minified bundle shortens `_` properties independently. The SDK must still adapt
  // instrumentations from the other bundle through the reserved cross-bundle members.
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  const scripts: HTMLScriptElement[] = [];
  try {
    scripts.push(await loadScript("opentelemetry-browser.iife.min.js"));
    scripts.push(await loadScript("opentelemetry-browser-instrumentations.iife.min.js"));
    const bundle = getBrowserBundle();
    const instrumentationBundle = getInstrumentationBundle();
    if (!bundle || !instrumentationBundle) throw new Error("A minified bundle did not load");

    const pipeline = createInMemoryPipeline();
    const telemetry = await bundle.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: await instrumentationBundle.getInstrumentations({
        xhr: { enabled: false },
      }),
    });
    try {
      try {
        await fetch(new URL("/cross-bundle-dependency", location.origin));
      } catch {
        // Only the captured dependency matters.
      }
      // Firefox ends fetch spans after the response settles, so wait for the exported span.
      await expect
        .poll(async () => {
          await telemetry.forceFlush();
          return pipeline.spanExporter
            .getFinishedSpans()
            .some((span) =>
              String(span.attributes["url.full"]).endsWith("/cross-bundle-dependency"),
            );
        })
        .toBe(true);
    } finally {
      try {
        await telemetry.shutdown();
      } finally {
        bundle.trace.disable();
        bundle.logs.disable();
        bundle.propagation.disable();
        bundle.context.disable();
        bundle.diag.disable();
      }
    }
  } finally {
    for (const script of scripts) script.remove();
    delete window.Microsoft;
    restoreDefine();
  }
});

async function withSeparateInstrumentationBundle(
  file: string,
  run: (bundle: BrowserBundle, instrumentations: InstrumentationBundle) => Promise<void>,
): Promise<void> {
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  const scripts: HTMLScriptElement[] = [];
  let bundle: BrowserBundle | undefined;
  try {
    scripts.push(await loadScript("opentelemetry-browser.iife.min.js"));
    bundle = getBrowserBundle();
    scripts.push(await loadScript(file));
    const instrumentations = getInstrumentationBundle();
    if (!bundle || !instrumentations) throw new Error("A browser bundle did not load");
    await run(bundle, instrumentations);
  } finally {
    bundle?.trace.disable();
    bundle?.logs.disable();
    bundle?.propagation.disable();
    bundle?.context.disable();
    bundle?.diag.disable();
    vi.restoreAllMocks();
    for (const script of scripts) script.remove();
    delete window.Microsoft;
    restoreDefine();
  }
}

function sendOpenedXhr(xhr: XMLHttpRequest): Promise<{ traceparent?: string }> {
  return new Promise((resolve, reject) => {
    xhr.onload = () => resolve(JSON.parse(xhr.responseText) as { traceparent?: string });
    xhr.onerror = () => reject(new Error("XHR failed"));
    xhr.send();
  });
}

it.each([
  "opentelemetry-browser-instrumentations.iife.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
])("preserves XHR open semantics across the minified SDK and %s", async (file) => {
  await withSeparateInstrumentationBundle(file, async (bundle, instrumentations) => {
    const endpoint = new URL("/headers", inject("redirectEndpoint")).href;
    const ignored = `${endpoint}#ignored`;
    const pipeline = createInMemoryPipeline();
    const telemetry = await bundle.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: await instrumentations.getInstrumentations({
        fetch: { enabled: false },
        xhr: { ignoreUrls: [ignored], propagateTraceHeaderCorsUrls: [endpoint] },
      }),
    });
    try {
      // The first tracked open is never sent; the ignored reopen must replace it.
      const ignoredXhr = new XMLHttpRequest();
      const setHeader = vi.spyOn(ignoredXhr, "setRequestHeader");
      ignoredXhr.open("GET", endpoint);
      ignoredXhr.open("GET", ignored);
      const ignoredHeaders = await sendOpenedXhr(ignoredXhr);
      await telemetry.forceFlush();
      expect(setHeader).not.toHaveBeenCalled();
      expect(ignoredHeaders.traceparent).toBeUndefined();
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(0);

      // A native validation failure must instead preserve the earlier tracked open.
      const trackedXhr = new XMLHttpRequest();
      trackedXhr.open("GET", endpoint);
      expect(() => trackedXhr.open("invalid method", `${endpoint}#replacement`)).toThrow();
      const trackedHeaders = await sendOpenedXhr(trackedXhr);
      await expect
        .poll(async () => {
          await telemetry.forceFlush();
          return pipeline.spanExporter.getFinishedSpans().length;
        })
        .toBe(1);
      const [span] = pipeline.spanExporter.getFinishedSpans();
      expect(span.attributes["url.full"]).toBe(endpoint);
      expect(trackedHeaders.traceparent?.split("-")[2]).toBe(span.spanContext().spanId);
    } finally {
      await telemetry.shutdown();
    }
  });
});

it.each([
  "opentelemetry-browser-instrumentations.iife.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
])("cuts over dynamic XHR registrations across the minified SDK and %s", async (file) => {
  await withSeparateInstrumentationBundle(file, async (bundle, instrumentations) => {
    const endpoint = new URL("/headers", inject("redirectEndpoint")).href;
    const [original] = await instrumentations.getInstrumentations({
      fetch: { enabled: false },
      xhr: {
        applyCustomAttributesOnSpan: (span) => span.setAttribute("registration", "original"),
        propagateTraceHeaderCorsUrls: [endpoint],
      },
    });
    const [replacement] = await instrumentations.getInstrumentations({
      fetch: { enabled: false },
      xhr: {
        applyCustomAttributesOnSpan: (span) => span.setAttribute("registration", "replacement"),
        propagateTraceHeaderCorsUrls: [endpoint],
      },
    });
    if (!original || !replacement) throw new Error("XHR instrumentation was not created");

    const pipeline = createInMemoryPipeline();
    const telemetry = await bundle.useMicrosoftOpenTelemetry({
      ...pipeline.options,
      pageView: { enabled: false },
      instrumentations: [],
    });
    try {
      await telemetry.instrumentations.add("bundle-xhr", original);
      const firstXhr = new XMLHttpRequest();
      firstXhr.open("GET", endpoint);
      const firstHeaders = await sendOpenedXhr(firstXhr);
      await expect
        .poll(async () => {
          await telemetry.forceFlush();
          return pipeline.spanExporter.getFinishedSpans().length;
        })
        .toBe(1);
      expect(firstHeaders.traceparent).toBeDefined();
      expect(pipeline.spanExporter.getFinishedSpans()[0]?.attributes).toMatchObject({
        "url.full": endpoint,
        registration: "original",
      });

      await telemetry.instrumentations.replace("bundle-xhr", replacement);
      const secondXhr = new XMLHttpRequest();
      secondXhr.open("GET", endpoint);
      const secondHeaders = await sendOpenedXhr(secondXhr);
      await expect
        .poll(async () => {
          await telemetry.forceFlush();
          return pipeline.spanExporter.getFinishedSpans().length;
        })
        .toBe(2);
      expect(secondHeaders.traceparent).toBeDefined();
      expect(pipeline.spanExporter.getFinishedSpans()[1]?.attributes).toMatchObject({
        "url.full": endpoint,
        registration: "replacement",
      });

      await telemetry.instrumentations.add("released-original", original);
      await telemetry.instrumentations.remove("released-original");
      await telemetry.instrumentations.remove("bundle-xhr");
      const removedXhr = new XMLHttpRequest();
      removedXhr.open("GET", endpoint);
      const removedHeaders = await sendOpenedXhr(removedXhr);
      await telemetry.forceFlush();
      expect(removedHeaders.traceparent).toBeUndefined();
      expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(2);
    } finally {
      await telemetry.shutdown();
    }
  });
});

it.each([
  ["opentelemetry-browser-instrumentations.iife.min.js", "disable"],
  ["opentelemetry-browser-instrumentations.iife.min.js", "shutdown"],
  ["opentelemetry-browser-instrumentations.iife.js", "disable"],
  ["opentelemetry-browser-instrumentations.iife.js", "shutdown"],
] as const)(
  "cleans up errors listeners from %s after partial %s removal",
  async (file, operation) => {
    await withSeparateInstrumentationBundle(file, async (bundle, instrumentations) => {
      const capture = vi.fn(() => ({}));
      const selected = await instrumentations.getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
        errors: { enabled: true, applyCustomAttributes: capture },
      });
      const add = vi.spyOn(window, "addEventListener");
      const nativeRemove = window.removeEventListener.bind(window);
      const remove = vi.spyOn(window, "removeEventListener");
      const pipeline = createInMemoryPipeline();
      let telemetry: MicrosoftOpenTelemetryBrowser | undefined;
      let shutdownAttempted = false;
      try {
        telemetry = await bundle.useMicrosoftOpenTelemetry({
          ...pipeline.options,
          pageView: { enabled: false },
          instrumentations: selected,
        });
        const handler = add.mock.calls.find(([name]) => name === "unhandledrejection")?.[1];
        if (!handler) throw new Error("Errors listener was not registered");
        expect(add).toHaveBeenCalledWith("error", handler);

        // Invoke the registered callback without sending synthetic failures to Vitest's own
        // global error listeners. Native listener removal is checked below for every handler.
        const notify = (event: Event) => {
          if (typeof handler === "function") handler.call(window, event);
          else handler.handleEvent(event);
        };
        notify(new ErrorEvent("error", { message: "cross-bundle error" }));
        notify(
          new PromiseRejectionEvent("unhandledrejection", {
            promise: Promise.resolve(),
            reason: new Error("cross-bundle rejection"),
          }),
        );
        expect(capture).toHaveBeenCalledTimes(2);

        let failed = false;
        const removed: { name: string; listener: EventListenerOrEventListenerObject | null }[] = [];
        remove.mockImplementation((...args) => {
          if (!failed && args[0] === "error" && args[1] === handler) {
            failed = true;
            throw new Error("partial errors removal failed");
          }
          nativeRemove(...args);
          removed.push({ name: args[0], listener: args[1] });
        });
        if (operation === "disable") {
          await expect(telemetry.instrumentations.setEnabled("errors", false)).rejects.toThrow(
            "partial errors removal failed",
          );
          expect(removed).toContainEqual({ name: "error", listener: handler });
          expect(removed).toContainEqual({ name: "unhandledrejection", listener: handler });
          shutdownAttempted = true;
          await telemetry.shutdown();
        } else {
          shutdownAttempted = true;
          await expect(telemetry.shutdown()).rejects.toThrow("partial errors removal failed");
        }

        // Rollback can register another handler; shutdown must remove every registered pair.
        const handlers = add.mock.calls
          .filter(([name]) => name === "unhandledrejection")
          .map(([, listener]) => listener);
        for (const listener of handlers) {
          expect(removed).toContainEqual({ name: "error", listener });
          expect(removed).toContainEqual({ name: "unhandledrejection", listener });
        }
        expect(capture).toHaveBeenCalledTimes(2);
      } finally {
        try {
          if (telemetry && !shutdownAttempted) await telemetry.shutdown();
        } finally {
          // Remove observed listeners even if an assertion fails before normal cleanup.
          for (const [name, listener] of add.mock.calls) {
            if (name !== "unhandledrejection" || !listener) continue;
            nativeRemove("error", listener);
            nativeRemove("unhandledrejection", listener);
          }
        }
      }
    });
  },
);

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
  "opentelemetry-browser-instrumentations.iife.js",
  "opentelemetry-browser-instrumentations.iife.min.js",
])("loads the %s global instrumentation bundle", async (file) => {
  const restoreDefine = preserveAmdDefine();
  delete window.define;
  delete window.Microsoft;
  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    const bundle = getInstrumentationBundle();
    expect(typeof bundle?.getInstrumentations).toBe("function");
    expect(
      await bundle?.getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    script?.remove();
    delete window.Microsoft;
    restoreDefine();
  }
});

it.each([
  "opentelemetry-browser-instrumentations.umd.js",
  "opentelemetry-browser-instrumentations.umd.min.js",
])("loads the %s instrumentation bundle through AMD/RequireJS", async (file) => {
  const restoreDefine = preserveAmdDefine();
  const { define, getRegistration } = captureAmdDefine<InstrumentationBundle>();
  window.define = define;

  let script: HTMLScriptElement | undefined;
  try {
    script = await loadScript(file);
    expect(
      await getRegistration(file).getInstrumentations({
        fetch: { enabled: false },
        xhr: { enabled: false },
      }),
    ).toEqual([]);
  } finally {
    script?.remove();
    restoreDefine();
  }
});
