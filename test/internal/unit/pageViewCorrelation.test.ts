// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  context,
  createContextKey,
  diag,
  isSpanContextValid,
  propagation,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { PageViewCorrelation } from "../../../src/instrumentation/pageView/pageViewCorrelation.js";
import { createPageViewContext } from "../../../src/instrumentation/pageView/pageViewContext.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const originalUrl = location.href;
const originalTitle = document.title;
const originalPush = history.pushState;
const originalReplace = history.replaceState;
let handle: MicrosoftOpenTelemetryBrowser | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  history.pushState = originalPush;
  history.replaceState = originalReplace;
  document.title = originalTitle;
  if (location.href !== originalUrl) history.replaceState(null, "", originalUrl);
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
});

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
  const onSpan = vi.spyOn(pipeline.spanProcessor, "onStart");
  handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, ...options });
  return {
    ...pipeline,
    onLog,
    onSpan,
    tracer: trace.getTracer("test"),
    logger: logs.getLogger("test"),
  };
}

/** Resolves after the page-view soft-navigation settle heuristic. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  });
}

it("keeps page views, child spans, logs and propagation correlated with an all-zero RNG", async () => {
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => array);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const pipeline = await start();
  const operation = trace.getSpanContext(context.active())!;
  expect(isSpanContextValid(operation)).toBe(true);

  const span = pipeline.tracer.startSpan("child");
  span.end();
  expect(span.spanContext().traceId).toBe(operation.traceId);
  pipeline.logger.emit({ body: "correlated" });
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext?.traceId).toBe(operation.traceId);
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  expect(headers.traceparent?.split("-")[1]).toBe(operation.traceId);

  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onLog.mock.calls.find(
    ([record]) => record.eventName === "browser.page_view",
  )![0];
  expect(page.spanContext?.traceId).toBe(operation.traceId);
  expect(page.attributes["browser.page_view.id"]).toBe(operation.traceId);
});

it.each([false, true])(
  "omits synthetic Azure Monitor parents without changing native context (logsOnly=%s)",
  async (logsOnly) => {
    const pipeline = await start(logsOnly ? { spanProcessors: [] } : {});
    pipeline.logger.emit({ body: "page log" });
    const log = pipeline.onLog.mock.calls.at(-1)![0];
    const operation = log.spanContext!;
    expect(isSpanContextValid(operation)).toBe(true);

    window.dispatchEvent(new Event("pagehide"));
    const page = pipeline.onLog.mock.calls.find(
      ([record]) => record.eventName === "browser.page_view",
    )![0];
    for (const record of [log, page]) {
      const envelope = logToEnvelope(record, "key");
      expect(envelope.tags["ai.operation.id"]).toBe(operation.traceId);
      expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
      expect(record.spanContext).toBe(operation);
    }

    if (!logsOnly) {
      pipeline.tracer.startSpan("page dependency").end();
      await pipeline.spanProcessor.forceFlush();
      const [span] = pipeline.spanExporter.getFinishedSpans();
      const envelope = spanToEnvelope(span, "key");
      expect(envelope.tags["ai.operation.id"]).toBe(operation.traceId);
      expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
      expect(span.parentSpanContext).toBe(operation);
      expect(isSpanContextValid(span.spanContext())).toBe(true);
    }

    await handle!.shutdown();
    expect(logToEnvelope(page, "key").tags).not.toHaveProperty("ai.operation.parentId");
    expect(isSpanContextValid(operation)).toBe(true);
  },
);

it.each([false, true])(
  "uses one operation ID for the page, logs, spans and propagation (Navigation API=%s)",
  async (useNavigationApiIfAvailable) => {
    const navigation = new NavigationInstrumentation({
      enabled: false,
      useNavigationApiIfAvailable,
    });
    const pipeline = await start({
      instrumentations: [navigation],
      pageView: {
        routeResolver: () => location.pathname,
        sanitizeUrl: (url) => new URL(url).pathname,
      },
    });
    const ids: string[] = [];
    for (const path of ["/checkout", "/confirmation"]) {
      history.pushState(null, "", path);
      const span = pipeline.tracer.startSpan(path);
      span.end();
      const id = span.spanContext().traceId;
      ids.push(id);
      pipeline.logger.emit({ body: path });
      const log = pipeline.onLog.mock.calls.at(-1)![0];
      const headers: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), headers);
      expect(headers.traceparent?.split("-")[1]).toBe(id);
      expect(log.spanContext?.traceId).toBe(id);
      const anonymousUserId = log.attributes["enduser.pseudo.id"];
      const sessionId = log.attributes["session.id"];
      expect(anonymousUserId).toMatch(/^[0-9a-f]{32}$/);
      expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
      expect(log.attributes).toEqual({
        "enduser.pseudo.id": anonymousUserId,
        "session.id": sessionId,
      });
      expect(pipeline.onSpan.mock.calls.at(-1)![0].attributes).toEqual({
        "enduser.pseudo.id": anonymousUserId,
        "session.id": sessionId,
      });
      const routeLog = pipeline.onLog.mock.calls.find(
        ([record]) =>
          record.eventName === "browser.navigation" &&
          record.attributes["url.full"] === location.href,
      )![0];
      expect(routeLog.spanContext?.traceId).toBe(id);
      expect(routeLog.attributes["enduser.pseudo.id"]).toBe(anonymousUserId);
      window.dispatchEvent(new Event("pagehide"));
      const page = pipeline.onLog.mock.calls.find(
        ([record]) =>
          record.eventName === "browser.page_view" &&
          record.attributes["browser.page_view.id"] === id,
      )![0];
      const envelope = logToEnvelope(page, "key");
      expect(envelope.tags["ai.operation.id"]).toBe(id);
      expect(envelope.tags).not.toHaveProperty("ai.operation.parentId");
      expect(envelope.data).toMatchObject({
        baseType: "PageViewData",
        baseData: { id, url: path },
      });
      expect(logToEnvelope(log, "key").tags["ai.operation.id"]).toBe(id);
      expect(logToEnvelope(log, "key").tags).not.toHaveProperty("ai.operation.parentId");
      expect(logToEnvelope(routeLog, "key").tags).not.toHaveProperty("ai.operation.parentId");
      expect(logToEnvelope(routeLog, "key").tags["ai.operation.name"]).toBe(path);
      expect(logToEnvelope(routeLog, "key").data).toMatchObject({
        baseType: "PageViewData",
        baseData: { id },
      });
    }
    expect(ids[0]).not.toBe(ids[1]);
    await pipeline.spanProcessor.forceFlush();
    expect(
      pipeline.spanExporter
        .getFinishedSpans()
        .map((span) => spanToEnvelope(span, "key").tags["ai.operation.id"]),
    ).toEqual(ids);
    for (const span of pipeline.spanExporter.getFinishedSpans()) {
      expect(spanToEnvelope(span, "key").tags).not.toHaveProperty("ai.operation.parentId");
    }
  },
);

it("preserves explicit contexts and in-flight spans across navigation with a custom manager", async () => {
  const manager = new StackContextManager();
  const enabled = vi.spyOn(manager, "enable");
  const pipeline = await start({ traces: { contextManager: manager } });
  const parent = pipeline.tracer.startSpan("in-flight");
  const original = parent.spanContext();
  const bound = context.bind(trace.setSpan(ROOT_CONTEXT, parent), () => {
    pipeline.logger.emit({ body: "old operation" });
    const child = pipeline.tracer.startSpan("child");
    expect(child.spanContext().traceId).toBe(original.traceId);
    child.end();
  });
  history.pushState(null, "", "/new");
  bound();
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext).toEqual(original);
  expect(
    logToEnvelope(pipeline.onLog.mock.calls.at(-1)![0], "key").tags["ai.operation.parentId"],
  ).toBe(original.spanId);
  pipeline.logger.emit({ body: "new operation" });
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext?.traceId).not.toBe(original.traceId);
  parent.end();
  expect(parent.spanContext()).toEqual(original);
  expect(enabled).toHaveBeenCalledOnce();
  await pipeline.spanProcessor.forceFlush();
  const child = pipeline.spanExporter.getFinishedSpans().find((span) => span.name === "child")!;
  expect(spanToEnvelope(child, "key").tags["ai.operation.parentId"]).toBe(original.spanId);
});

it("keeps a delayed page callback's operation name aligned with its operation ID", async () => {
  const pipeline = await start({ pageView: { routeResolver: () => location.pathname } });
  const firstContext = context.active();
  const firstOperation = trace.getSpanContext(firstContext)!;
  const firstName = location.pathname;
  const delayed = context.bind(firstContext, () => {
    pipeline.logger.emit({ body: "delayed page log" });
    pipeline.tracer.startSpan("delayed page span").end();
  });

  history.pushState(null, "", "/next-page");
  expect(trace.getSpanContext(context.active())?.traceId).not.toBe(firstOperation.traceId);
  delayed();
  await pipeline.forceFlush();

  const log = pipeline.onLog.mock.calls.find(([record]) => record.body === "delayed page log")![0];
  const span = pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "delayed page span")!;
  expect(log.spanContext?.traceId).toBe(firstOperation.traceId);
  expect(span.parentSpanContext?.traceId).toBe(firstOperation.traceId);
  for (const envelope of [logToEnvelope(log, "key"), spanToEnvelope(span, "key")]) {
    expect(envelope.tags["ai.operation.id"]).toBe(firstOperation.traceId);
    expect(envelope.tags["ai.operation.name"]).toBe(firstName);
  }
});

it("keeps the route name captured before page settlement", async () => {
  let route = "/previous";
  const pipeline = await start({ pageView: { routeResolver: () => route } });
  await settle();

  history.pushState(null, "", "/checkout");
  const operation = trace.getSpanContext(context.active())!;
  pipeline.logger.emit({ body: "before route settlement" });
  const span = pipeline.tracer.startSpan("before route settlement");
  route = "/checkout";
  await settle();
  span.end();
  await pipeline.forceFlush();

  const log = pipeline.onLog.mock.calls.find(
    ([record]) => record.body === "before route settlement",
  )![0];
  const exportedSpan = pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "before route settlement")!;
  for (const envelope of [logToEnvelope(log, "key"), spanToEnvelope(exportedSpan, "key")]) {
    expect(envelope.tags["ai.operation.id"]).toBe(operation.traceId);
    expect(envelope.tags["ai.operation.name"]).toBe("/previous");
  }
});

it("does not revise captured telemetry when the page settles to a title", async () => {
  document.title = "Checkout 8472";
  let route: string | undefined = "/previous";
  const pipeline = await start({ pageView: { routeResolver: () => route } });
  await settle();

  history.pushState(null, "", "/checkout/8472");
  pipeline.logger.emit({ body: "before title settlement" });
  const span = pipeline.tracer.startSpan("before title settlement");
  route = undefined;
  await settle();
  span.end();
  await pipeline.forceFlush();

  const log = pipeline.onLog.mock.calls.find(
    ([record]) => record.body === "before title settlement",
  )![0];
  const exportedSpan = pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "before title settlement")!;
  for (const envelope of [logToEnvelope(log, "key"), spanToEnvelope(exportedSpan, "key")]) {
    expect(envelope.tags["ai.operation.name"]).toBe("/previous");
  }
});

it("bounds retained operation names while keeping recently used delayed operations", async () => {
  const pageViews = createPageViewContext();
  const correlation = new PageViewCorrelation(undefined, pageViews);
  const publish = (index: number): string => {
    const id = (index + 1).toString(16).padStart(32, "0");
    pageViews.setCurrentPageView({
      id,
      index,
      name: `/route/${index}`,
      nameSource: "route",
      url: `https://example.test/route/${index}`,
      referrer: "",
      navigationType: "push",
      sameDocument: true,
      startTimeUnixMs: index,
    });
    return id;
  };

  const first = publish(0);
  const second = publish(1);
  for (let index = 2; index < 32; index++) publish(index);
  expect(correlation.operationName(first)).toBe("/route/0");

  const newest = publish(32);
  expect(correlation.operationName(first)).toBe("/route/0");
  expect(correlation.operationName(second)).toBeUndefined();
  expect(correlation.operationName(newest)).toBe("/route/32");
  await correlation.shutdown();
});

it("refreshes the operation ID and name together inside an earlier History wrapper", async () => {
  const state: { pipeline?: Awaited<ReturnType<typeof start>> } = {};
  const previousPushState = history.pushState;
  history.pushState = function (...args): void {
    previousPushState.apply(this, args);
    state.pipeline!.logger.emit({ body: "earlier wrapper log" });
    state.pipeline!.tracer.startSpan("earlier wrapper span").end();
  };
  const pipeline = await start({ pageView: { routeResolver: () => location.pathname } });
  state.pipeline = pipeline;
  const previousOperation = trace.getSpanContext(context.active())!.traceId;

  history.pushState(null, "", "/inside-earlier-wrapper");
  await pipeline.forceFlush();

  const log = pipeline.onLog.mock.calls.find(
    ([record]) => record.body === "earlier wrapper log",
  )![0];
  const span = pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "earlier wrapper span")!;
  for (const envelope of [logToEnvelope(log, "key"), spanToEnvelope(span, "key")]) {
    expect(envelope.tags["ai.operation.id"]).not.toBe(previousOperation);
    expect(envelope.tags["ai.operation.name"]).toBe("/inside-earlier-wrapper");
  }
});

it.each([
  ["document title", "Personalized order 8472", "/"],
  ["URL path", "", "/orders/8472"],
])("does not group telemetry by a high-cardinality %s fallback", async (_source, title, path) => {
  document.title = title;
  if (location.pathname !== path) history.replaceState(null, "", path);
  const pipeline = await start();
  pipeline.logger.emit({ body: "fallback page log" });
  pipeline.tracer.startSpan("fallback page span").end();
  await pipeline.forceFlush();

  const log = pipeline.onLog.mock.calls.find(([record]) => record.body === "fallback page log")![0];
  const span = pipeline.spanExporter
    .getFinishedSpans()
    .find((candidate) => candidate.name === "fallback page span")!;
  expect(logToEnvelope(log, "key").tags).not.toHaveProperty("ai.operation.name");
  expect(spanToEnvelope(span, "key").tags).not.toHaveProperty("ai.operation.name");
});

it.each([
  { sessionEnabled: false, logsOnly: false },
  { sessionEnabled: true, logsOnly: false },
  { sessionEnabled: false, logsOnly: true },
  { sessionEnabled: true, logsOnly: true },
])(
  "preserves the scoped initial operation (session=$sessionEnabled, logsOnly=$logsOnly)",
  async ({ sessionEnabled, logsOnly }) => {
    const existing = {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: 0,
    };
    const manager = new StackContextManager();
    const initializing = manager.with(trace.setSpanContext(ROOT_CONTEXT, existing), () =>
      start({
        traces: { contextManager: manager },
        session: { enabled: sessionEnabled },
        ...(logsOnly ? { spanProcessors: [] } : {}),
      }),
    );
    expect(manager.active()).toBe(ROOT_CONTEXT);
    const pipeline = await initializing;
    expect(manager.active()).toBe(ROOT_CONTEXT);

    pipeline.logger.emit({ body: "initial operation" });
    expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext).toEqual(existing);
    expect(
      logToEnvelope(pipeline.onLog.mock.calls.at(-1)![0], "key").tags["ai.operation.parentId"],
    ).toBe(existing.spanId);
    if (!logsOnly) {
      const span = pipeline.tracer.startSpan("child");
      span.end();
      expect(span.spanContext().traceId).toBe(existing.traceId);
      const headers: Record<string, string> = {};
      propagation.inject(context.active(), headers);
      expect(headers.traceparent).toBe(`00-${existing.traceId}-${existing.spanId}-00`);
    }
    window.dispatchEvent(new Event("pagehide"));
    const page = pipeline.onLog.mock.calls.find(
      ([record]) => record.eventName === "browser.page_view",
    )![0];
    expect(page.spanContext).toEqual(existing);
    expect(page.attributes["browser.page_view.id"]).toBe(existing.traceId);
    expect(logToEnvelope(page, "key").tags["ai.operation.parentId"]).toBe(existing.spanId);

    history.pushState(null, "", "/next");
    pipeline.logger.emit({ body: "next operation" });
    const next = pipeline.onLog.mock.calls.at(-1)![0].spanContext!;
    expect(isSpanContextValid(next)).toBe(true);
    expect(next.traceId).not.toBe(existing.traceId);
  },
);

it.each(["inherited", "non-enumerable"] as const)(
  "preserves the scoped startup context from an %s context manager property",
  async (kind) => {
    const manager = new StackContextManager();
    const existing = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
    const traces =
      kind === "inherited"
        ? (Object.create({ contextManager: manager }) as { contextManager: StackContextManager })
        : Object.defineProperty({}, "contextManager", { value: manager });
    const pipeline = await manager.with(trace.setSpanContext(ROOT_CONTEXT, existing), () =>
      start({ traces, spanProcessors: [], session: { enabled: false } }),
    );
    pipeline.logger.emit({ body: "descriptor context" });
    expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext).toEqual(existing);
  },
);

it.each([
  { traceId: "0".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
  { traceId: "1".repeat(32), spanId: "0".repeat(16), traceFlags: 1 },
])("ignores an invalid initial operation %j", async (invalid) => {
  const manager = new StackContextManager();
  const pipeline = await manager.with(trace.setSpanContext(ROOT_CONTEXT, invalid), () =>
    start({ traces: { contextManager: manager } }),
  );
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onLog.mock.calls.find(
    ([record]) => record.eventName === "browser.page_view",
  )![0];
  expect(isSpanContextValid(page.spanContext!)).toBe(true);
  expect(page.spanContext?.traceId).not.toBe(invalid.traceId);
  expect(page.attributes["browser.page_view.id"]).toBe(page.spanContext?.traceId);
});

it.each([false, true])(
  "correlates telemetry with invalid explicit contexts (logsOnly=%s)",
  async (logsOnly) => {
    const pipeline = await start(logsOnly ? { spanProcessors: [] } : {});
    pipeline.logger.emit({ body: "page operation" });
    const operation = pipeline.onLog.mock.calls.at(-1)![0].spanContext!;
    const invalid = trace.setSpanContext(ROOT_CONTEXT, INVALID_SPAN_CONTEXT);

    if (!logsOnly) {
      context.with(invalid, () => {
        expect(trace.getSpanContext(context.active())).toBe(operation);
        const child = pipeline.tracer.startSpan("child");
        expect(child.spanContext().traceId).toBe(operation.traceId);
        child.end();
        const headers: Record<string, string> = {};
        propagation.inject(context.active(), headers);
        expect(headers.traceparent?.split("-")[1]).toBe(operation.traceId);
      });
    }
    pipeline.logger.emit({ body: "invalid context", context: invalid });
    expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext).toBe(operation);

    const correlation = new PageViewCorrelation(() => operation);
    pipeline.onLog.mockImplementationOnce((record) => {
      record.spanContext = INVALID_SPAN_CONTEXT;
      correlation.onEmit(record);
      expect(record.spanContext).toBe(operation);
    });
    pipeline.logger.emit({ body: "invalid processor context" });
    await correlation.shutdown();
    pipeline.onLog.mockImplementationOnce((record) => {
      record.spanContext = INVALID_SPAN_CONTEXT;
      correlation.onEmit(record);
      expect(record.spanContext).toBe(INVALID_SPAN_CONTEXT);
    });
    pipeline.logger.emit({ body: "stopped processor" });
  },
);

it("keeps a delayed page event's original operation in logs-only mode", async () => {
  const pipeline = await start({
    spanProcessors: [],
    pageView: {
      applyCustomLogRecordData: (record) => {
        if (record.attributes?.["browser.page_view.index"] === 0)
          history.pushState(null, "", "/next");
      },
    },
  });
  pipeline.logger.emit({ body: "before" });
  const first = pipeline.onLog.mock.calls.at(-1)![0].spanContext!.traceId;
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onLog.mock.calls.find(
    ([record]) =>
      record.eventName === "browser.page_view" &&
      record.attributes["browser.page_view.index"] === 0,
  )![0];
  expect(page.spanContext?.traceId).toBe(first);
  expect(page.attributes["browser.page_view.id"]).toBe(first);
  expect(logToEnvelope(page, "key").tags).not.toHaveProperty("ai.operation.parentId");
  pipeline.logger.emit({ body: "after" });
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext?.traceId).not.toBe(first);
});

it("keeps correlation disabled when page views are off, and stops it at shutdown", async () => {
  const disabled = await start({ pageView: { enabled: false } });
  disabled.logger.emit({ body: "no page" });
  expect(disabled.onLog.mock.calls.at(-1)![0].spanContext).toBeUndefined();
  await handle!.shutdown();
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  const enabled = await start();
  const pageId = trace.getSpanContext(context.active())!.traceId;
  const stopping = handle!.shutdown();
  expect(trace.getSpanContext(context.active())).toBeUndefined();
  const late = enabled.tracer.startSpan("late");
  expect(late.spanContext().traceId).not.toBe(pageId);
  late.end();
  await stopping;
});

it.each([false, true])(
  "removes stopped page correlation without changing a surviving instance's application contexts (custom manager=%s)",
  async (customManager) => {
    const pipeline = await start(
      customManager ? { traces: { contextManager: new StackContextManager() } } : {},
    );
    const key = createContextKey("application-data");
    const pageContext = context.active().setValue(key, "retained");
    const pageOperation = trace.getSpanContext(pageContext)!;
    const pageCallback = context.bind(pageContext, () => context.active());
    const applicationSpan = pipeline.tracer.startSpan("application");
    const applicationContext = trace.setSpan(pageContext, applicationSpan);
    const applicationCallback = context.bind(applicationContext, () => context.active());
    applicationSpan.end();

    history.pushState(null, "", "/next");
    expect(trace.getSpanContext(context.active())?.traceId).not.toBe(pageOperation.traceId);
    expect(trace.getSpanContext(pageCallback())).toBe(pageOperation);

    const verifyStopped = () => {
      const activePageContext = pageCallback();
      expect(trace.getSpanContext(activePageContext)).toBeUndefined();
      expect(activePageContext.getValue(key)).toBe("retained");
      expect(trace.getSpanContext(pageContext)).toBe(pageOperation);
      const pageHeaders: Record<string, string> = {};
      propagation.inject(activePageContext, pageHeaders);
      expect(pageHeaders).not.toHaveProperty("traceparent");

      expect(applicationCallback()).toBe(applicationContext);
      const applicationHeaders: Record<string, string> = {};
      propagation.inject(applicationCallback(), applicationHeaders);
      const operation = applicationSpan.spanContext();
      expect(applicationHeaders.traceparent).toBe(`00-${operation.traceId}-${operation.spanId}-01`);
    };

    const survivor = await useMicrosoftOpenTelemetry({
      ...createInMemoryPipeline().options,
      pageView: { enabled: false },
    });
    try {
      const stopping = handle!.shutdown();
      verifyStopped();
      await stopping;
      verifyStopped();
    } finally {
      await survivor.shutdown();
    }
    expect(context.active()).toBe(ROOT_CONTEXT);
    expect(trace.getSpanContext(applicationContext)).toBe(applicationSpan.spanContext());
  },
);

it("does not bypass caller log filtering or disabled signal arrays", async () => {
  const onEmit = vi.fn();
  handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [],
    logRecordProcessors: [
      {
        enabled: () => false,
        onEmit,
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
  });
  logs.getLogger("filtered").emit({ body: "rejected" });
  expect(onEmit).not.toHaveBeenCalled();
  expect(trace.getSpanContext(context.active())).toBeUndefined();
});
