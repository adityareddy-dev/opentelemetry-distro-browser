// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { rollup, VERSION as rollupVersion } from "rollup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDirectory = resolve(root, "reports");
const temporaryDirectory = resolve(reportsDirectory, ".size-inputs");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageName = packageJson.name;

export const entryPointBudgets = {
  ".": {
    rawBytes: 157 * 1024,
    gzipBytes: 49.25 * 1024,
    brotliBytes: 43.5 * 1024,
  },
  "./instrumentations": {
    rawBytes: 64 * 1024,
    gzipBytes: 24 * 1024,
    brotliBytes: 22 * 1024,
  },
  // The generator validates its options and assembles optional loader steps. It runs where the
  // page is rendered; the snippet it emits only contains the steps a page enables.
  "./snippet": {
    rawBytes: 6.25 * 1024,
    gzipBytes: 2.75 * 1024,
    brotliBytes: 2.5 * 1024,
  },
};

// The SDK browser bundle also carries every instrumentation, because CDN users cannot add them later.
const sdkBrowserBundleBudget = {
  rawBytes: 184.25 * 1024,
  gzipBytes: 58.75 * 1024,
  brotliBytes: 51.5 * 1024,
};
const instrumentationsBrowserBundleBudget = {
  rawBytes: 63 * 1024,
  gzipBytes: 19 * 1024,
  brotliBytes: 17 * 1024,
};

/**
 * Blocking budgets for the minified self-contained browser bundles emitted by `npm run build`,
 * keyed by their path relative to the repository root.
 */
export const browserBundleBudgets = {
  "dist/browser/opentelemetry-browser.iife.min.js": sdkBrowserBundleBudget,
  "dist/browser/opentelemetry-browser.umd.min.js": sdkBrowserBundleBudget,
  "dist/browser/opentelemetry-browser-instrumentations.iife.min.js":
    instrumentationsBrowserBundleBudget,
  "dist/browser/opentelemetry-browser-instrumentations.umd.min.js":
    instrumentationsBrowserBundleBudget,
};

const API_IMPORTS = `
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
`;
const API_SYMBOLS = ["context", "diag", "propagation", "trace", "logs"];

const SDK_IMPORTS = `
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
`;
const SDK_SYMBOLS = [...API_SYMBOLS, "startBrowserSdk"];

const DISTRIBUTION_IMPORTS = `
import { useMicrosoftOpenTelemetry } from "${packageName}";
`;
const DISTRIBUTION_SYMBOLS = [...SDK_SYMBOLS, "useMicrosoftOpenTelemetry"];

const EXPORTER_IMPORTS = `
import { AzureMonitorLogRecordExporter, AzureMonitorSpanExporter } from "${packageName}";
`;
const EXPORTER_SYMBOLS = [
  ...SDK_SYMBOLS,
  "AzureMonitorLogRecordExporter",
  "AzureMonitorSpanExporter",
];

const INSTRUMENTATIONS = [
  ["fetch", "fetch", "FetchInstrumentation"],
  ["xhr", "xhr", "XhrInstrumentation"],
  ["console", "console", "ConsoleInstrumentation"],
  ["errors", "errors", "ErrorsInstrumentation"],
  ["navigation", "navigation", "NavigationInstrumentation"],
  ["navigation-timing", "navigation-timing", "NavigationTimingInstrumentation"],
  ["resource-timing", "resource-timing", "ResourceTimingInstrumentation"],
  ["user-action", "user-action", "UserActionInstrumentation"],
  ["web-vitals", "web-vitals", "WebVitalsInstrumentation"],
];

const sink = (...symbols) => `globalThis.__bundleSizeSink = [${symbols.join(", ")}];\n`;
const baseCode = (imports, symbols) => API_IMPORTS + imports + sink(...symbols);

const apiScenario = {
  id: "api",
  label: "OpenTelemetry API only (traces and logs)",
  group: "layer",
  entryPoint: "@opentelemetry/api + @opentelemetry/api-logs",
  code: API_IMPORTS + sink(...API_SYMBOLS),
};

const sdkScenario = {
  id: "sdk",
  label: "+ browser SDK",
  group: "layer",
  entryPoint: "@opentelemetry/browser-sdk",
  baseline: "api",
  code: baseCode(SDK_IMPORTS, SDK_SYMBOLS),
};

const distributionScenario = {
  id: "distribution",
  label: "+ browser distribution initializer",
  group: "layer",
  entryPoint: ".",
  baseline: "sdk",
  code: baseCode(SDK_IMPORTS + DISTRIBUTION_IMPORTS, DISTRIBUTION_SYMBOLS),
};

const exporterScenario = {
  id: "azure-monitor-exporters",
  label: "+ Azure Monitor span and log exporters",
  group: "exporter",
  entryPoint: ".",
  baseline: "api",
  code: API_IMPORTS + EXPORTER_IMPORTS + sink(...API_SYMBOLS, ...EXPORTER_SYMBOLS.slice(-2)),
};

const instrumentationScenarios = INSTRUMENTATIONS.map(([id, subpath, symbol]) => ({
  id: `instrumentation-${id}`,
  label: `+ ${id} instrumentation`,
  group: "instrumentation",
  entryPoint: `@opentelemetry/browser-instrumentation/experimental/${subpath}`,
  baseline: "distribution",
  code:
    API_IMPORTS +
    SDK_IMPORTS +
    DISTRIBUTION_IMPORTS +
    `import { ${symbol} } from "@opentelemetry/browser-instrumentation/experimental/${subpath}";\n` +
    sink(...DISTRIBUTION_SYMBOLS, symbol),
}));

const publishedRootScenario = {
  id: "published-root",
  label: "Published root entry (complete runtime exports)",
  group: "entry-point",
  entryPoint: ".",
  code: `import * as publishedRoot from "${packageName}";\n${sink("publishedRoot")}`,
};

const publishedInstrumentationsScenario = {
  id: "published-instrumentations",
  label: "Published instrumentations entry (loader and async chunks)",
  group: "entry-point",
  entryPoint: "./instrumentations",
  code: `import * as publishedInstrumentations from "${packageName}/instrumentations";\n${sink("publishedInstrumentations")}`,
};

const publishedSnippetScenario = {
  id: "published-snippet",
  label: "Published snippet generator",
  group: "entry-point",
  entryPoint: "./snippet",
  code: `import * as publishedSnippet from "${packageName}/snippet";\n${sink("publishedSnippet")}`,
};

const everythingScenario = {
  id: "everything",
  label: "Distribution, exporters, loader, and every instrumentation",
  group: "total",
  entryPoint: ". + ./instrumentations",
  code:
    API_IMPORTS +
    SDK_IMPORTS +
    DISTRIBUTION_IMPORTS +
    EXPORTER_IMPORTS +
    `import { getInstrumentations } from "${packageName}/instrumentations";\n` +
    sink(
      ...DISTRIBUTION_SYMBOLS,
      "AzureMonitorLogRecordExporter",
      "AzureMonitorSpanExporter",
      "getInstrumentations",
    ),
};

export const scenarios = [
  apiScenario,
  sdkScenario,
  distributionScenario,
  exporterScenario,
  publishedRootScenario,
  publishedInstrumentationsScenario,
  publishedSnippetScenario,
  ...instrumentationScenarios,
  everythingScenario,
];

export const executablePublishedEntryPoints = Object.entries(packageJson.exports)
  .filter(([, target]) => typeof target === "object" && target?.import?.default)
  .map(([entryPoint]) => entryPoint);

function validateScenarios() {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  if (byId.size !== scenarios.length) throw new Error("Bundle-size scenario IDs must be unique.");

  for (const scenario of scenarios) {
    if (scenario.baseline && !byId.has(scenario.baseline)) {
      throw new Error(`Unknown baseline ${scenario.baseline} for scenario ${scenario.id}.`);
    }
  }

  const coveredEntries = new Set(
    scenarios
      .filter((scenario) => scenario.group === "entry-point")
      .map(({ entryPoint }) => entryPoint),
  );
  for (const entryPoint of executablePublishedEntryPoints) {
    if (!coveredEntries.has(entryPoint)) {
      throw new Error(`Published JavaScript entry point ${entryPoint} has no size scenario.`);
    }
    if (!entryPointBudgets[entryPoint]) {
      throw new Error(`Published JavaScript entry point ${entryPoint} has no size budget.`);
    }
  }
  for (const entryPoint of Object.keys(entryPointBudgets)) {
    if (!executablePublishedEntryPoints.includes(entryPoint)) {
      throw new Error(
        `Size budget ${entryPoint} does not match a published JavaScript entry point.`,
      );
    }
  }
}

const measureChunk = (fileName, type, code) => ({
  fileName,
  type,
  rawBytes: Buffer.byteLength(code),
  gzipBytes: gzipSync(code, { level: 9 }).byteLength,
  brotliBytes: brotliCompressSync(code, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength,
});

const sumChunks = (chunks) => ({
  rawBytes: chunks.reduce((total, chunk) => total + chunk.rawBytes, 0),
  gzipBytes: chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0),
  brotliBytes: chunks.reduce((total, chunk) => total + chunk.brotliBytes, 0),
});

async function measureScenario(scenario) {
  const input = resolve(temporaryDirectory, `${scenario.id}.mjs`);
  await writeFile(input, scenario.code, "utf8");
  const bundle = await rollup({
    input,
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      defaultHandler(warning);
    },
    treeshake: {
      moduleSideEffects: "no-external",
      propertyReadSideEffects: false,
      tryCatchDeoptimization: false,
    },
  });

  try {
    const { output } = await bundle.generate({
      format: "es",
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name].js",
      plugins: [terser()],
    });
    const chunks = output
      .filter((item) => item.type === "chunk")
      .map((chunk) =>
        measureChunk(
          chunk.fileName,
          chunk.isEntry ? "entry" : chunk.isDynamicEntry ? "dynamic" : "shared",
          chunk.code,
        ),
      )
      .sort((left, right) => left.fileName.localeCompare(right.fileName));

    return {
      id: scenario.id,
      label: scenario.label,
      group: scenario.group,
      entryPoint: scenario.entryPoint,
      format: "rollup-esm-scenario",
      target: "browser ES module",
      ...(scenario.baseline ? { baseline: scenario.baseline } : {}),
      ...sumChunks(chunks),
      chunks,
    };
  } finally {
    await bundle.close();
  }
}

async function measureBrowserBundle(artifact) {
  let code;
  try {
    code = await readFile(resolve(root, artifact));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${artifact}; run \`npm run build\` before \`npm run size\`.`, {
        cause: error,
      });
    }
    throw error;
  }
  const fileName = artifact.slice(artifact.lastIndexOf("/") + 1);
  const moduleFormat = /\.umd\.min\.js$/.test(fileName) ? "umd" : "iife";
  const chunks = [measureChunk(fileName, "entry", code)];
  return {
    id: `browser-${fileName.replace(/\.min\.js$/, "").replace(/\./g, "-")}`,
    label: `Browser bundle \`${fileName}\``,
    group: "browser-bundle",
    entryPoint: artifact,
    format: `browser-${moduleFormat}-bundle`,
    target: `browser classic script (${moduleFormat.toUpperCase()})`,
    ...sumChunks(chunks),
    chunks,
  };
}

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const formatDelta = (bytes) => `${bytes >= 0 ? "+" : "-"}${formatKilobytes(Math.abs(bytes))}`;

export function getBudgetPolicy(version) {
  const prereleaseChannel = version.match(/^[^-]+-([^.+]+)/)?.[1];
  return {
    mode: prereleaseChannel === "alpha" ? "report-only" : "blocking",
    blockingFrom: "beta",
  };
}

const budgetedGroups = new Set(["entry-point", "browser-bundle"]);

export function addBudgetResults(
  measurements,
  budgets = { ...entryPointBudgets, ...browserBundleBudgets },
) {
  return measurements.map((measurement) => {
    const budget = budgets[measurement.entryPoint];
    if (!budgetedGroups.has(measurement.group) || !budget) return measurement;
    const exceededMetrics = ["rawBytes", "gzipBytes", "brotliBytes"].filter(
      (metric) => measurement[metric] > budget[metric],
    );
    return {
      ...measurement,
      budget,
      budgetStatus: exceededMetrics.length === 0 ? "pass" : "exceeded",
      exceededMetrics,
    };
  });
}

export function getBudgetViolations(report) {
  return report.scenarios.filter(({ budgetStatus }) => budgetStatus === "exceeded");
}

export function enforceBundleSizeBudgets(report) {
  // Browser bundle budgets block in every release channel; npm entry-point budgets follow the
  // release-channel policy.
  const violations = getBudgetViolations(report).filter(
    ({ group }) => group === "browser-bundle" || report.budgetPolicy.mode === "blocking",
  );
  if (violations.length > 0) {
    throw new Error(
      `Bundle size budgets exceeded: ${violations.map(({ entryPoint }) => entryPoint).join(", ")}`,
    );
  }
}

export function addDeltas(measurements) {
  const byId = new Map(measurements.map((measurement) => [measurement.id, measurement]));
  return measurements.map((measurement) => {
    if (!measurement.baseline) return measurement;
    const baseline = byId.get(measurement.baseline);
    if (!baseline) throw new Error(`Missing measured baseline ${measurement.baseline}.`);
    return {
      ...measurement,
      baselineGzipBytes: baseline.gzipBytes,
      gzipDeltaBytes: measurement.gzipBytes - baseline.gzipBytes,
      baselineBrotliBytes: baseline.brotliBytes,
      brotliDeltaBytes: measurement.brotliBytes - baseline.brotliBytes,
    };
  });
}

function markdownTable(rows, includeBaseline = true) {
  const lines = [
    includeBaseline
      ? "| Scenario | Baseline | Minified | Total gzip | Gzip delta | Total Brotli | Brotli delta | Chunks |"
      : "| Scenario | Minified | Total gzip | Total Brotli | Chunks |",
    includeBaseline ? "|---|---|---:|---:|---:|---:|---:|---:|" : "|---|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      includeBaseline
        ? `| ${row.label} | ${row.baseline ?? "-"} | ${formatKilobytes(row.rawBytes)} | ${formatKilobytes(row.gzipBytes)} | ${row.gzipDeltaBytes === undefined ? "-" : formatDelta(row.gzipDeltaBytes)} | ${formatKilobytes(row.brotliBytes)} | ${row.brotliDeltaBytes === undefined ? "-" : formatDelta(row.brotliDeltaBytes)} | ${row.chunks.length} |`
        : `| ${row.label} | ${formatKilobytes(row.rawBytes)} | ${formatKilobytes(row.gzipBytes)} | ${formatKilobytes(row.brotliBytes)} | ${row.chunks.length} |`,
    );
  }
  return lines;
}

function budgetMarkdownTable(rows, heading = "Entry point") {
  const lines = [
    `| ${heading} | Minified | Budget | Gzip | Budget | Brotli | Budget | Result |`,
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.entryPoint} | ${formatKilobytes(row.rawBytes)} | ${formatKilobytes(row.budget.rawBytes)} | ${formatKilobytes(row.gzipBytes)} | ${formatKilobytes(row.budget.gzipBytes)} | ${formatKilobytes(row.brotliBytes)} | ${formatKilobytes(row.budget.brotliBytes)} | ${row.budgetStatus === "pass" ? "Pass" : `Exceeded (${row.exceededMetrics.join(", ")})`} |`,
    );
  }
  return lines;
}

export function createMarkdownReport(report) {
  const byGroup = (group) => report.scenarios.filter((scenario) => scenario.group === group);
  const lines = [
    "# Browser bundle size report",
    "",
    "Generated by `npm run size`. Every total is an independent Rollup browser build of a real",
    "consumer entry point, tree-shaken, minified, and reported as gzip and Brotli transfer size.",
    "",
    "Per-package deltas are marginal costs relative to the named baseline. **Do not sum deltas:**",
    "shared dependencies are counted once in a combined bundle. Use the independently measured",
    "totals, especially the `everything` scenario, when comparing complete configurations.",
    "",
    `Package: \`${report.package.name}@${report.package.version}\``,
    "",
    "## Layers",
    "",
    ...markdownTable(byGroup("layer")),
    "",
    "## Azure Monitor exporter",
    "",
    ...markdownTable(byGroup("exporter")),
    "",
    "## Published entry points",
    "",
    `Budget policy: **${report.budgetPolicy.mode}**. Alpha releases report violations; beta,`,
    "release-candidate, and stable releases fail the size command when an absolute budget is",
    "exceeded.",
    "",
    ...budgetMarkdownTable(byGroup("entry-point")),
    "",
    "The metadata-only `./package.json` export is excluded because it is not executable browser",
    "JavaScript.",
    "",
    "## Browser bundles",
    "",
    "Budget policy: **blocking**. The minified self-contained UMD and IIFE bundles emitted by",
    "`npm run build` are measured as published, and exceeding any budget fails the size command.",
    "",
    ...budgetMarkdownTable(byGroup("browser-bundle"), "Artifact"),
    "",
    "## Instrumentations",
    "",
    ...markdownTable(byGroup("instrumentation")),
    "",
    "## Combined total",
    "",
    ...markdownTable(byGroup("total"), false),
    "",
  ];
  return lines.join("\n");
}

export function createReport(measurements) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    package: { name: packageName, version: packageJson.version },
    bundler: { name: "rollup", version: rollupVersion },
    target: "browser; each scenario records its own format and target",
    compression: "gzip level 9 and Brotli quality 11, measured per emitted JavaScript chunk",
    budgetPolicy: getBudgetPolicy(packageJson.version),
    scenarios: addBudgetResults(addDeltas(measurements)),
  };
}

export async function run() {
  validateScenarios();
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });

  try {
    const measurements = [];
    for (const scenario of scenarios) {
      process.stderr.write(`Measuring ${scenario.id}\n`);
      measurements.push(await measureScenario(scenario));
    }
    for (const artifact of Object.keys(browserBundleBudgets)) {
      process.stderr.write(`Measuring ${artifact}\n`);
      measurements.push(await measureBrowserBundle(artifact));
    }
    const report = createReport(measurements);
    const markdown = createMarkdownReport(report);
    await writeFile(
      resolve(reportsDirectory, "bundle-size.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(resolve(reportsDirectory, "bundle-size.md"), markdown, "utf8");
    process.stdout.write(markdown);
    enforceBundleSizeBudgets(report);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
