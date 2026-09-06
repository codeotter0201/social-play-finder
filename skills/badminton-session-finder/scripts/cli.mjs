#!/usr/bin/env node
import process from "node:process";
import { prepareArchive, runEtl } from "./etl.mjs";
import { extractWithCodex } from "./codex-extract.mjs";
import { readJson } from "./lib/io.mjs";
import { finalizeJoined } from "./finalize.mjs";
import { joinAnalysis } from "./join.mjs";
import { prepareSources } from "./prepare.mjs";
import { queryCsv } from "./query.mjs";
import { evaluateQuality, validateRun } from "./validate.mjs";

function usage() {
  return `Usage:
  npm run badminton -- prepare <raw.json> [more.json ...] --out <result-directory> [--model-config <model.json>]
  npm run badminton -- prepare --db <archive.sqlite> --model-config <model.json> --out <handoff-directory> [--dataset <id> | --batch-ids <id,id,...>] [--post-key <key>] [--preserve-succeeded] [--rerun]
  npm run badminton -- etl extract --db <archive.sqlite> --run <handoff-directory> [--out <publication-directory>] [--batch-size 8] [--max-attempts 3] [--retry-failed] [--limit <posts>]
  npm run badminton -- etl start --db <archive.sqlite> --run <handoff-directory>
  npm run badminton -- etl accept --db <archive.sqlite> --run <handoff-directory> --analysis <results.jsonl>
  npm run badminton -- etl publish --db <archive.sqlite> --out <publication-directory> [--dataset <id> | --run <handoff-directory>] [--refresh]
  npm run badminton -- etl status --db <archive.sqlite>
  npm run badminton -- etl retry --db <archive.sqlite> [--id <task-id> | --failed]
  npm run badminton -- etl recover --db <archive.sqlite> [--id <task-id>]
  npm run badminton -- join --source <source_records.json> --analysis <llm_results.jsonl> --out <joined_records.json> [--allow-partial]
  npm run badminton -- finalize --joined <joined_records.json> --out <result-directory>
  npm run badminton -- query --csv <output_result.csv> --plan <query.json> --out <search_result.csv>
  npm run badminton -- validate --run <result-directory>
  npm run badminton -- quality --samples <reviewed-samples.json> --analysis <results.jsonl> --out <quality-report.json>`;
}

function parseArguments(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["allow-partial", "rerun", "failed", "refresh", "retry-failed", "preserve-succeeded"].includes(key)) {
      options[key] = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = next;
    index += 1;
  }
  return { positional, options };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return;
  }
  const { positional, options } = parseArguments(rest);
  let result;
  if (command === "prepare") {
    if (!options.out || (!positional.length && !options.db)) throw new Error("prepare requires raw JSON inputs or --db, and --out");
    const modelConfig = options["model-config"] ? await readJson(options["model-config"]) : undefined;
    if (options.db && positional.length) throw new Error("Import raw files with archive import, then prepare --db (do not mix input modes)");
    if (options.dataset && !options.db) throw new Error("--dataset requires archive prepare --db");
    result = options.db
      ? await prepareArchive(options.db, options.out, { modelConfig, dataset: options.dataset, postKey: options["post-key"], batchIds: options["batch-ids"]?.split(","), preserveSucceeded: Boolean(options["preserve-succeeded"]), rerun: Boolean(options.rerun) })
      : await prepareSources(positional, options.out, { modelConfig });
  } else if (command === "etl") {
    const action = positional[0];
    if (options.dataset && action !== "publish") throw new Error("Use --dataset in prepare; etl extract inherits the handoff dataset");
    if (!options.db) throw new Error("etl requires --db");
    if (["start", "accept", "extract"].includes(action) && !options.run) throw new Error(`${action} requires --run`);
    if (action === "accept" && !options.analysis) throw new Error("accept requires --analysis");
    if (action === "publish" && !options.out) throw new Error("publish requires --out");
    result = action === "extract" ? await extractWithCodex(options) : await runEtl(action, options);
    if (result.partial) process.exitCode = 2;
  } else if (command === "join") {
    if (!options.source || !options.analysis || !options.out) throw new Error("join requires --source, --analysis, and --out");
    result = await joinAnalysis(options.source, options.analysis, options.out, { allowPartial: Boolean(options["allow-partial"]) });
  } else if (command === "finalize") {
    if (!options.joined || !options.out) throw new Error("finalize requires --joined and --out");
    result = await finalizeJoined(options.joined, options.out);
  } else if (command === "query") {
    if (!options.csv || !options.plan || !options.out) throw new Error("query requires --csv, --plan, and --out");
    result = await queryCsv(options.csv, options.plan, options.out);
  } else if (command === "quality") {
    if (!options.samples || !options.analysis || !options.out) throw new Error("quality requires --samples, --analysis, and --out");
    result = await evaluateQuality(options.samples, options.analysis, options.out);
    if (!result.passed) process.exitCode = 2;
  } else if (command === "validate") {
    if (!options.run) throw new Error("validate requires --run");
    result = await validateRun(options.run);
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
});
