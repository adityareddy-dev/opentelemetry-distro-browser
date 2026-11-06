// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isSpanContextValid } from "@opentelemetry/api";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import {
  BrowserBatchLogRecordProcessor,
  type BrowserBatchLogRecordProcessorOptions,
} from "./browserBatchLogRecordProcessor.js";
import {
  AZURE_MONITOR_SAMPLE_RATE,
  getEffectiveSampleRate,
  isTraceSampled,
  validateSamplingPercentage,
} from "./sampling.js";
import { copyManagedOperationName } from "./context/operationName.js";

export interface AzureMonitorSamplingLogRecordProcessorOptions extends BrowserBatchLogRecordProcessorOptions {
  samplingPercentage: number | (() => number | undefined);
}

export class AzureMonitorSamplingLogRecordProcessor extends BrowserBatchLogRecordProcessor {
  readonly #samplingPercentage: number | (() => number | undefined);

  public constructor(
    options: AzureMonitorSamplingLogRecordProcessorOptions,
    private readonly random: () => number = Math.random,
  ) {
    const { samplingPercentage, ...batchOptions } = options;
    super(batchOptions);
    this.#samplingPercentage =
      typeof samplingPercentage === "function"
        ? samplingPercentage
        : validateSamplingPercentage(samplingPercentage);
  }

  public override onEmit(record: ReadWriteLogRecord): void {
    const percentage =
      typeof this.#samplingPercentage === "function"
        ? this.#samplingPercentage()
        : this.#samplingPercentage;
    this.onEmitWithSamplingPercentage(record, percentage);
  }

  /** Retains the emission-time policy when a deferred destination queues this record. */
  public onEmitWithSamplingPercentage(
    record: ReadWriteLogRecord,
    percentage: number | undefined,
  ): void {
    if (!this.accepts(record)) return;
    if (percentage === undefined) {
      super.onEmit(record);
      return;
    }
    const samplingPercentage = validateSamplingPercentage(percentage);
    const spanContext = record.spanContext;
    const correlated = !!spanContext && isSpanContextValid(spanContext);
    const sampled = correlated
      ? isTraceSampled(spanContext.traceId, samplingPercentage)
      : samplingPercentage === 100 ||
        (samplingPercentage !== 0 && this.random() * 100 < samplingPercentage);
    if (!sampled) return;

    const currentSampleRate = record.attributes[AZURE_MONITOR_SAMPLE_RATE];
    const effectiveSampleRate = getEffectiveSampleRate(
      currentSampleRate,
      samplingPercentage,
      !correlated,
    );
    if (effectiveSampleRate < 100 && currentSampleRate !== effectiveSampleRate) {
      const azureRecord = Object.create(record, {
        attributes: {
          get: () => ({
            ...record.attributes,
            [AZURE_MONITOR_SAMPLE_RATE]: effectiveSampleRate,
          }),
        },
      }) as ReadWriteLogRecord;
      copyManagedOperationName(record, azureRecord);
      super.onEmit(azureRecord);
      return;
    }
    super.onEmit(record);
  }
}
