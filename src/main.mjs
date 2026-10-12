#!/usr/bin/env node
// Entry point for the composite action.
//
//   node main.mjs prepare  validate inputs, output the state file path and cache keys
//   node main.mjs run      diff the sitemap against the state, submit, write new state
//
// Inputs are passed as INPUT_<NAME> environment variables by action.yml.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheKeys, joinWithinLimit, parseConfig, readState, run, serializeState } from "./run.mjs";

const INPUTS = [
  "site-url",
  "key",
  "sitemap-url",
  "key-location",
  "mode",
  "on-missing-state",
  "endpoint",
  "dry-run",
  "cache-key-prefix",
];

/** @param {string} name */
const env = (name) => process.env[name] ?? "";

/** @param {string} message */
const log = (message) => console.log(message);

/** @param {string} message */
const escapeCommand = (message) => message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** @param {string} message */
const warn = (message) => console.log(`::warning::${escapeCommand(message)}`);

/**
 * @param {string} name
 * @param {string | number} value
 */
function setOutput(name, value) {
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(env("GITHUB_OUTPUT"), `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/**
 * @param {string} title
 * @param {string[]} lines
 */
function group(title, lines) {
  if (lines.length === 0) return;
  console.log(`::group::${title} (${lines.length})`);
  for (const line of lines) console.log(line);
  console.log("::endgroup::");
}

function readConfig() {
  return parseConfig(
    Object.fromEntries(INPUTS.map((name) => [name, process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`]])),
  );
}

function prepare() {
  const config = readConfig();
  // Caches are scoped to the ref, and a tag run can only restore caches from that
  // same tag or the default branch, so state saved by one tag is invisible to the next.
  if (env("GITHUB_REF").startsWith("refs/tags/")) {
    warn(
      `Running on tag ref ${env("GITHUB_REF")}: the cached state is scoped to this tag and won't be ` +
        "restored by runs for other tags, so every run starts without state. Run the action on the default " +
        "branch instead, for example from a workflow_run-triggered workflow.",
    );
  }
  const keys = cacheKeys(config, { runId: env("GITHUB_RUN_ID") || "local", runAttempt: env("GITHUB_RUN_ATTEMPT") || "1" });
  const stateDir = join(env("RUNNER_TEMP") || ".", "indexnow-state", keys.safeHost);
  setOutput("state-dir", stateDir);
  setOutput("state-file", join(stateDir, "state.json"));
  setOutput("restore-key", keys.restoreKey);
  setOutput("save-key", keys.saveKey);
}

const SUMMARY_ROW_LIMIT = 500;

// GitHub limits outputs to 1 MB per job, counted as UTF-16 (2 bytes per character).
// Leave most of that to the caller's other outputs.
const SUBMITTED_URLS_OUTPUT_LIMIT = 100_000;

/**
 * @param {import("./run.mjs").Config} config
 * @param {import("./run.mjs").Result} result
 */
function writeSummary(config, result) {
  const file = env("GITHUB_STEP_SUMMARY");
  if (!file) return;

  const lines = [`## IndexNow: ${config.host}${config.dryRun ? " (dry run)" : ""}`, ""];
  if (result.kind === "baseline") {
    lines.push(`No previous state: recorded a baseline of ${result.current.size} URLs without submitting.`);
  } else {
    const responses = result.responses.map((r) => `${r.status}${r.status === 202 ? " (key validation pending)" : ""}`);
    const verb = config.dryRun ? "Would submit" : "Submitted";
    lines.push(
      "| Sitemap URLs | Added | Updated | Removed | " + `${verb} | Response |`,
      "| ---: | ---: | ---: | ---: | ---: | --- |",
      `| ${result.current.size} | ${result.added.length} | ${result.updated.length} | ${result.removed.length} | ` +
        `${result.urls.length} | ${responses.length ? [...new Set(responses)].join(", ") : "-"} |`,
    );
    if (result.kind === "all") lines.push("", `Mode \`all\`: submitted every sitemap URL.`);

    const changes = [
      ...result.added.map((url) => ["added", url]),
      ...result.updated.map((url) => ["updated", url]),
      ...result.removed.map((url) => ["removed", url]),
    ];
    if (changes.length > 0) {
      lines.push("", "| Change | URL |", "| --- | --- |");
      for (const [change, url] of changes.slice(0, SUMMARY_ROW_LIMIT)) {
        lines.push(`| ${change} | ${url.replace(/\|/g, "\\|")} |`);
      }
      if (changes.length > SUMMARY_ROW_LIMIT) lines.push("", `...and ${changes.length - SUMMARY_ROW_LIMIT} more.`);
    }
  }
  if (result.offHost.length > 0) lines.push("", `Skipped ${result.offHost.length} URLs not on ${config.host}.`);
  appendFileSync(file, lines.join("\n") + "\n\n");
}

async function runAction() {
  const config = readConfig();
  const stateFile = env("INDEXNOW_STATE_FILE");
  const previous = stateFile ? await readState(stateFile, config.host, warn) : null;
  if (previous) log(`Restored state with ${previous.size} URLs`);

  const result = await run(config, previous, { log, warn });

  group("Added", result.added);
  group("Updated", result.updated);
  group("Removed", result.removed);
  if (result.kind === "all") group("Submitted (mode: all)", result.urls);

  if (result.kind === "baseline") {
    log(`Recorded a baseline of ${result.current.size} URLs; nothing submitted`);
  } else if (result.urls.length === 0) {
    log("No changed URLs to submit");
  } else if (config.dryRun) {
    log(`Dry run: would submit ${result.urls.length} URLs to ${config.endpoint}`);
  }

  if (result.saveState && stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(serializeState(config.host, result.current), null, 2));
    log(`Wrote new state with ${result.current.size} URLs`);
  } else if (!config.dryRun) {
    log("State unchanged; not saving a new cache entry");
  }

  setOutput("submitted-count", result.urls.length);
  const submitted = joinWithinLimit(result.urls, SUBMITTED_URLS_OUTPUT_LIMIT);
  if (submitted.count < result.urls.length) {
    warn(
      `The submitted-urls output only lists the first ${submitted.count} of ${result.urls.length} URLs ` +
        "to stay within GitHub's output size limit. submitted-count has the full number.",
    );
  }
  setOutput("submitted-urls", submitted.text);
  setOutput("added", result.added.length);
  setOutput("updated", result.updated.length);
  setOutput("removed", result.removed.length);
  setOutput("save-state", String(result.saveState && Boolean(stateFile)));
  writeSummary(config, result);
}

const command = process.argv[2];
const main = command === "prepare" ? async () => prepare() : command === "run" ? runAction : null;
if (!main) {
  console.error("Usage: main.mjs prepare | run");
  process.exit(2);
}
main().catch((error) => {
  console.log(`::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
