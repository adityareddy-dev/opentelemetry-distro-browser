// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureConfigurationSync,
  createConfigurationSync,
} from "../../../src/configuration/configurationSync.js";
import {
  createRuntimeConfiguration,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "../../../src/configuration/runtimeConfiguration.js";

const invalid = (value: unknown) => value as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
type RuntimeSnapshot = ReturnType<ReturnType<typeof createRuntimeConfiguration>["snapshot"]>;

function create(
  initial: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {},
  applyNetworkGates?: (next: RuntimeSnapshot) => void,
) {
  let stopped = false;
  const controller = createRuntimeConfiguration(initial, () => stopped, applyNetworkGates);
  return {
    controller,
    stop: () => {
      stopped = true;
    },
  };
}

describe("sampling configuration", () => {
  it("starts with a frozen default or explicit initial policy", () => {
    const { controller } = create();
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(create({ samplingPercentage: 0 }).controller.snapshot().samplingPercentage).toBe(0);
  });

  it("commits sequential revisions and preserves snapshots", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({ samplingPercentage: 25 });
    const second = controller.updateCfg({ samplingPercentage: 0 });
    expect(controller.snapshot()).toBe(original);
    expect(await first).toEqual({ revision: 1, changedPaths: ["samplingPercentage"] });
    expect(await second).toEqual({ revision: 2, changedPaths: ["samplingPercentage"] });
    expect(controller.snapshot().samplingPercentage).toBe(0);
    expect(original.samplingPercentage).toBeUndefined();
  });

  it("captures queued input and freezes results", async () => {
    const { controller } = create();
    const patch = { samplingPercentage: 25 };
    const operation = controller.updateCfg(patch);
    patch.samplingPercentage = 90;
    const result = await operation;
    expect(controller.snapshot().samplingPercentage).toBe(25);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
  });

  it("distinguishes omission, explicit undefined and replacement resets", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    expect(await controller.updateCfg({ samplingPercentage: undefined })).toEqual({
      revision: 1,
      changedPaths: ["samplingPercentage"],
    });
    await controller.updateCfg({ samplingPercentage: 100 });
    expect(await controller.updateCfg({ samplingPercentage: 100 })).toEqual({
      revision: 2,
      changedPaths: [],
    });
    expect(await controller.updateCfg({}, false)).toEqual({
      revision: 3,
      changedPaths: ["samplingPercentage"],
    });
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 101, "25", null, true])(
    "rejects invalid percentages: %s",
    async (value) => {
      const { controller } = create({ samplingPercentage: 50 });
      await expect(controller.updateCfg(invalid({ samplingPercentage: value }))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBe(50);
      expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
        revision: 1,
        changedPaths: ["samplingPercentage"],
      });
    },
  );

  it.each([null, [], 1, "config", new Date(), { connectionString: undefined }])(
    "rejects unsupported patches: %s",
    async (value) => {
      const { controller } = create();
      await expect(controller.updateCfg(invalid(value))).rejects.toThrow();
      expect(controller.snapshot().samplingPercentage).toBeUndefined();
    },
  );

  it("rejects mixed valid/unsupported fields before queuing any change", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    await expect(
      controller.updateCfg(invalid({ samplingPercentage: 0, resource: {} })),
    ).rejects.toThrow("Unsupported configuration path: resource");
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("rejects accessors, inherited options, symbols and pollution keys without executing getters", async () => {
    const { controller } = create();
    const getter = vi.fn(() => 25);
    const accessor = Object.defineProperty({}, "samplingPercentage", { get: getter });
    await expect(controller.updateCfg(accessor)).rejects.toThrow("data property");
    expect(getter).not.toHaveBeenCalled();
    await expect(
      controller.updateCfg(invalid(Object.create({ samplingPercentage: 0 }))),
    ).rejects.toThrow("plain object");
    await expect(
      controller.updateCfg(invalid({ [Symbol("samplingPercentage")]: 0 })),
    ).rejects.toThrow("Unsupported");
    await expect(controller.updateCfg(invalid(JSON.parse('{"__proto__":{}}')))).rejects.toThrow(
      "Unsupported",
    );
  });

  it("accepts null-prototype data without exposing a mutable snapshot", async () => {
    const { controller } = create();
    const patch = Object.create(null) as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
    patch.samplingPercentage = 25;
    await controller.updateCfg(patch);
    expect(controller.snapshot().samplingPercentage).toBe(25);
  });

  it("validates mergeExisting and initial values", async () => {
    const { controller } = create();
    await expect(controller.updateCfg({}, undefined as unknown as boolean)).resolves.toEqual({
      revision: 0,
      changedPaths: [],
    });
    await expect(controller.updateCfg({}, 1 as unknown as boolean)).rejects.toThrow(
      "mergeExisting",
    );
    expect(() => create({ samplingPercentage: NaN })).toThrow();
  });

  it("rejects pending and future changes immediately after shutdown begins", async () => {
    const { controller, stop } = create();
    const original = controller.snapshot();
    const queued = controller.updateCfg({
      samplingPercentage: 0,
      session: { inactivityTimeout: 0, maxDuration: 0 },
      azureMonitor: { disableBeacon: true },
    });
    stop();
    await expect(queued).rejects.toThrow("stopped");
    await expect(
      controller.updateCfg({ sessionRenewalMs: 1000, sessionExpirationMs: 2000 }),
    ).rejects.toThrow("stopped");
    expect(controller.snapshot()).toBe(original);
  });
});

describe("network gate configuration", () => {
  it("defaults, updates and resets fetch and XHR tracking gates", async () => {
    const calls: unknown[] = [];
    const { controller } = create({}, (next) => calls.push(next));
    const original = controller.snapshot();
    expect(original).toMatchObject({ disableFetchTracking: false, disableAjaxTracking: false });

    expect(await controller.updateCfg({ disableFetchTracking: true })).toEqual({
      revision: 1,
      changedPaths: ["disableFetchTracking"],
    });
    expect(controller.snapshot()).toMatchObject({
      disableFetchTracking: true,
      disableAjaxTracking: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(controller.snapshot());

    expect(
      await controller.updateCfg({ disableFetchTracking: undefined, disableAjaxTracking: true }),
    ).toEqual({
      revision: 2,
      changedPaths: ["disableFetchTracking", "disableAjaxTracking"],
    });
    expect(controller.snapshot()).toMatchObject({
      disableFetchTracking: false,
      disableAjaxTracking: true,
    });
    expect(calls).toHaveLength(2);
    expect(await controller.updateCfg({}, false)).toEqual({
      revision: 3,
      changedPaths: ["disableAjaxTracking"],
    });
    expect(controller.snapshot()).toMatchObject({
      disableFetchTracking: false,
      disableAjaxTracking: false,
    });
    expect(calls).toHaveLength(3);
  });

  it("serializes custom operations with gate callbacks before publication", async () => {
    const events: string[] = [];
    const controller = createRuntimeConfiguration(
      {},
      () => false,
      (next) => {
        events.push(
          `callback:${next.disableFetchTracking}:${controller.snapshot().disableFetchTracking}`,
        );
      },
    );
    const custom = controller.enqueue(() => events.push("custom"));
    const update = controller.updateCfg({ disableFetchTracking: true });
    await expect(custom).resolves.toBe(1);
    await expect(update).resolves.toEqual({
      revision: 1,
      changedPaths: ["disableFetchTracking"],
    });
    expect(events).toEqual(["custom", "callback:true:false"]);
  });

  it("rejects callback failures atomically without consuming a revision", async () => {
    const applyNetworkGates = vi.fn(() => {
      throw new Error("network gates failed");
    });
    const { controller } = create({ samplingPercentage: 50 }, applyNetworkGates);
    const original = controller.snapshot();
    await expect(
      controller.updateCfg({
        disableFetchTracking: true,
        samplingPercentage: 25,
        session: { inactivityTimeout: 60 },
        azureMonitor: { disableBeacon: true },
      }),
    ).rejects.toThrow("network gates failed");
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
      revision: 1,
      changedPaths: ["samplingPercentage"],
    });
  });

  it.each([null, 0, "false", Symbol("gate")])(
    "rejects invalid network gate values: %s",
    async (value) => {
      const { controller } = create();
      const original = controller.snapshot();
      await expect(controller.updateCfg(invalid({ disableFetchTracking: value }))).rejects.toThrow(
        "disableFetchTracking must be a boolean",
      );
      expect(controller.snapshot()).toBe(original);
    },
  );

  it("rejects gate accessors and symbol keys without invoking application code", async () => {
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, "disableFetchTracking", { get: getter });
    const { controller } = create();
    await expect(controller.updateCfg(accessor)).rejects.toThrow("data property");
    await expect(
      controller.updateCfg(invalid({ [Symbol("disableAjaxTracking")]: true })),
    ).rejects.toThrow("Unsupported configuration path");
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("unload beacon configuration", () => {
  const defaults = {
    disableFetchTracking: false,
    disableAjaxTracking: false,
    samplingPercentage: undefined,
    session: { inactivityTimeout: 1800, maxDuration: 86400 },
    azureMonitor: { disableBeacon: false },
  };
  const initial = {
    disableFetchTracking: false,
    disableAjaxTracking: false,
    samplingPercentage: 50,
    session: { inactivityTimeout: 60, maxDuration: 120 },
    azureMonitor: { disableBeacon: true },
  };
  const changedPaths = [
    "samplingPercentage",
    "session.inactivityTimeout",
    "session.maxDuration",
    "azureMonitor.disableBeacon",
  ];

  it.each([
    { patch: {}, disableBeacon: false },
    { patch: { azureMonitor: {} }, disableBeacon: false },
    { patch: { azureMonitor: undefined }, disableBeacon: false },
    { patch: { azureMonitor: { disableBeacon: undefined } }, disableBeacon: false },
    { patch: { onunloadDisableBeacon: undefined }, disableBeacon: false },
    { patch: { azureMonitor: { disableBeacon: false } }, disableBeacon: false },
    { patch: { onunloadDisableBeacon: false }, disableBeacon: false },
    { patch: { azureMonitor: { disableBeacon: true } }, disableBeacon: true },
    { patch: { onunloadDisableBeacon: true }, disableBeacon: true },
  ])("normalizes the initial policy: $patch", ({ patch, disableBeacon }) => {
    const snapshot = create(patch).controller.snapshot();
    expect(snapshot).toEqual({ ...defaults, azureMonitor: { disableBeacon } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.session)).toBe(true);
    expect(Object.isFrozen(snapshot.azureMonitor)).toBe(true);
    expect(() => Object.assign(snapshot.azureMonitor, { disableBeacon: !disableBeacon })).toThrow(
      TypeError,
    );
  });

  it.each([
    {},
    { azureMonitor: {} },
    { azureMonitor: { disableBeacon: true } },
    { onunloadDisableBeacon: true },
    { azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: true },
  ])("retains omitted values and snapshot identity for no-op merges: %s", async (patch) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    const result = await controller.updateCfg(patch);
    expect(result).toEqual({ revision: 0, changedPaths: [] });
    expect(controller.snapshot()).toBe(original);
    expect(controller.snapshot().session).toBe(original.session);
    expect(controller.snapshot().azureMonitor).toBe(original.azureMonitor);
    expect(Object.isFrozen(original.azureMonitor)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
  });

  it.each([
    { azureMonitor: undefined },
    { azureMonitor: { disableBeacon: undefined } },
    { azureMonitor: { disableBeacon: false } },
    { onunloadDisableBeacon: undefined },
    { onunloadDisableBeacon: false },
  ])("resets only beacon policy when merging: %s", async (patch) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: ["azureMonitor.disableBeacon"],
    });
    expect(controller.snapshot()).toEqual({ ...initial, azureMonitor: { disableBeacon: false } });
    const reset = controller.snapshot();
    expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: [] });
    expect(controller.snapshot()).toBe(reset);
    expect(original.azureMonitor.disableBeacon).toBe(true);
  });

  it.each([
    { patch: {}, expected: defaults, paths: changedPaths },
    { patch: { azureMonitor: {} }, expected: defaults, paths: changedPaths },
    { patch: { azureMonitor: undefined }, expected: defaults, paths: changedPaths },
    {
      patch: { azureMonitor: { disableBeacon: undefined } },
      expected: defaults,
      paths: changedPaths,
    },
    { patch: { onunloadDisableBeacon: undefined }, expected: defaults, paths: changedPaths },
    {
      patch: { samplingPercentage: 25 },
      expected: { ...defaults, samplingPercentage: 25 },
      paths: changedPaths,
    },
    {
      patch: { session: { inactivityTimeout: 60 } },
      expected: { ...defaults, session: { inactivityTimeout: 60, maxDuration: 86400 } },
      paths: ["samplingPercentage", "session.maxDuration", "azureMonitor.disableBeacon"],
    },
    {
      patch: { azureMonitor: { disableBeacon: true } },
      expected: { ...defaults, azureMonitor: { disableBeacon: true } },
      paths: changedPaths.slice(0, 3),
    },
    {
      patch: { onunloadDisableBeacon: true },
      expected: { ...defaults, azureMonitor: { disableBeacon: true } },
      paths: changedPaths.slice(0, 3),
    },
  ])(
    "resets omitted supported fields on replacement: $patch",
    async ({ patch, expected, paths }) => {
      const { controller } = create(initial);
      expect(await controller.updateCfg(patch, false)).toEqual({
        revision: 1,
        changedPaths: paths,
      });
      expect(controller.snapshot()).toEqual(expected);
      const reset = controller.snapshot();
      expect(await controller.updateCfg(patch, false)).toEqual({ revision: 1, changedPaths: [] });
      expect(controller.snapshot()).toBe(reset);
    },
  );

  it.each([
    { azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: true },
    { azureMonitor: { disableBeacon: false }, onunloadDisableBeacon: false },
    { azureMonitor: { disableBeacon: undefined }, onunloadDisableBeacon: false },
    { azureMonitor: { disableBeacon: false }, onunloadDisableBeacon: undefined },
    { azureMonitor: { disableBeacon: undefined }, onunloadDisableBeacon: undefined },
    { azureMonitor: undefined, onunloadDisableBeacon: false },
    { azureMonitor: undefined, onunloadDisableBeacon: undefined },
    { azureMonitor: {}, onunloadDisableBeacon: true },
  ])("accepts aliases only when supplied native values normalize equally: %s", async (patch) => {
    const disableBeacon = patch.onunloadDisableBeacon ?? false;
    expect(create(patch).controller.snapshot().azureMonitor).toEqual({ disableBeacon });
    const { controller } = create({ azureMonitor: { disableBeacon: !disableBeacon } });
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: ["azureMonitor.disableBeacon"],
    });
    expect(controller.snapshot().azureMonitor).toEqual({ disableBeacon });
  });

  describe.each([false, true])("conflicts with reversed insertion order: %s", (reverse) => {
    it.each([
      { azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: false },
      { azureMonitor: { disableBeacon: false }, onunloadDisableBeacon: true },
      { azureMonitor: { disableBeacon: undefined }, onunloadDisableBeacon: true },
      { azureMonitor: { disableBeacon: true }, onunloadDisableBeacon: undefined },
      { azureMonitor: undefined, onunloadDisableBeacon: true },
    ])("rejects conflicting normalized paths atomically: %s", async (input) => {
      const entries = Object.entries(input);
      const patch = invalid(Object.fromEntries(reverse ? entries.reverse() : entries));
      expect(() => create(patch)).toThrow("Conflicting configuration paths");
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(
        controller.updateCfg({
          ...patch,
          samplingPercentage: 0,
          session: { inactivityTimeout: 0, maxDuration: 0 },
        }),
      ).rejects.toThrow("Conflicting configuration paths");
      expect(controller.snapshot()).toBe(original);
      expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    });
  });

  it("lets native and alias calls overwrite each other without retaining conflicts", async () => {
    const { controller } = create();
    const patches = [
      { onunloadDisableBeacon: true },
      { azureMonitor: { disableBeacon: false } },
      { azureMonitor: { disableBeacon: true } },
      { onunloadDisableBeacon: undefined },
    ];
    for (const [index, patch] of patches.entries()) {
      expect(await controller.updateCfg(patch)).toEqual({
        revision: index + 1,
        changedPaths: ["azureMonitor.disableBeacon"],
      });
      expect(controller.snapshot().azureMonitor.disableBeacon).toBe(index % 2 === 0);
    }
  });

  describe.each([
    {
      path: "azureMonitor.disableBeacon",
      patch: (value: unknown) => ({ azureMonitor: { disableBeacon: value } }),
    },
    {
      path: "onunloadDisableBeacon",
      patch: (value: unknown) => ({ onunloadDisableBeacon: value }),
    },
  ])("$path validation", ({ path, patch }) => {
    it.each([
      null,
      0,
      1,
      NaN,
      Infinity,
      "true",
      "false",
      "",
      {},
      [],
      () => true,
      Object(true) as unknown,
      new Date(),
      Symbol("disableBeacon"),
    ])("rejects non-boolean values without coercion: %s", async (value) => {
      const update = invalid({
        samplingPercentage: 0,
        session: { inactivityTimeout: 0, maxDuration: 0 },
        ...patch(value),
      });
      expect(() => create(update)).toThrow(path);
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg(update)).rejects.toThrow(path);
      expect(controller.snapshot()).toBe(original);
      expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
      expect(await controller.updateCfg({ onunloadDisableBeacon: false })).toEqual({
        revision: 1,
        changedPaths: ["azureMonitor.disableBeacon"],
      });
    });
  });

  it.each([
    { samplingPercentage: NaN },
    { samplingPercentage: "25" },
    { session: { inactivityTimeout: -1 } },
    { session: { maxDuration: null } },
    { sessionRenewalMs: -1 },
    { sessionExpirationMs: Infinity },
    { session: { inactivityTimeout: 0 }, sessionRenewalMs: 0 },
  ])(
    "does not commit a valid beacon policy alongside invalid sampling or sessions: %s",
    async (patch) => {
      const update = invalid({ ...initial, azureMonitor: { disableBeacon: false }, ...patch });
      expect(() => create(update)).toThrow();
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg(update)).rejects.toThrow();
      expect(controller.snapshot()).toBe(original);
      expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
    },
  );

  it.each([
    null,
    [],
    () => ({}),
    new Date(),
    0,
    "azureMonitor",
    true,
    Symbol("azureMonitor"),
    Object.create({ disableBeacon: true }) as unknown,
  ])("rejects non-plain native objects initially and at runtime: %s", async (azureMonitor) => {
    const update = invalid({ samplingPercentage: 0, azureMonitor });
    expect(() => create(update)).toThrow("plain object");
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg(update)).rejects.toThrow("plain object");
    expect(controller.snapshot()).toBe(original);
  });

  it.each([
    "connectionString",
    "initTimeOut",
    "initInMemoMaxSize",
    "onunloadDisableBeacon",
    "constructor",
    "prototype",
    "__proto__",
    Symbol("disableBeacon"),
  ])("rejects unsupported nested keys even when undefined or non-enumerable: %s", async (key) => {
    for (const enumerable of [false, true]) {
      for (const value of [undefined, "startup-only"]) {
        const azureMonitor = Object.defineProperty({ disableBeacon: false }, key, {
          value,
          enumerable,
        });
        const update = invalid({ samplingPercentage: 0, azureMonitor });
        expect(() => create(update)).toThrow("Unsupported configuration path");
        const { controller } = create(initial);
        const original = controller.snapshot();
        await expect(controller.updateCfg(update)).rejects.toThrow(
          "Unsupported configuration path",
        );
        expect(controller.snapshot()).toBe(original);
        expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
      }
    }
  });

  it.each(["disableBeacon", "connectionString", Symbol("onunloadDisableBeacon")])(
    "rejects unsupported root keys even when non-enumerable: %s",
    async (key) => {
      const update = invalid(
        Object.defineProperty({ onunloadDisableBeacon: false }, key, {
          value: undefined,
        }),
      );
      expect(() => create(update)).toThrow("Unsupported configuration path");
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg(update)).rejects.toThrow("Unsupported configuration path");
      expect(controller.snapshot()).toBe(original);
    },
  );

  it.each(["azureMonitor", "onunloadDisableBeacon", "disableBeacon"])(
    "rejects %s accessors without invoking application code",
    async (key) => {
      const getter = vi.fn(() => true);
      const setter = vi.fn();
      for (const enumerable of [false, true]) {
        const target = Object.defineProperty({}, key, { get: getter, set: setter, enumerable });
        const update = invalid(key === "disableBeacon" ? { azureMonitor: target } : target);
        expect(() => create(update)).toThrow("data property");
        const { controller } = create(initial);
        const original = controller.snapshot();
        await expect(controller.updateCfg(update)).rejects.toThrow("data property");
        expect(controller.snapshot()).toBe(original);
      }
      expect(getter).not.toHaveBeenCalled();
      expect(setter).not.toHaveBeenCalled();
    },
  );

  it("accepts own data on null-prototype root and nested objects", async () => {
    const azureMonitor = Object.assign(Object.create(null) as object, { disableBeacon: true });
    const patch = Object.assign(Object.create(null) as object, {
      azureMonitor,
      onunloadDisableBeacon: true,
    });
    expect(create(patch).controller.snapshot().azureMonitor).toEqual({ disableBeacon: true });
    const { controller } = create();
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: ["azureMonitor.disableBeacon"],
    });
    expect(controller.snapshot().azureMonitor).not.toBe(azureMonitor);
    expect(Object.isFrozen(controller.snapshot().azureMonitor)).toBe(true);
  });

  it("detaches initial, queued native and alias input without freezing caller objects", async () => {
    const azureMonitor = { disableBeacon: true };
    const { controller } = create({ azureMonitor });
    const original = controller.snapshot();
    azureMonitor.disableBeacon = false;
    expect(original.azureMonitor.disableBeacon).toBe(true);
    expect(original.azureMonitor).not.toBe(azureMonitor);
    expect(Object.isFrozen(azureMonitor)).toBe(false);

    const patch = { azureMonitor };
    const queued = controller.updateCfg(patch);
    azureMonitor.disableBeacon = true;
    patch.azureMonitor = { disableBeacon: true };
    expect(controller.snapshot()).toBe(original);
    expect(await queued).toEqual({ revision: 1, changedPaths: ["azureMonitor.disableBeacon"] });
    const first = controller.snapshot();
    expect(first.azureMonitor.disableBeacon).toBe(false);
    expect(Object.isFrozen(first.azureMonitor)).toBe(true);
    const alias = { onunloadDisableBeacon: true };
    const aliasUpdate = controller.updateCfg(alias);
    alias.onunloadDisableBeacon = false;
    expect(await aliasUpdate).toEqual({
      revision: 2,
      changedPaths: ["azureMonitor.disableBeacon"],
    });
    expect(controller.snapshot().azureMonitor.disableBeacon).toBe(true);
    expect(first.azureMonitor.disableBeacon).toBe(false);
    expect(original.azureMonitor.disableBeacon).toBe(true);
  });

  it("serializes all policies with canonical path ordering regardless of alias insertion order", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({
      onunloadDisableBeacon: true,
      sessionExpirationMs: 2000,
      sessionRenewalMs: 1000,
      samplingPercentage: 25,
    });
    const noOp = controller.updateCfg({ azureMonitor: { disableBeacon: true } });
    const second = controller.updateCfg({
      azureMonitor: { disableBeacon: false },
      session: { maxDuration: 0, inactivityTimeout: 0 },
      samplingPercentage: 0,
    });
    expect(controller.snapshot()).toBe(original);
    const firstResult = await first;
    const firstSnapshot = controller.snapshot();
    expect(firstResult).toEqual({ revision: 1, changedPaths });
    expect(await noOp).toEqual({ revision: 1, changedPaths: [] });
    expect(await second).toEqual({ revision: 2, changedPaths });
    expect(firstSnapshot).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: 25,
      session: { inactivityTimeout: 1, maxDuration: 2 },
      azureMonitor: { disableBeacon: true },
    });
    expect(Object.isFrozen(firstSnapshot.azureMonitor)).toBe(true);
    expect(Object.isFrozen(firstResult.changedPaths)).toBe(true);
    expect(original).toEqual(defaults);
    expect(controller.snapshot()).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: 0,
      session: { inactivityTimeout: 0, maxDuration: 0 },
      azureMonitor: { disableBeacon: false },
    });
  });

  it.each([
    { azureMonitor: { disableBeacon: true } },
    { onunloadDisableBeacon: true },
    { azureMonitor: undefined },
    { azureMonitor: {} },
  ])("rejects queued and future beacon calls once stopped: %s", async (patch) => {
    const { controller, stop } = create(initial);
    const original = controller.snapshot();
    const pending = controller.updateCfg(patch);
    const replacement = controller.updateCfg({}, false);
    stop();
    await expect(pending).rejects.toThrow("stopped");
    await expect(replacement).rejects.toThrow("stopped");
    await expect(controller.updateCfg(patch)).rejects.toThrow("stopped");
    expect(controller.snapshot()).toBe(original);
  });
});

describe("session lifetime configuration", () => {
  const defaults = { inactivityTimeout: 1800, maxDuration: 86400 };
  const changedPaths = ["samplingPercentage", "session.inactivityTimeout", "session.maxDuration"];
  const initial = {
    disableFetchTracking: false,
    disableAjaxTracking: false,
    samplingPercentage: 50,
    session: { inactivityTimeout: 60, maxDuration: 120 },
  };

  it.each(["sessionRenewalMs", "sessionExpirationMs"] as const)(
    "rejects positive %s values that underflow rather than disabling expiration",
    async (alias) => {
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg({ [alias]: Number.MIN_VALUE })).rejects.toThrow(
        "too small to represent",
      );
      expect(controller.snapshot()).toBe(original);
    },
  );

  it.each([
    { patch: {}, session: defaults },
    { patch: { session: {} }, session: defaults },
    { patch: { session: undefined }, session: defaults },
    {
      patch: { session: { inactivityTimeout: undefined, maxDuration: undefined } },
      session: defaults,
    },
    {
      patch: { session: { inactivityTimeout: 0, maxDuration: 0 } },
      session: { inactivityTimeout: 0, maxDuration: 0 },
    },
    { patch: { sessionRenewalMs: 0, sessionExpirationMs: 0 }, session: defaults },
    { patch: { sessionRenewalMs: undefined, sessionExpirationMs: undefined }, session: defaults },
    {
      patch: { sessionRenewalMs: 1500, sessionExpirationMs: 2250 },
      session: { inactivityTimeout: 1.5, maxDuration: 2.25 },
    },
    {
      patch: { session: { inactivityTimeout: 0.5, maxDuration: 1.25 } },
      session: { inactivityTimeout: 0.5, maxDuration: 1.25 },
    },
  ])("normalizes initial lifetimes: $patch", ({ patch, session }) => {
    const { controller } = create(patch);
    expect(controller.snapshot()).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: undefined,
      session,
      azureMonitor: { disableBeacon: false },
    });
    expect(Object.isFrozen(controller.snapshot())).toBe(true);
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);
  });

  it("treats an empty session patch as a supported no-op", async () => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    expect(await controller.updateCfg({ session: {} })).toEqual({ revision: 0, changedPaths: [] });
    expect(controller.snapshot()).toBe(original);
  });

  it.each([
    { patch: { session: undefined }, session: defaults, paths: changedPaths.slice(1) },
    {
      patch: { session: { inactivityTimeout: undefined } },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { session: { maxDuration: undefined } },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
    {
      patch: { sessionRenewalMs: undefined },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { sessionExpirationMs: undefined },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
    {
      patch: { sessionRenewalMs: 0 },
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["session.inactivityTimeout"],
    },
    {
      patch: { sessionExpirationMs: 0 },
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["session.maxDuration"],
    },
  ])(
    "resets only the requested lifetimes when merging: $patch",
    async ({ patch, session, paths }) => {
      const { controller } = create(initial);
      expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: paths });
      expect(controller.snapshot()).toEqual({
        disableFetchTracking: false,
        disableAjaxTracking: false,
        samplingPercentage: 50,
        session,
        azureMonitor: { disableBeacon: false },
      });
      expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: [] });
    },
  );

  it("distinguishes native zero from alias zero on both lifetime checks", async () => {
    const { controller } = create();
    expect(
      await controller.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } }),
    ).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 0 });
    expect(await controller.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: 0 })).toEqual({
      revision: 2,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual(defaults);
  });

  it.each([
    { patch: {}, samplingPercentage: undefined, session: defaults, paths: changedPaths },
    {
      patch: { session: {} },
      samplingPercentage: undefined,
      session: defaults,
      paths: changedPaths,
    },
    {
      patch: { samplingPercentage: 25 },
      samplingPercentage: 25,
      session: defaults,
      paths: changedPaths,
    },
    {
      patch: { samplingPercentage: 50 },
      samplingPercentage: 50,
      session: defaults,
      paths: changedPaths.slice(1),
    },
    {
      patch: { session: { inactivityTimeout: 60 } },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["samplingPercentage", "session.maxDuration"],
    },
    {
      patch: { session: { maxDuration: 120 } },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["samplingPercentage", "session.inactivityTimeout"],
    },
    {
      patch: { sessionRenewalMs: 60000 },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 60, maxDuration: 86400 },
      paths: ["samplingPercentage", "session.maxDuration"],
    },
    {
      patch: { sessionExpirationMs: 120000 },
      samplingPercentage: undefined,
      session: { inactivityTimeout: 1800, maxDuration: 120 },
      paths: ["samplingPercentage", "session.inactivityTimeout"],
    },
  ])(
    "resets all omitted supported fields when replacing: $patch",
    async ({ patch, samplingPercentage, session, paths }) => {
      const { controller } = create(initial);
      expect(await controller.updateCfg(patch, false)).toEqual({
        revision: 1,
        changedPaths: paths,
      });
      expect(controller.snapshot()).toEqual({
        disableFetchTracking: false,
        disableAjaxTracking: false,
        samplingPercentage,
        session,
        azureMonitor: { disableBeacon: false },
      });
      expect(await controller.updateCfg(patch, false)).toEqual({ revision: 1, changedPaths: [] });
    },
  );

  it.each([
    {
      session: { inactivityTimeout: 1.5, maxDuration: 2.25 },
      sessionRenewalMs: 1500,
      sessionExpirationMs: 2250,
    },
    { session: defaults, sessionRenewalMs: 0, sessionExpirationMs: 0 },
    {
      session: { inactivityTimeout: undefined, maxDuration: undefined },
      sessionRenewalMs: undefined,
      sessionExpirationMs: undefined,
    },
    { session: undefined, sessionRenewalMs: 1800000, sessionExpirationMs: 86400000 },
  ])("accepts equal native and alias values after normalization: %s", async (patch) => {
    const expected = create({
      sessionRenewalMs: patch.sessionRenewalMs,
      sessionExpirationMs: patch.sessionExpirationMs,
    }).controller.snapshot();
    expect(create(patch).controller.snapshot()).toEqual(expected);
    const { controller } = create(initial);
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot()).toEqual({ ...expected, samplingPercentage: 50 });
    expect(await controller.updateCfg(patch)).toEqual({ revision: 1, changedPaths: [] });
  });

  it.each([
    { session: { inactivityTimeout: 60 }, sessionRenewalMs: 61000 },
    { session: { maxDuration: 120 }, sessionExpirationMs: 121000 },
    { session: { inactivityTimeout: 0 }, sessionRenewalMs: 0 },
    { session: { maxDuration: 0 }, sessionExpirationMs: 0 },
    { session: undefined, sessionRenewalMs: 1000 },
    { session: undefined, sessionExpirationMs: 1000 },
    { session: { inactivityTimeout: undefined }, sessionRenewalMs: 1000 },
    { session: { maxDuration: undefined }, sessionExpirationMs: 1000 },
  ])("rejects conflicting normalized values atomically: %s", async (patch) => {
    expect(() => create(patch)).toThrow("Conflicting configuration paths");
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg({ ...patch, samplingPercentage: 0 })).rejects.toThrow(
      "Conflicting configuration paths",
    );
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("allows aliases and native fields in separate updates to replace each other", async () => {
    const { controller } = create(initial);
    expect(
      await controller.updateCfg({ sessionRenewalMs: 1000, sessionExpirationMs: 2000 }),
    ).toEqual({ revision: 1, changedPaths: changedPaths.slice(1) });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 1, maxDuration: 2 });
    expect(
      await controller.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } }),
    ).toEqual({ revision: 2, changedPaths: changedPaths.slice(1) });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 0 });
  });

  describe.each([
    {
      path: "session.inactivityTimeout",
      patch: (value: unknown) => ({ session: { inactivityTimeout: value } }),
    },
    {
      path: "session.maxDuration",
      patch: (value: unknown) => ({ session: { maxDuration: value } }),
    },
    { path: "sessionRenewalMs", patch: (value: unknown) => ({ sessionRenewalMs: value }) },
    { path: "sessionExpirationMs", patch: (value: unknown) => ({ sessionExpirationMs: value }) },
  ])("$path validation", ({ path, patch }) => {
    it.each([
      NaN,
      Infinity,
      -Infinity,
      -1,
      "60",
      null,
      true,
      {},
      [],
      () => 60,
      new Date(),
      Symbol("duration"),
    ])("rejects invalid durations: %s", async (value) => {
      const update = invalid({ ...patch(value), samplingPercentage: 0 });
      expect(() => create(update)).toThrow(path);
      const { controller } = create(initial);
      const original = controller.snapshot();
      await expect(controller.updateCfg(update)).rejects.toThrow(path);
      expect(controller.snapshot()).toBe(original);
      expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
      expect(await controller.updateCfg({ samplingPercentage: 25 })).toEqual({
        revision: 1,
        changedPaths: ["samplingPercentage"],
      });
    });
  });

  it.each([
    null,
    [],
    () => ({}),
    new Date(),
    1,
    "session",
    true,
    Symbol("session"),
    Object.create({ inactivityTimeout: 60 }),
  ])("rejects non-plain session objects: %s", async (session) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg(invalid({ samplingPercentage: 0, session }))).rejects.toThrow(
      "plain object",
    );
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it.each([
    { enabled: false },
    { persist: false },
    { storage: { enabled: false } },
    { session: { enabled: false, inactivityTimeout: 30 } },
    { session: { persist: false, maxDuration: 30 } },
    { session: { storage: {} } },
    { session: { sessionRenewalMs: 1000 } },
    { session: { [Symbol("inactivityTimeout")]: 60 } },
    { session: JSON.parse('{"__proto__":{}}') as unknown },
    { session: { constructor: 60 } },
    { session: { prototype: 60 } },
  ])("rejects unsupported properties without partially committing: %s", async (patch) => {
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(
      controller.updateCfg(
        invalid({
          samplingPercentage: 0,
          sessionRenewalMs: 1000,
          sessionExpirationMs: 2000,
          ...patch,
        }),
      ),
    ).rejects.toThrow("Unsupported configuration path");
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it.each([
    "session",
    "sessionRenewalMs",
    "sessionExpirationMs",
    "inactivityTimeout",
    "maxDuration",
  ])("rejects the %s accessor without invoking it", async (key) => {
    const getter = vi.fn(() => 60);
    const setter = vi.fn();
    const target = Object.defineProperty({}, key, { get: getter, set: setter });
    const patch =
      key === "inactivityTimeout" || key === "maxDuration"
        ? { samplingPercentage: 0, session: target }
        : Object.defineProperties(
            { samplingPercentage: 0 },
            Object.getOwnPropertyDescriptors(target),
          );
    const { controller } = create(initial);
    const original = controller.snapshot();
    await expect(controller.updateCfg(invalid(patch))).rejects.toThrow("data property");
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(controller.snapshot()).toBe(original);
    expect(await controller.updateCfg({})).toEqual({ revision: 0, changedPaths: [] });
  });

  it("accepts own non-enumerable and null-prototype session data", async () => {
    const session: object = Object.create(null) as object;
    Object.defineProperty(session, "inactivityTimeout", { value: 0 });
    Object.defineProperty(session, "maxDuration", { value: 2.5 });
    const patch = Object.create(null) as MicrosoftOpenTelemetryBrowserConfigurationUpdate;
    Object.defineProperty(patch, "session", { value: session });
    const { controller } = create();
    expect(await controller.updateCfg(patch)).toEqual({
      revision: 1,
      changedPaths: changedPaths.slice(1),
    });
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 0, maxDuration: 2.5 });
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);
  });

  it("captures initial and queued nested patches before callers mutate them", async () => {
    const session = { inactivityTimeout: 60, maxDuration: 120 };
    const { controller } = create({ session });
    const original = controller.snapshot();
    session.inactivityTimeout = 90;
    session.maxDuration = 180;
    expect(original.session).toEqual({ inactivityTimeout: 60, maxDuration: 120 });
    expect(Object.isFrozen(session)).toBe(false);

    const patch = { samplingPercentage: 25, session };
    const queued = controller.updateCfg(patch);
    patch.samplingPercentage = 75;
    session.inactivityTimeout = 0;
    session.maxDuration = 0;
    patch.session = { inactivityTimeout: 1, maxDuration: 2 };
    expect(controller.snapshot()).toBe(original);
    expect(await queued).toEqual({ revision: 1, changedPaths });
    expect(controller.snapshot()).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: 25,
      session: { inactivityTimeout: 90, maxDuration: 180 },
      azureMonitor: { disableBeacon: false },
    });
    expect(original.session).toEqual({ inactivityTimeout: 60, maxDuration: 120 });
    expect(Object.isFrozen(controller.snapshot().session)).toBe(true);

    const aliases = { sessionRenewalMs: 1000, sessionExpirationMs: 2000 };
    const aliasUpdate = controller.updateCfg(aliases);
    aliases.sessionRenewalMs = 9000;
    aliases.sessionExpirationMs = 10000;
    await aliasUpdate;
    expect(controller.snapshot().session).toEqual({ inactivityTimeout: 1, maxDuration: 2 });
  });

  it("serializes mixed updates with native ordered paths and immutable revision snapshots", async () => {
    const { controller } = create();
    const original = controller.snapshot();
    const first = controller.updateCfg({
      sessionExpirationMs: 2000,
      sessionRenewalMs: 1000,
      samplingPercentage: 25,
    });
    const noOp = controller.updateCfg({ session: { maxDuration: 2, inactivityTimeout: 1 } });
    const invalidUpdate = expect(
      controller.updateCfg(invalid({ session: { persist: false } })),
    ).rejects.toThrow("Unsupported configuration path");
    const second = controller.updateCfg({
      session: { maxDuration: 0, inactivityTimeout: 0 },
      samplingPercentage: 0,
    });
    expect(controller.snapshot()).toBe(original);
    const firstResult = await first;
    const firstSnapshot = controller.snapshot();
    expect(firstResult).toEqual({ revision: 1, changedPaths });
    expect(await noOp).toEqual({ revision: 1, changedPaths: [] });
    await invalidUpdate;
    expect(await second).toEqual({ revision: 2, changedPaths });
    expect(firstSnapshot).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: 25,
      session: { inactivityTimeout: 1, maxDuration: 2 },
      azureMonitor: { disableBeacon: false },
    });
    expect(original).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: undefined,
      session: defaults,
      azureMonitor: { disableBeacon: false },
    });
    expect(controller.snapshot()).toEqual({
      disableFetchTracking: false,
      disableAjaxTracking: false,
      samplingPercentage: 0,
      session: { inactivityTimeout: 0, maxDuration: 0 },
      azureMonitor: { disableBeacon: false },
    });
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(firstSnapshot.session)).toBe(true);
    expect(Object.isFrozen(firstResult)).toBe(true);
    expect(Object.isFrozen(firstResult.changedPaths)).toBe(true);
    expect(() => Object.assign(firstSnapshot.session, { inactivityTimeout: 99 })).toThrow(
      TypeError,
    );
    expect(await controller.updateCfg({}, false)).toEqual({ revision: 3, changedPaths });
    expect(controller.snapshot()).toEqual(original);
    const resetSnapshot = controller.snapshot();
    expect(await controller.updateCfg({ session: {} })).toEqual({ revision: 3, changedPaths: [] });
    expect(controller.snapshot()).toBe(resetSnapshot);
    expect(controller.snapshot().session).toBe(resetSnapshot.session);
  });
});

describe("configuration synchronization", () => {
  const handles: ReturnType<typeof createConfigurationSync>["handle"][] = [];
  const listeners: (() => void)[] = [];
  const allowed = new Set<string>();
  const accept = () => true;

  function adapter(
    controller: ReturnType<typeof createRuntimeConfiguration>,
    options: unknown = {},
  ) {
    const captured = captureConfigurationSync({ AppInsightsCfgSyncPlugin: options });
    if (!captured) throw new Error("Expected configuration sync opt-in");
    const adapter = createConfigurationSync(captured, controller);
    handles.push(adapter.handle);
    adapter.start();
    return adapter.handle;
  }

  function observe(name: string) {
    const events: CustomEvent<unknown>[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent<unknown>);
    globalThis.addEventListener(name, listener);
    listeners.push(() => globalThis.removeEventListener(name, listener));
    return events;
  }

  function dispatch(name: string, detail: unknown) {
    globalThis.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async function barrier(controller: ReturnType<typeof createRuntimeConfiguration>) {
    await controller.enqueue(() => {});
  }

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.shutdown();
    for (const remove of listeners.splice(0)) remove();
    vi.restoreAllMocks();
  });

  it("requires explicit opt-in and captures receive defaults", () => {
    expect(captureConfigurationSync(undefined)).toBeUndefined();
    expect(captureConfigurationSync({})).toBeUndefined();
    expect(captureConfigurationSync({ AppInsightsCfgSyncPlugin: undefined })).toBeUndefined();
    expect(() => captureConfigurationSync({ AppInsightsCfgSyncPlugin: null })).toThrow(
      "plain object",
    );
    expect(captureConfigurationSync({ AppInsightsCfgSyncPlugin: {} })).toEqual({
      mode: 2,
      name: "ai_cfgsync",
      excluded: new Set(),
      onError: undefined,
    });
  });

  it("does not register a receiver until its creator starts it", () => {
    const { controller } = create();
    const name = "part7-delayed-start";
    const add = vi.spyOn(globalThis, "addEventListener");
    const captured = captureConfigurationSync({
      AppInsightsCfgSyncPlugin: { customEvtName: name },
    });
    if (!captured) throw new Error("Expected configuration sync opt-in");
    const created = createConfigurationSync(captured, controller);
    handles.push(created.handle);

    expect(add).not.toHaveBeenCalled();
    created.start();
    expect(add).toHaveBeenCalledWith(name, expect.any(Function));
  });

  it("cleans up a receiver if registration succeeds before addEventListener throws", async () => {
    const { controller } = create();
    const name = "part7-failed-start";
    const nativeAdd = globalThis.addEventListener;
    const remove = vi.spyOn(globalThis, "removeEventListener");
    let throwAfterRegistration = true;
    vi.spyOn(globalThis, "addEventListener").mockImplementation((type, listener, options) => {
      nativeAdd.call(globalThis, type, listener, options);
      if (type === name && throwAfterRegistration) {
        throwAfterRegistration = false;
        throw new Error("registered before add failed");
      }
    });
    const captured = captureConfigurationSync({
      AppInsightsCfgSyncPlugin: { customEvtName: name },
    });
    if (!captured) throw new Error("Expected configuration sync opt-in");
    const created = createConfigurationSync(captured, controller);
    handles.push(created.handle);

    expect(() => created.start()).toThrow("registered before add failed");
    expect(remove).toHaveBeenCalledWith(name, expect.any(Function));
    dispatch(name, { cfg: { samplingPercentage: 20 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    created.handle.resume();
    dispatch(name, { cfg: { samplingPercentage: 30 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it("stops when resume is reentered during receiver registration", async () => {
    const { controller } = create();
    const name = "part7-resume-stop";
    const sync = adapter(controller, { customEvtName: name });
    sync.pause();
    const nativeAdd = globalThis.addEventListener;
    const add = vi.spyOn(globalThis, "addEventListener");
    const remove = vi.spyOn(globalThis, "removeEventListener");
    add.mockImplementation((type, listener, options) => {
      if (type === name) sync.shutdown();
      nativeAdd.call(globalThis, type, listener, options);
    });

    sync.resume();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(name, expect.any(Function));
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(add.mock.invocationCallOrder[0]!);
    sync.resume();
    dispatch(name, { cfg: { samplingPercentage: 20 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it("re-adds a receiver once when pause is reentered during removal", async () => {
    const { controller } = create();
    const name = "part7-pause-resume";
    const sync = adapter(controller, { customEvtName: name });
    const nativeRemove = globalThis.removeEventListener;
    const add = vi.spyOn(globalThis, "addEventListener");
    vi.spyOn(globalThis, "removeEventListener").mockImplementation((type, listener, options) => {
      if (type === name) sync.resume();
      nativeRemove.call(globalThis, type, listener, options);
    });

    sync.pause();
    expect(add).toHaveBeenCalledTimes(1);
    dispatch(name, { cfg: { samplingPercentage: 20 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBe(20);
  });

  it("captures options and exclusions without retaining mutable inputs", () => {
    const excluded = { samplingPercentage: true, disableAjaxTracking: false };
    const onError = vi.fn();
    const captured = captureConfigurationSync({
      AppInsightsCfgSyncPlugin: {
        syncMode: 1,
        customEvtName: "part7-options",
        nonOverrideConfigs: excluded,
        onError,
      },
    });
    excluded.samplingPercentage = false;
    expect(captured).toEqual({
      mode: 1,
      name: "part7-options",
      excluded: new Set(["samplingPercentage"]),
      onError,
    });
  });

  it("does not inherit polluted defaults in captured plugin options", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "syncMode");
    Object.defineProperty(Object.prototype, "syncMode", { value: 1, configurable: true });
    try {
      expect(captureConfigurationSync({ AppInsightsCfgSyncPlugin: {} })?.mode).toBe(2);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "syncMode", previous);
      else Reflect.deleteProperty(Object.prototype, "syncMode");
    }
  });

  it("rejects malformed startup options without invoking nested getters", () => {
    const getter = vi.fn(() => ({}));
    const accessor = Object.defineProperty({}, "AppInsightsCfgSyncPlugin", { get: getter });
    const nested = Object.defineProperty({}, "syncMode", { get: getter });
    const overrides = Object.defineProperty({}, "disableAjaxTracking", { get: getter });
    for (const value of [
      accessor,
      { AppInsightsCfgSyncPlugin: nested },
      { AppInsightsCfgSyncPlugin: { nonOverrideConfigs: overrides } },
      { AppInsightsCfgSyncPlugin: { syncMode: 3 } },
      { AppInsightsCfgSyncPlugin: { customEvtName: " " } },
      { AppInsightsCfgSyncPlugin: { onError: 1 } },
      { AppInsightsCfgSyncPlugin: { nonOverrideConfigs: { samplingPercentage: 1 } } },
      { AppInsightsCfgSyncPlugin: { nonOverrideConfigs: { connectionString: false } } },
      { AppInsightsCfgSyncPlugin: { [Symbol("option")]: true } },
      { AppInsightsCfgSyncPlugin: Object.create({ syncMode: 2 }) },
    ]) {
      expect(() => captureConfigurationSync(value)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("merges received fields, preserves omissions, and permits explicit sampling reset", async () => {
    const { controller } = create({ samplingPercentage: 50, disableAjaxTracking: true });
    expect(await controller.receive({ disableFetchTracking: true }, accept, allowed)).toEqual({
      revision: 1,
      changedPaths: ["disableFetchTracking"],
    });
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: 50,
      disableFetchTracking: true,
      disableAjaxTracking: true,
    });
    await controller.receive({ samplingPercentage: undefined }, accept, allowed);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    await controller.receive({ samplingPercentage: 0 }, accept, allowed);
    await controller.receive({ samplingPercentage: 100 }, accept, allowed);
    expect(controller.snapshot().samplingPercentage).toBe(100);
  });

  it("does not protect fields merely because a receive changed them", async () => {
    const { controller } = create();
    await controller.receive(
      { samplingPercentage: 20, disableFetchTracking: true },
      accept,
      allowed,
    );
    await controller.receive(
      { samplingPercentage: 30, disableFetchTracking: false },
      accept,
      allowed,
    );
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: 30,
      disableFetchTracking: false,
    });
  });

  it("protects initial sampling only when requested and honors configured exclusions", async () => {
    const controller = createRuntimeConfiguration(
      { samplingPercentage: 50 },
      () => false,
      undefined,
      true,
    );
    await controller.receive(
      { samplingPercentage: 10, disableFetchTracking: true, disableAjaxTracking: true },
      accept,
      new Set(["disableFetchTracking"]),
    );
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: 50,
      disableFetchTracking: false,
      disableAjaxTracking: true,
    });
  });

  it("locks successfully supplied local fields even for no-ops and explicit undefined", async () => {
    const { controller } = create();
    expect(
      await controller.updateCfg({
        disableFetchTracking: undefined,
        samplingPercentage: undefined,
      }),
    ).toEqual({ revision: 0, changedPaths: [] });
    await controller.receive(
      { samplingPercentage: 50, disableFetchTracking: true, disableAjaxTracking: true },
      accept,
      allowed,
    );
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: undefined,
      disableFetchTracking: false,
      disableAjaxTracking: true,
    });
  });

  it("locks all synchronized fields after a local replacement, including a no-op", async () => {
    const { controller } = create();
    expect(await controller.updateCfg({}, false)).toEqual({ revision: 0, changedPaths: [] });
    await controller.receive(
      { samplingPercentage: 10, disableFetchTracking: true, disableAjaxTracking: true },
      accept,
      allowed,
    );
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: undefined,
      disableFetchTracking: false,
      disableAjaxTracking: false,
    });
  });

  it("does not lock fields after validation or gate-application failures", async () => {
    let fail = true;
    const { controller } = create({}, () => {
      if (fail) throw new Error("gate failure");
    });
    await expect(controller.updateCfg(invalid({ samplingPercentage: -1 }))).rejects.toThrow();
    await expect(controller.updateCfg({ disableFetchTracking: true })).rejects.toThrow(
      "gate failure",
    );
    fail = false;
    await controller.receive(
      { samplingPercentage: 20, disableFetchTracking: true },
      accept,
      allowed,
    );
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: 20,
      disableFetchTracking: true,
    });
  });

  it("orders local and remote operations on the same queue", async () => {
    const first = create().controller;
    const local = first.updateCfg({ samplingPercentage: 40 });
    const remote = first.receive(
      { samplingPercentage: 80, disableAjaxTracking: true },
      accept,
      allowed,
    );
    await Promise.all([local, remote]);
    expect(first.snapshot()).toMatchObject({ samplingPercentage: 40, disableAjaxTracking: true });

    const second = create().controller;
    const received = second.receive({ samplingPercentage: 80 }, accept, allowed);
    const updated = second.updateCfg({ samplingPercentage: 40 });
    await Promise.all([received, updated]);
    expect(second.snapshot().samplingPercentage).toBe(40);
  });

  it("validates protected and excluded fields before dropping them", async () => {
    const { controller } = create();
    await controller.updateCfg({ samplingPercentage: 25 });
    const original = controller.snapshot();
    await expect(
      controller.receive(
        invalid({ samplingPercentage: -1, disableAjaxTracking: true }),
        accept,
        allowed,
      ),
    ).rejects.toThrow();
    await expect(
      controller.receive(
        invalid({ disableFetchTracking: "yes", disableAjaxTracking: true }),
        accept,
        new Set(["disableFetchTracking"]),
      ),
    ).rejects.toThrow();
    expect(controller.snapshot()).toBe(original);
  });

  it("captures received input before enqueue and rejects non-sync paths", async () => {
    const { controller } = create();
    const patch = { samplingPercentage: 10 };
    const received = controller.receive(patch, accept, allowed);
    patch.samplingPercentage = 90;
    await received;
    expect(controller.snapshot().samplingPercentage).toBe(10);
    await expect(
      controller.receive(
        invalid({ samplingPercentage: 20, session: { maxDuration: 1 } }),
        accept,
        allowed,
      ),
    ).rejects.toThrow();
    expect(controller.snapshot().samplingPercentage).toBe(10);
  });

  it("checks receive acceptance before committing queued work", async () => {
    const { controller } = create();
    let accepted = true;
    const original = controller.snapshot();
    const received = controller.receive({ samplingPercentage: 50 }, () => accepted, allowed);
    accepted = false;
    expect(await received).toEqual({ revision: 0, changedPaths: [] });
    expect(controller.snapshot()).toBe(original);
    await controller.receive({ samplingPercentage: 25 }, accept, allowed);
    expect(controller.snapshot().samplingPercentage).toBe(25);
  });

  it("copies exclusions before the caller can mutate its set", async () => {
    const { controller } = create();
    const excluded = new Set(["samplingPercentage"]);
    const received = controller.receive({ samplingPercentage: 20 }, accept, excluded);
    excluded.clear();
    await received;
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it("rechecks acceptance if a gate callback invalidates delivery before publication", async () => {
    let accepted = true;
    const { controller } = create({}, () => {
      accepted = false;
    });
    const original = controller.snapshot();
    const result = await controller.receive(
      { samplingPercentage: 50, disableFetchTracking: true },
      () => accepted,
      allowed,
    );
    expect(result).toEqual({ revision: 0, changedPaths: [] });
    expect(controller.snapshot()).toBe(original);
  });

  it("restores network gates when pause and resume cancel delivery during application", async () => {
    const gates: boolean[] = [];
    const sync = {
      handle: undefined as ReturnType<typeof createConfigurationSync>["handle"] | undefined,
    };
    const { controller } = create({}, (next) => {
      gates.push(next.disableFetchTracking);
      if (next.disableFetchTracking) {
        sync.handle?.pause();
        sync.handle?.resume();
      }
    });
    const name = "part7-gate-cancel";
    const onError = vi.fn();
    sync.handle = adapter(controller, { customEvtName: name, onError });
    const original = controller.snapshot();

    dispatch(name, { cfg: { disableFetchTracking: true } });
    await barrier(controller);
    expect(gates).toEqual([true, false]);
    expect(controller.snapshot()).toBe(original);
    expect(onError).not.toHaveBeenCalled();
  });

  it("receives default-channel events, merges partial payloads and never echoes", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    const sync = adapter(controller);
    const events = observe("ai_cfgsync");
    await expect(sync.sync()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    dispatch("ai_cfgsync", { cfg: { disableFetchTracking: true } });
    await barrier(controller);
    expect(controller.snapshot()).toMatchObject({
      samplingPercentage: 50,
      disableFetchTracking: true,
    });
    expect(events).toHaveLength(1);
    dispatch("ai_cfgsync", { cfg: { samplingPercentage: undefined } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it("broadcasts only on explicit sync with the complete allowed snapshot", async () => {
    const { controller } = create();
    const name = "part7-broadcast";
    const events = observe(name);
    const sync = adapter(controller, { syncMode: 1, customEvtName: name });
    await controller.updateCfg({ disableFetchTracking: true });
    expect(events).toHaveLength(0);
    const result = sync.sync();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    const detail = events[0]?.detail;
    expect(detail).toEqual({
      cfg: {
        samplingPercentage: undefined,
        disableFetchTracking: true,
        disableAjaxTracking: false,
      },
    });
    expect(Object.hasOwn((detail as { cfg: object }).cfg, "samplingPercentage")).toBe(true);
  });

  it("excludes configured broadcast and receive fields without widening the allowlist", async () => {
    const name = "part7-exclusions";
    const sender = create({ samplingPercentage: 50, disableFetchTracking: true }).controller;
    const receiver = create({ samplingPercentage: 10 }).controller;
    const events = observe(name);
    const sync = adapter(sender, {
      syncMode: 1,
      customEvtName: name,
      nonOverrideConfigs: { samplingPercentage: true },
    });
    adapter(receiver, {
      customEvtName: name,
      nonOverrideConfigs: { disableFetchTracking: true, disableAjaxTracking: false },
    });
    await sync.sync();
    await barrier(receiver);
    expect(events[0]?.detail).toEqual({
      cfg: { disableFetchTracking: true, disableAjaxTracking: false },
    });
    expect(receiver.snapshot()).toMatchObject({
      samplingPercentage: 10,
      disableFetchTracking: false,
    });
    dispatch(name, { cfg: { disableAjaxTracking: true } });
    await barrier(receiver);
    expect(receiver.snapshot().disableAjaxTracking).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("keeps custom channels separate and mode 0 inert", async () => {
    const first = create().controller;
    const second = create().controller;
    const off = create().controller;
    adapter(first, { customEvtName: "part7-a" });
    adapter(second, { customEvtName: "part7-b" });
    const disabled = adapter(off, { syncMode: 0, customEvtName: "part7-a" });
    const events = observe("part7-a");
    dispatch("part7-a", { cfg: { samplingPercentage: 30 } });
    await disabled.sync();
    await Promise.all([barrier(first), barrier(second), barrier(off)]);
    expect(first.snapshot().samplingPercentage).toBe(30);
    expect(second.snapshot().samplingPercentage).toBeUndefined();
    expect(off.snapshot().samplingPercentage).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("cancels queued delivery on pause even after resume and never replays", async () => {
    const { controller } = create();
    const name = "part7-pause";
    const sync = adapter(controller, { customEvtName: name });
    dispatch(name, { cfg: { samplingPercentage: 20 } });
    sync.pause();
    dispatch(name, { cfg: { samplingPercentage: 30 } });
    sync.resume();
    sync.resume();
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
    dispatch(name, { cfg: { samplingPercentage: 40 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBe(40);
  });

  it("cancels queued broadcasts on pause and permanently stops after shutdown", async () => {
    const { controller } = create();
    const name = "part7-stop";
    const events = observe(name);
    const sync = adapter(controller, { syncMode: 1, customEvtName: name });
    const pending = sync.sync();
    sync.pause();
    sync.resume();
    await expect(pending).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    await sync.sync();
    expect(events).toHaveLength(1);
    sync.shutdown();
    sync.resume();
    await expect(sync.sync()).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("removes a receiver on shutdown and invalidates queued delivery", async () => {
    const { controller } = create();
    const name = "part7-receiver-stop";
    const sync = adapter(controller, { customEvtName: name });
    dispatch(name, { cfg: { samplingPercentage: 20 } });
    sync.shutdown();
    sync.resume();
    dispatch(name, { cfg: { samplingPercentage: 30 } });
    await barrier(controller);
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it("retries a transient terminal listener removal while preserving the original failure", async () => {
    const { controller } = create();
    const name = "part7-removal-retry";
    const sync = adapter(controller, { customEvtName: name });
    const nativeRemove = globalThis.removeEventListener.bind(globalThis);
    const failure = new Error("transient sync cleanup failed");
    let attempts = 0;
    const removed = vi.spyOn(globalThis, "removeEventListener").mockImplementation((...args) => {
      if (args[0] === name && ++attempts === 1) throw failure;
      nativeRemove(...args);
    });
    try {
      expect(() => sync.shutdown()).toThrow(failure);
      expect(attempts).toBe(2);
      dispatch(name, { cfg: { samplingPercentage: 0 } });
      await barrier(controller);
      expect(controller.snapshot().samplingPercentage).toBeUndefined();
    } finally {
      removed.mockRestore();
    }
  });

  it.each([false, true])(
    "finishes reentrant shutdown after pause removal throws (native removal first=%s)",
    async (removedFirst) => {
      const { controller } = create();
      const name = "part7-pause-reentrant-shutdown";
      const add = vi.spyOn(globalThis, "addEventListener");
      const sync = adapter(controller, { customEvtName: name });
      const listener = add.mock.calls.find(([type]) => type === name)?.[1];
      expect(listener).toBeTypeOf("function");
      const nativeRemove = globalThis.removeEventListener.bind(globalThis);
      const failure = new Error("reentrant removal failed");
      let attempts = 0;
      let attached = true;
      const remove = vi.spyOn(globalThis, "removeEventListener").mockImplementation((...args) => {
        if (args[0] !== name || args[1] !== listener) return nativeRemove(...args);
        attempts++;
        sync.shutdown();
        if (attempts === 1 && !removedFirst) throw failure;
        nativeRemove(...args);
        attached = false;
        if (attempts === 1) throw failure;
      });
      try {
        expect(() => sync.pause()).toThrow(failure);
        expect(attempts).toBe(2);
        expect(attached).toBe(false);
        sync.resume();
        dispatch(name, { cfg: { samplingPercentage: 25 } });
        await barrier(controller);
        expect(controller.snapshot().samplingPercentage).toBeUndefined();
        expect(add.mock.calls.filter(([type]) => type === name)).toHaveLength(1);
      } finally {
        remove.mockRestore();
        if (listener) nativeRemove(name, listener);
      }
    },
  );

  it("bounds deferred shutdown cleanup when every reentrant removal fails", () => {
    const { controller } = create();
    const name = "part7-persistent-reentrant-shutdown";
    const add = vi.spyOn(globalThis, "addEventListener");
    const sync = adapter(controller, { customEvtName: name });
    const listener = add.mock.calls.find(([type]) => type === name)?.[1];
    const nativeRemove = globalThis.removeEventListener.bind(globalThis);
    const failure = new Error("persistent reentrant removal failed");
    let attempts = 0;
    const remove = vi.spyOn(globalThis, "removeEventListener").mockImplementation((...args) => {
      if (args[0] !== name || args[1] !== listener) return nativeRemove(...args);
      attempts++;
      sync.shutdown();
      throw failure;
    });
    try {
      expect(() => sync.pause()).toThrow(failure);
      expect(attempts).toBe(2);
    } finally {
      remove.mockRestore();
      if (listener) nativeRemove(name, listener);
    }
  });

  it("resumes after a removal wrapper removes the listener and then throws", async () => {
    const { controller } = create();
    const name = "part7-removed-then-thrown";
    const sync = adapter(controller, { customEvtName: name });
    const nativeRemove = globalThis.removeEventListener.bind(globalThis);
    const failure = new Error("post-removal failure");
    const remove = vi.spyOn(globalThis, "removeEventListener").mockImplementationOnce((...args) => {
      nativeRemove(...args);
      throw failure;
    });
    try {
      expect(() => sync.pause()).toThrow(failure);
      sync.resume();
      dispatch(name, { cfg: { samplingPercentage: 25 } });
      await barrier(controller);
      expect(controller.snapshot().samplingPercentage).toBe(25);
    } finally {
      remove.mockRestore();
    }
  });

  it("honors a reentrant resume when removal subsequently succeeds and throws", async () => {
    const { controller } = create();
    const name = "part7-reentrant-post-removal";
    const sync = adapter(controller, { customEvtName: name });
    const nativeRemove = globalThis.removeEventListener.bind(globalThis);
    const failure = new Error("post-removal reentrancy");
    const remove = vi.spyOn(globalThis, "removeEventListener").mockImplementationOnce((...args) => {
      sync.resume();
      nativeRemove(...args);
      throw failure;
    });
    try {
      expect(() => sync.pause()).toThrow(failure);
      dispatch(name, { cfg: { samplingPercentage: 25 } });
      await barrier(controller);
      expect(controller.snapshot().samplingPercentage).toBe(25);
    } finally {
      remove.mockRestore();
    }
  });

  it("rejects malformed envelopes and patches atomically without invoking getters", async () => {
    const { controller } = create({ samplingPercentage: 50 });
    const name = "part7-invalid";
    const onError = vi.fn();
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, "disableFetchTracking", { get: getter });
    const envelopeAccessor = Object.defineProperty({}, "cfg", { get: getter });
    adapter(controller, { customEvtName: name, onError });
    const original = controller.snapshot();
    for (const detail of [
      null,
      {},
      envelopeAccessor,
      { cfg: null },
      { cfg: [] },
      { cfg: Object.create({ samplingPercentage: 10 }) },
      { cfg: accessor },
      { cfg: { samplingPercentage: 20, [Symbol("extra")]: true } },
      { cfg: { samplingPercentage: 20, connectionString: "secret" } },
      { cfg: { samplingPercentage: 20, disableAjaxTracking: undefined } },
      { cfg: { samplingPercentage: NaN, disableAjaxTracking: true } },
      { cfg: { samplingPercentage: 101, disableAjaxTracking: true } },
      { cfg: { samplingPercentage: 20 }, extra: true },
    ])
      dispatch(name, detail);
    await barrier(controller);
    expect(getter).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(13);
    expect(controller.snapshot()).toBe(original);
  });

  it("reads native CustomEvent detail without invoking an own override or cfg getter", async () => {
    const { controller } = create();
    const name = "part7-native-detail";
    const onError = vi.fn();
    const detailGetter = vi.fn(() => ({ cfg: { samplingPercentage: 20 } }));
    const cfgGetter = vi.fn(() => ({ samplingPercentage: 20 }));
    adapter(controller, { customEvtName: name, onError });
    const event: Event = Object.defineProperty(
      new CustomEvent(name, { detail: Object.defineProperty({}, "cfg", { get: cfgGetter }) }),
      "detail",
      { get: detailGetter },
    );

    globalThis.dispatchEvent(event);
    await barrier(controller);
    expect(detailGetter).not.toHaveBeenCalled();
    expect(cfgGetter).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(controller.snapshot().samplingPercentage).toBeUndefined();
  });

  it("isolates throwing and rejecting error callbacks and continues receiving", async () => {
    const first = create().controller;
    const second = create().controller;
    const throwing = vi.fn(() => {
      throw new Error("report failed");
    });
    const rejecting = vi.fn(() => Promise.reject(new Error("report rejected")));
    adapter(first, { customEvtName: "part7-error-a", onError: throwing });
    adapter(second, { customEvtName: "part7-error-b", onError: rejecting });
    expect(() => dispatch("part7-error-a", { cfg: { samplingPercentage: -1 } })).not.toThrow();
    expect(() => dispatch("part7-error-b", { cfg: { disableAjaxTracking: "yes" } })).not.toThrow();
    await Promise.all([barrier(first), barrier(second)]);
    expect(throwing).toHaveBeenCalledOnce();
    expect(rejecting).toHaveBeenCalledOnce();
    dispatch("part7-error-a", { cfg: { samplingPercentage: 10 } });
    dispatch("part7-error-b", { cfg: { samplingPercentage: 20 } });
    await Promise.all([barrier(first), barrier(second)]);
    expect(first.snapshot().samplingPercentage).toBe(10);
    expect(second.snapshot().samplingPercentage).toBe(20);
  });

  it("reports queued gate failures without locking later remote updates", async () => {
    let fail = true;
    const { controller } = create({}, () => {
      if (fail) throw new Error("remote gate failed");
    });
    const onError = vi.fn();
    const name = "part7-gate-error";
    adapter(controller, { customEvtName: name, onError });
    dispatch(name, { cfg: { disableFetchTracking: true } });
    await barrier(controller);
    expect(onError).toHaveBeenCalledOnce();
    expect(controller.snapshot().disableFetchTracking).toBe(false);
    fail = false;
    dispatch(name, { cfg: { disableFetchTracking: true } });
    await barrier(controller);
    expect(controller.snapshot().disableFetchTracking).toBe(true);
  });
});
