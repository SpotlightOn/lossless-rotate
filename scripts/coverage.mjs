#!/usr/bin/env node
/**
 * Coverage run and badge refresh: writes `coverage/lcov.info` and the committed badge in
 * `.github/badges/coverage.svg`, using Node's own test runner instead of a coverage package.
 *
 * `bin/` stays out of the report: the CLI suites start it in a child process, and V8 coverage only
 * sees the test runner's own process.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file so the script works from any working directory. */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const lcovPath = join(packageRoot, "coverage", "lcov.info");
const badgePath = join(packageRoot, ".github", "badges", "coverage.svg");
const badgeLabel = "coverage";

/** Minimum totals, a few points under the current values: a regression fails, a small test does not. */
const thresholds = { lines: 95, branches: 85, functions: 90 };

/** The shields.io scale. */
const badgeColors = [
  { min: 95, color: "#4c1" },
  { min: 90, color: "#97ca00" },
  { min: 80, color: "#a4a61d" },
  { min: 70, color: "#dfb317" },
  { min: 60, color: "#fe7d37" },
  { min: 0, color: "#e05d44" },
];

/**
 * Advance widths for the Verdana-ish 11px the badge renders in. Only the narrow and the wide
 * characters need an entry; everything else moves by the same amount.
 */
const advanceWidths = { ".": 4, ",": 4, "%": 12, " ": 4 };

const textWidth = (text) => [...text].reduce((width, char) => width + (advanceWidths[char] ?? 7), 0);

const percent = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);

/** One decimal place, without a pointless `.0` on a round number. */
const formatPercent = (value) => `${value.toFixed(1).replace(/\.0$/, "")}%`;

function badgeColor(value) {
  return badgeColors.find((entry) => value >= entry.min)?.color ?? badgeColors.at(-1).color;
}

/** A flat shields.io-style SVG, built from plain text elements so the numbers stay readable in a diff. */
function badgeSvg(label, value, color) {
  const labelWidth = Math.round(textWidth(label) + 10);
  const valueWidth = Math.round(textWidth(value) + 10);
  const width = labelWidth + valueWidth;
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;
  const title = `${label}: ${value}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">
  <title>${title}</title>
  <linearGradient id="shade" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="edge"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#edge)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#shade)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${label}</text>
    <text x="${labelX}" y="14">${label}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3" aria-hidden="true">${value}</text>
    <text x="${valueX}" y="14">${value}</text>
  </g>
</svg>
`;
}

/** Sums the `LF`/`LH`, `BRF`/`BRH` and `FNF`/`FNH` lines of every `SF:` record; the rest is ignored. */
function readTotals(lcov) {
  const total = {
    lines: { hit: 0, found: 0 },
    branches: { hit: 0, found: 0 },
    functions: { hit: 0, found: 0 },
  };
  for (const line of lcov.split("\n")) {
    const match = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const counter = key.startsWith("BR") ? total.branches : key.startsWith("FN") ? total.functions : total.lines;
    counter[key.endsWith("H") ? "hit" : "found"] += Number(value);
  }

  return total;
}

/**
 * Every file under `src/` has to show up in the report. The runner only lists the files the suite
 * loaded (`--test-coverage-include-all` would add the rest, but it only exists from Node 26 on), so
 * without this check a new source file that no test imports would stay invisible to the thresholds.
 */
function unreportedSources(lcov) {
  const reported = new Set([...lcov.matchAll(/^SF:(.+)$/gm)].map(([, file]) => file.replaceAll("\\", "/")));

  return readdirSync(join(packageRoot, "src"), { recursive: true })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `src/${entry.split(sep).join("/")}`)
    .filter((entry) => !reported.has(entry));
}

/** Markdown table for `$GITHUB_STEP_SUMMARY`, so the numbers show up on the job page. */
function summaryTable(total) {
  const rows = Object.entries(total).map(([name, { hit, found }]) => {
    const share = percent(hit, found).toFixed(2);
    return `| ${name[0].toUpperCase()}${name.slice(1)} | ${hit} | ${found} | ${share} % |`;
  });

  return ["### Coverage", "", "| | hit | total | % |", "| --- | ---: | ---: | ---: |", ...rows, ""].join("\n");
}

const summaryIndex = process.argv.indexOf("--summary");
const summaryPath = summaryIndex === -1 ? undefined : process.argv[summaryIndex + 1];

mkdirSync(dirname(lcovPath), { recursive: true });

const run = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-branches=${thresholds.branches}`,
    `--test-coverage-functions=${thresholds.functions}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}

// A crashed run leaves no or a partial report; the exit code from the test runner says what happened.
if (!existsSync(lcovPath)) process.exit(run.status ?? 1);

const lcov = readFileSync(lcovPath, "utf8");
const missing = unreportedSources(lcov);

if (missing.length > 0) {
  console.error(`no coverage entry for ${missing.join(", ")} - no test imports them`);
  process.exit(1);
}

const total = readTotals(lcov);
const linePercent = percent(total.lines.hit, total.lines.found);
const svg = badgeSvg(badgeLabel, formatPercent(linePercent), badgeColor(linePercent));
const unchanged = existsSync(badgePath) && readFileSync(badgePath, "utf8") === svg;

if (!unchanged) {
  mkdirSync(dirname(badgePath), { recursive: true });
  writeFileSync(badgePath, svg);
}

if (summaryPath) writeFileSync(summaryPath, summaryTable(total), { flag: "a" });

const badgeState = unchanged ? "unchanged" : "updated";
console.log(
  `\nline coverage ${formatPercent(linePercent)} (${total.lines.hit}/${total.lines.found}) - badge ${badgeState}`,
);

process.exit(run.status ?? 1);
