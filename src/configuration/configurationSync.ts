// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fields, type createRuntimeConfiguration } from "./runtimeConfiguration.js";
import type {
  MicrosoftOpenTelemetryBrowserConfigurationSyncOptions,
  MicrosoftOpenTelemetryBrowserConfigurationSync,
} from "../types.js";

const paths = ["samplingPercentage", "disableFetchTracking", "disableAjaxTracking"] as const;
type Controller = ReturnType<typeof createRuntimeConfiguration>;

/** Captures the startup-only event adapter without invoking nested application accessors. */
export function captureConfigurationSync(value: unknown) {
  if (value === undefined) return undefined;
  const extension = fields(value, "extensionConfig.", ["AppInsightsCfgSyncPlugin"]);
  if (extension.AppInsightsCfgSyncPlugin === undefined) return undefined;
  const options = fields(extension.AppInsightsCfgSyncPlugin, "AppInsightsCfgSyncPlugin.", [
    "syncMode",
    "customEvtName",
    "nonOverrideConfigs",
    "onError",
  ]);
  const mode = options.syncMode === undefined ? 2 : options.syncMode;
  const name = options.customEvtName === undefined ? "ai_cfgsync" : options.customEvtName;
  if (mode !== 0 && mode !== 1 && mode !== 2) throw new TypeError("syncMode must be 0, 1 or 2.");
  if (typeof name !== "string" || !name.trim())
    throw new TypeError("customEvtName must be a non-empty string.");
  if (options.onError !== undefined && typeof options.onError !== "function")
    throw new TypeError("onError must be a function.");
  const excluded = new Set<string>();
  if (options.nonOverrideConfigs !== undefined) {
    const overrides = fields(options.nonOverrideConfigs, "nonOverrideConfigs.", paths);
    for (const [key, blocked] of Object.entries(overrides)) {
      if (typeof blocked !== "boolean")
        throw new TypeError("nonOverrideConfigs values must be booleans.");
      if (blocked) excluded.add(key);
    }
  }
  return {
    mode,
    name,
    excluded,
    onError: options.onError as MicrosoftOpenTelemetryBrowserConfigurationSyncOptions["onError"],
  };
}

/** Same-realm event transport only. Received patches always use the owning configuration queue. */
export function createConfigurationSync(
  options: NonNullable<ReturnType<typeof captureConfigurationSync>>,
  configuration: Controller,
) {
  let paused = false;
  let stopped = false;
  let generation = 0;
  let listening = false;
  let changing = false;
  let uncertainRemoval = false;
  let pendingShutdown = false;
  const report = (error: unknown): void => {
    try {
      void Promise.resolve(options.onError?.(error)).catch(() => {});
    } catch {
      /* Application error reporting must not escape event dispatch. */
    }
  };
  const receive = (event: Event): void => {
    if (paused || stopped || options.mode !== 2) return;
    const version = generation;
    try {
      // Read the browser's native detail accessor, then require own data for the envelope and patch.
      const envelope = fields(Reflect.get(CustomEvent.prototype, "detail", event), "detail.", [
        "cfg",
      ]);
      const patch = fields(envelope.cfg, "cfg.", paths);
      for (const key of ["disableFetchTracking", "disableAjaxTracking"] as const) {
        if (Object.hasOwn(patch, key) && typeof patch[key] !== "boolean")
          throw new TypeError(`${key} must be a boolean.`);
      }
      void configuration
        .receive(patch, () => !paused && !stopped && version === generation, options.excluded)
        .catch(report);
    } catch (error) {
      report(error);
    }
  };
  const reconcile = (): void => {
    if (changing) return;
    changing = true;
    try {
      while (listening !== (!paused && !stopped && options.mode === 2)) {
        const add = !listening;
        listening = add;
        try {
          globalThis[add ? "addEventListener" : "removeEventListener"](options.name, receive);
          uncertainRemoval = false;
        } catch (error) {
          if (add) {
            stopped = true;
            generation++;
            // addEventListener may have registered before a wrapper threw.
            try {
              globalThis.removeEventListener(options.name, receive);
              listening = false;
            } catch {
              /* The owning shutdown retries removal; the listener is already inert. */
            }
          } else {
            listening = true;
            uncertainRemoval = true;
          }
          throw error;
        }
      }
    } finally {
      changing = false;
      if (pendingShutdown) {
        pendingShutdown = false;
        // Reentrant shutdown could not remove a listener while this transition was active.
        // Complete one deferred attempt without replacing the outer transition's error.
        try {
          reconcile();
        } catch {
          /* The adapter is terminal; preserve the original cleanup failure. */
        }
      } else if (uncertainRemoval && !paused && !stopped && options.mode === 2) {
        listening = false;
        try {
          reconcile();
        } catch {
          /* Failed registration already makes the adapter terminal. */
        }
      }
    }
  };
  const handle: MicrosoftOpenTelemetryBrowserConfigurationSync = {
    sync(): Promise<void> {
      const version = generation;
      return configuration.enqueue(() => {
        if (stopped || paused || options.mode !== 1 || version !== generation) return;
        const snapshot = configuration.snapshot();
        const cfg = Object.freeze(
          Object.fromEntries(
            paths.filter((key) => !options.excluded.has(key)).map((key) => [key, snapshot[key]]),
          ),
        );
        globalThis.dispatchEvent(new CustomEvent(options.name, { detail: Object.freeze({ cfg }) }));
      });
    },
    pause(): void {
      paused = true;
      generation++;
      reconcile();
    },
    resume(): void {
      if (!stopped) {
        paused = false;
        // An earlier wrapper may have removed the listener before throwing. Native add is idempotent.
        if (uncertainRemoval) listening = false;
        reconcile();
      }
    },
    shutdown(): void {
      if (changing && !stopped) pendingShutdown = true;
      stopped = true;
      generation++;
      try {
        reconcile();
      } catch (error) {
        // A wrapper may fail once during removal; keep the listener inert and retry once.
        try {
          reconcile();
        } catch {
          /* Preserve the original cleanup failure. */
        }
        throw error;
      }
    },
  };
  return { handle, start: reconcile };
}
