// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it, vi } from "vitest";
import {
  getManagedOperationName,
  setManagedOperationName,
} from "../../../src/context/operationName.js";
import { AZURE_MONITOR_SAMPLE_RATE, getSamplingScore } from "../../../src/sampling.js";
import { AzureMonitorSamplingLogRecordProcessor } from "../../../src/samplingLogRecordProcessor.js";

const sampledContext: SpanContext = {
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  traceFlags: TraceFlags.SAMPLED,
};
const unsampledContext: SpanContext = { ...sampledContext, traceFlags: TraceFlags.NONE };

function makeRecord(spanContext?: SpanContext): ReadWriteLogRecord {
  const attributes: Record<string, string | number> = {};
  return {
    hrTime: [0, 0],
    hrTimeObserved: [0, 0],
    spanContext,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "test" },
    attributes,
    droppedAttributesCount: 0,
    setAttribute(key, value) {
      if (value === undefined) delete attributes[key];
      else attributes[key] = value as string | number;
      return this;
    },
    setAttributes(values) {
      Object.assign(attributes, values);
      return this;
    },
    setBody(body) {
      this.body = body;
      return this;
    },
    setEventName(eventName) {
      this.eventName = eventName;
      return this;
    },
    setSeverityNumber(severityNumber) {
      this.severityNumber = severityNumber;
      return this;
    },
    setSeverityText(severityText) {
      this.severityText = severityText;
      return this;
    },
  };
}

async function exportRecords(
  samplingPercentage: number,
  records: ReadWriteLogRecord[],
  random = () => 0,
): Promise<ReadWriteLogRecord[]> {
  const exporter = new InMemoryLogRecordExporter();
  const processor = new AzureMonitorSamplingLogRecordProcessor(
    {
      exporter,
      samplingPercentage,
    },
    random,
  );
  for (const record of records) processor.onEmit(record);
  await processor.forceFlush();
  const exported = exporter.getFinishedLogRecords() as ReadWriteLogRecord[];
  await processor.shutdown();
  return exported;
}

describe("AzureMonitorSamplingLogRecordProcessor", () => {
  it("preserves attributes added by later processors without sharing sampling metadata", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sampling = new AzureMonitorSamplingLogRecordProcessor(
      { exporter, samplingPercentage: 50 },
      () => 0,
    );
    const observer = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [
        sampling,
        {
          onEmit(record) {
            record.setAttribute("enriched", true);
            observer.export([record], () => {});
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    });
    try {
      provider.getLogger("test").emit({ body: "sampled log", attributes: { original: true } });
      await provider.forceFlush();
      expect(exporter.getFinishedLogRecords()[0].attributes).toEqual({
        original: true,
        enriched: true,
        [AZURE_MONITOR_SAMPLE_RATE]: 50,
      });
      expect(observer.getFinishedLogRecords()[0].attributes).toEqual({
        original: true,
        enriched: true,
      });
    } finally {
      await provider.shutdown();
    }
  });

  it.each([sampledContext, unsampledContext, undefined])(
    "reads sampling once per emit and forwards undefined policy unchanged (%j)",
    async (spanContext) => {
      let percentage: number | undefined;
      const read = vi.fn(() => percentage);
      const random = vi.fn(() => 0);
      const exporter = new InMemoryLogRecordExporter();
      const processor = new AzureMonitorSamplingLogRecordProcessor(
        { exporter, samplingPercentage: read },
        random,
      );
      const unfiltered = makeRecord(spanContext);
      const preserved = makeRecord(spanContext);
      preserved.setAttribute(AZURE_MONITOR_SAMPLE_RATE, 20);
      const accepted = makeRecord(spanContext);
      try {
        expect(read).not.toHaveBeenCalled();
        processor.onEmit(unfiltered);
        processor.onEmit(preserved);
        expect(random).not.toHaveBeenCalled();
        percentage = 0;
        processor.onEmit(makeRecord(spanContext));
        percentage = 50;
        processor.onEmit(accepted);
        percentage = undefined;
        const reset = makeRecord(spanContext);
        processor.onEmit(reset);
        await processor.forceFlush();
        const records = exporter.getFinishedLogRecords();
        expect(read).toHaveBeenCalledTimes(5);
        expect(records).toHaveLength(4);
        expect(records[0]).toBe(unfiltered);
        expect(records[0].attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
        expect(records[1]).toBe(preserved);
        expect(records[1].attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(20);
        expect(records[2].attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(50);
        expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
        expect(records[3]).toBe(reset);
      } finally {
        await processor.shutdown();
      }
    },
  );

  it.each([-1, 101, Number.NaN, Infinity, -Infinity])(
    "rejects invalid runtime percentage %s on emit",
    async (invalid) => {
      const exporter = new InMemoryLogRecordExporter();
      let percentage: number | undefined = invalid;
      const processor = new AzureMonitorSamplingLogRecordProcessor({
        exporter,
        samplingPercentage: () => percentage,
      });
      try {
        expect(() => processor.onEmit(makeRecord())).toThrow(RangeError);
        percentage = undefined;
        processor.onEmit(makeRecord());
        await processor.forceFlush();
        expect(exporter.getFinishedLogRecords()).toHaveLength(1);
      } finally {
        await processor.shutdown();
      }
    },
  );

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid percentage %s",
    (samplingPercentage) => {
      expect(
        () =>
          new AzureMonitorSamplingLogRecordProcessor({
            exporter: new InMemoryLogRecordExporter(),
            samplingPercentage,
          }),
      ).toThrow(RangeError);
    },
  );

  it("forwards batch processor options after removing the sampling percentage", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const processor = new AzureMonitorSamplingLogRecordProcessor({
      exporter,
      samplingPercentage: 100,
      maxExportBatchSize: 1,
      scheduledDelayMillis: 60_000,
    });

    try {
      processor.onEmit(makeRecord());
      await Promise.resolve();
      expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    } finally {
      await processor.shutdown();
    }
  });

  it("uses the trace ID score instead of trace flags for correlated records", async () => {
    const score = getSamplingScore(sampledContext.traceId);
    const sampledFlagRejected = makeRecord(sampledContext);
    const unsampledFlagAccepted = makeRecord(unsampledContext);

    expect(await exportRecords(score, [sampledFlagRejected])).toEqual([]);
    const [exported] = await exportRecords(score + 0.000_001, [unsampledFlagAccepted]);
    expect(exported?.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(score + 0.000_001);
    expect(unsampledFlagAccepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
  });

  it("rejects a sampled-flag correlated record at zero percent", async () => {
    const rejected = makeRecord(sampledContext);

    expect(await exportRecords(0, [rejected])).toEqual([]);
    expect(rejected.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
  });

  it.each([
    [25, 50, 25],
    [50, 20, 20],
    [50, 75, 50],
    [50, "invalid", 50],
    [50, Number.NaN, 50],
    [50, -1, 50],
    [50, 0, 50],
    [50, 101, 50],
  ])(
    "reconciles configured percentage %s with producer sample rate %s",
    async (samplingPercentage, producerSampleRate, expectedSampleRate) => {
      const accepted = makeRecord(sampledContext);
      accepted.setAttribute(AZURE_MONITOR_SAMPLE_RATE, producerSampleRate);

      const [exported] = await exportRecords(samplingPercentage, [accepted]);
      expect(exported?.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(expectedSampleRate);
      expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(producerSampleRate);
    },
  );

  it("preserves matching producer sampling metadata", async () => {
    const accepted = makeRecord(sampledContext);
    accepted.setAttribute(AZURE_MONITOR_SAMPLE_RATE, 50);

    expect(await exportRecords(50, [accepted])).toEqual([accepted]);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(50);
  });

  it("preserves producer sampling metadata at 100 percent", async () => {
    const accepted = makeRecord(sampledContext);
    accepted.setAttribute(AZURE_MONITOR_SAMPLE_RATE, 20);

    expect(await exportRecords(100, [accepted])).toEqual([accepted]);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(20);
  });

  it("handles uncorrelated zero and full sampling boundaries", async () => {
    expect(await exportRecords(0, [makeRecord()])).toEqual([]);
    expect(await exportRecords(100, [makeRecord()])).toHaveLength(1);
  });

  it("independently samples uncorrelated records", async () => {
    const accepted = makeRecord();
    const rejected = makeRecord();

    const [exported] = await exportRecords(50, [accepted], () => 0.499);
    expect(await exportRecords(50, [rejected], () => 0.5)).toEqual([]);
    expect(exported?.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(50);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
  });

  it("preserves managed operation names on records derived for sampling metadata", async () => {
    const accepted = makeRecord();
    setManagedOperationName(accepted, "Products");

    const [exported] = await exportRecords(50, [accepted], () => 0);

    expect(exported).not.toBe(accepted);
    expect(getManagedOperationName(exported!)).toBe("Products");
  });

  it("combines producer and local rates for independently sampled records", async () => {
    const accepted = makeRecord();
    accepted.setAttribute(AZURE_MONITOR_SAMPLE_RATE, 20);

    const [exported] = await exportRecords(50, [accepted], () => 0);
    expect(exported?.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(10);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(20);
  });
});
