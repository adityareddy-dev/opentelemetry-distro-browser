// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { validateSamplingPercentage } from "../sampling.js";

/**
 * Supported runtime updates. Explicit undefined restores the corresponding native default.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationUpdate {
  /** Finite percentage from 0 through 100. Omission retains the current value when merging. */
  samplingPercentage?: number | undefined;
  /** Session lifetimes in seconds. Zero disables the corresponding expiration check. */
  session?:
    | {
        inactivityTimeout?: number | undefined;
        maxDuration?: number | undefined;
      }
    | undefined;
  /** Application Insights inactivity lifetime in milliseconds; zero restores 30 minutes. */
  sessionRenewalMs?: number | undefined;
  /** Application Insights maximum lifetime in milliseconds; zero restores 24 hours. */
  sessionExpirationMs?: number | undefined;
  /** Azure Monitor unload policy only. Undefined restores sendBeacon fallback. */
  azureMonitor?: { disableBeacon?: boolean | undefined } | undefined;
  /** Application Insights alias for azureMonitor.disableBeacon. Defaults to false. */
  onunloadDisableBeacon?: boolean | undefined;
  /** Stops new calls collected by registered fetch instrumentations. Defaults to false. */
  disableFetchTracking?: boolean | undefined;
  /** Stops new requests collected by registered XHR instrumentations. Defaults to false. */
  disableAjaxTracking?: boolean | undefined;
}

/**
 * Result of a runtime update. No-op updates retain the current revision.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserConfigurationUpdateResult {
  readonly revision: number;
  readonly changedPaths: readonly string[];
}

const defaults = { inactivityTimeout: 1800, maxDuration: 86400 };
type Lifetimes = typeof defaults;
interface CapturedUpdate extends Partial<Lifetimes> {
  samplingPercentage?: number | undefined;
  disableBeacon?: boolean;
  disableFetchTracking?: boolean;
  disableAjaxTracking?: boolean;
}

const networkGates = ["disableFetchTracking", "disableAjaxTracking"] as const;

/** Captures own data properties before queuing, without invoking application getters. */
export function fields(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const prototype: unknown =
    value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value as object)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new TypeError(`Unsupported configuration path: ${path}${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${path}${key} must be a data property.`);
    }
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function capture(patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate): CapturedUpdate {
  const input = fields(patch, "", [
    "samplingPercentage",
    "session",
    "sessionRenewalMs",
    "sessionExpirationMs",
    "azureMonitor",
    "onunloadDisableBeacon",
    ...networkGates,
  ]);
  const result: CapturedUpdate = {};
  for (const key of networkGates) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`${key} must be a boolean.`);
    }
    result[key] = value ?? false;
  }
  if (Object.hasOwn(input, "samplingPercentage")) {
    const value = input.samplingPercentage;
    if (value !== undefined && typeof value !== "number") {
      throw new TypeError("samplingPercentage must be a number.");
    }
    result.samplingPercentage = value === undefined ? undefined : validateSamplingPercentage(value);
  }
  const session = Object.hasOwn(input, "session")
    ? input.session === undefined
      ? { inactivityTimeout: undefined, maxDuration: undefined }
      : fields(input.session, "session.", Object.keys(defaults))
    : {};
  for (const key of Object.keys(defaults) as (keyof Lifetimes)[]) {
    const alias = key === "inactivityTimeout" ? "sessionRenewalMs" : "sessionExpirationMs";
    function duration(value: unknown, name: string): number {
      if (value === undefined) return defaults[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RangeError(
          `${name} must be a finite, nonnegative number of ${name === alias ? "milliseconds" : "seconds"}.`,
        );
      }
      if (name !== alias || value === 0) return name === alias ? defaults[key] : value;
      const seconds = value / 1000;
      if (seconds === 0) throw new RangeError(`${name} is too small to represent in seconds.`);
      return seconds;
    }
    if (Object.hasOwn(session, key)) result[key] = duration(session[key], `session.${key}`);
    if (Object.hasOwn(input, alias)) {
      const value = duration(input[alias], alias);
      if (Object.hasOwn(result, key) && result[key] !== value) {
        throw new TypeError(`Conflicting configuration paths: session.${key} and ${alias}.`);
      }
      result[key] = value;
    }
  }
  const azureMonitor = Object.hasOwn(input, "azureMonitor")
    ? input.azureMonitor === undefined
      ? { disableBeacon: undefined }
      : fields(input.azureMonitor, "azureMonitor.", ["disableBeacon"])
    : {};
  for (const [source, key, path] of [
    [azureMonitor, "disableBeacon", "azureMonitor.disableBeacon"],
    [input, "onunloadDisableBeacon", "onunloadDisableBeacon"],
  ] as const) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`${path} must be a boolean.`);
    }
    const normalized = value ?? false;
    if (result.disableBeacon !== undefined && result.disableBeacon !== normalized) {
      throw new TypeError(
        "Conflicting configuration paths: azureMonitor.disableBeacon and onunloadDisableBeacon.",
      );
    }
    result.disableBeacon = normalized;
  }
  return result;
}

function snapshot(
  update: CapturedUpdate,
  previous?: {
    readonly samplingPercentage: number | undefined;
    readonly session: Lifetimes;
    readonly azureMonitor: { readonly disableBeacon: boolean };
    readonly disableFetchTracking: boolean;
    readonly disableAjaxTracking: boolean;
  },
) {
  return Object.freeze({
    disableFetchTracking: update.disableFetchTracking ?? previous?.disableFetchTracking ?? false,
    disableAjaxTracking: update.disableAjaxTracking ?? previous?.disableAjaxTracking ?? false,
    samplingPercentage: Object.hasOwn(update, "samplingPercentage")
      ? update.samplingPercentage
      : previous?.samplingPercentage,
    session: Object.freeze({
      inactivityTimeout:
        update.inactivityTimeout ??
        previous?.session.inactivityTimeout ??
        defaults.inactivityTimeout,
      maxDuration: update.maxDuration ?? previous?.session.maxDuration ?? defaults.maxDuration,
    }),
    azureMonitor: Object.freeze({
      disableBeacon: update.disableBeacon ?? previous?.azureMonitor.disableBeacon ?? false,
    }),
  });
}

/** Instance controller; publishing validated lifetime policies never touches sessions or storage. */
export function createRuntimeConfiguration(
  initial: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
  isStopped: () => boolean,
  applyNetworkGates?: (next: ReturnType<typeof snapshot>) => void,
  protectSampling = false,
) {
  let current = snapshot(capture(initial));
  let revision = 0;
  let queue = Promise.resolve();
  const protectedPaths = new Set<string>(protectSampling ? ["samplingPercentage"] : []);
  const syncPaths = ["samplingPercentage", ...networkGates];

  function enqueue<T>(operation: () => T): Promise<T> {
    const result = queue.then(() => {
      if (isStopped()) throw new Error("Telemetry instance is stopped.");
      return operation();
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function update(
    patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
    mergeExisting = true,
    accept?: () => boolean,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<MicrosoftOpenTelemetryBrowserConfigurationUpdateResult> {
    let update: CapturedUpdate;
    try {
      if (typeof mergeExisting !== "boolean") {
        throw new TypeError("mergeExisting must be a boolean.");
      }
      update = capture(patch);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new TypeError("Invalid configuration.", { cause: error }),
      );
    }
    return enqueue(() => {
      if (accept) {
        if (!accept())
          return Object.freeze({ revision, changedPaths: Object.freeze([] as string[]) });
        for (const key of syncPaths) {
          if (protectedPaths.has(key) || excluded.has(key))
            delete update[key as keyof CapturedUpdate];
        }
      }
      const next = snapshot(update, mergeExisting ? current : undefined);
      const changedPaths: string[] = [];
      if (next.samplingPercentage !== current.samplingPercentage)
        changedPaths.push("samplingPercentage");
      for (const key of Object.keys(defaults) as (keyof Lifetimes)[]) {
        if (next.session[key] !== current.session[key]) changedPaths.push(`session.${key}`);
      }
      if (next.azureMonitor.disableBeacon !== current.azureMonitor.disableBeacon)
        changedPaths.push("azureMonitor.disableBeacon");
      const gatesChanged = networkGates.filter((key) => next[key] !== current[key]);
      changedPaths.push(...gatesChanged);
      if (gatesChanged.length) applyNetworkGates?.(next);
      if (isStopped()) throw new Error("Telemetry instance is stopped.");
      if (accept && !accept()) {
        if (gatesChanged.length) applyNetworkGates?.(current);
        return Object.freeze({ revision, changedPaths: Object.freeze([] as string[]) });
      }
      if (changedPaths.length) {
        current = next;
        revision++;
      }
      if (!accept) {
        for (const key of syncPaths) {
          if (!mergeExisting || Object.hasOwn(update, key)) protectedPaths.add(key);
        }
      }
      return Object.freeze({
        revision,
        changedPaths: Object.freeze(changedPaths),
      });
    });
  }

  return {
    snapshot: () => current,
    enqueue,
    updateCfg: (patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate, mergeExisting = true) =>
      update(patch, mergeExisting),
    receive: (
      patch: MicrosoftOpenTelemetryBrowserConfigurationUpdate,
      accept: () => boolean,
      excluded: ReadonlySet<string>,
    ) => {
      try {
        return update(fields(patch, "cfg.", syncPaths), true, accept, new Set(excluded));
      } catch (error) {
        return Promise.reject(
          error instanceof Error
            ? error
            : new TypeError("Invalid synchronized configuration.", { cause: error }),
        );
      }
    },
  };
}
