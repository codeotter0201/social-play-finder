import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { openPostArchive } from "../../../scripts/post-archive/archive.mjs";
import { taskStore } from "./task-store.mjs";
import { extractionContract } from "./lib/contract.mjs";
import { hashId } from "./lib/ids.mjs";
import { readJson, writeJson, writeJsonl } from "./lib/io.mjs";
import { runEtl } from "./etl.mjs";

export function codexArguments(config, directory, schemaPath, outputPath) {
  if (config.mode !== "codex-exec" || !config.model || !config.model_reasoning_effort || !config.service_tier) throw new Error("Prepare with a codex-exec model configuration including model_reasoning_effort and service_tier");
  return ["-a", "never", "exec", "--ignore-user-config", "--ephemeral", "-s", "read-only", "--skip-git-repo-check", "-C", directory,
    "-m", config.model, "-c", `model_reasoning_effort=${JSON.stringify(config.model_reasoning_effort)}`,
    "-c", `service_tier=${JSON.stringify(config.service_tier)}`, "--output-schema", schemaPath, "-o", outputPath, "--json", "-"];
}

// Provider response formatting omits conditional keywords unsupported by strict
// output mode. The original, unchanged schema and semantic validator still gate
// each result in taskStore.accept.
export function batchResponseSchema(contract) {
  const original = JSON.parse(contract.files["extraction.schema.json"]);
  const defs = structuredClone(original.$defs);
  delete defs.analysis.allOf;
  for (const key of ["title", "notes", "confidence", "evidence"]) delete defs.listing.properties[key];
  defs.listing.required = Object.keys(defs.listing.properties);
  delete defs.evidence;
  function explicitTypes(schema) {
    if (!schema || typeof schema !== "object") return;
    if (!schema.type && Object.hasOwn(schema, "const")) schema.type = typeof schema.const;
    if (!schema.type && schema.enum) schema.type = [...new Set(schema.enum.map((value) => value === null ? "null" : typeof value))];
    delete schema.uniqueItems;
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(explicitTypes);
      else explicitTypes(value);
    }
  }
  explicitTypes(defs);
  defs.result = { type: "object", additionalProperties: false, required: original.required, properties: original.properties };
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: { type: "array", items: { $ref: "#/$defs/result" } } }, $defs: defs };
}

export function extractionPrompt(contract, tasks, corrections = []) {
  const input = tasks.map(({ id, context }) => ({ id, context }));
  const errors = corrections.map(({ id, error }) => ({ id, error }));
  return `${contract.files["extraction-mode.md"]}

Tasks (id/context only):
${JSON.stringify(input)}

Errors from the previous attempt:
${JSON.stringify(errors)}

Return {"results":[{"id":"the supplied ID","analysis":{...}}]} only.`;
}

export async function invokeCodex({ config, directory, schemaPath, outputPath, prompt, timeoutMs = 600_000, executable = "codex", onActivity = () => {} }) {
  const args = codexArguments(config, directory, schemaPath, outputPath);
  const events = createWriteStream(join(directory, "events.jsonl"));
  const stderr = createWriteStream(join(directory, "stderr.log"));
  await writeJson(join(directory, "invocation.json"), { executable, args, started_at: new Date().toISOString(), timeout_ms: timeoutMs, prompt_bytes: Buffer.byteLength(prompt), prompt_protocol: "id-context-semantic-rules-2" });
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  const hardTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5000);
  let eventBuffer = "";
  child.stdout.on("data", (chunk) => {
    eventBuffer += chunk.toString();
    let newline;
    while ((newline = eventBuffer.indexOf("\n")) !== -1) {
      const line = eventBuffer.slice(0, newline); eventBuffer = eventBuffer.slice(newline + 1);
      try { const event = JSON.parse(line); onActivity({ last_event: event.type, last_event_at: new Date().toISOString() }); } catch {}
    }
  });
  child.stdout.pipe(events); child.stderr.pipe(stderr);
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (code !== 0 || timedOut) {
      const lines = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n");
      let detail = "";
      for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "turn.failed" || event.type === "error") detail = event.error?.message ?? event.message ?? ""; } catch {} }
      const error = new Error(`codex exec ${timedOut ? "timed out" : `exited ${code}`}: ${detail}; inspect ${join(directory, "events.jsonl")} and stderr.log`);
      if (timedOut) error.code = "CODEX_TIMEOUT";
      throw error;
    }
    const value = JSON.parse(await readFile(outputPath, "utf8"));
    if (!Array.isArray(value.results)) throw new Error("Codex response must contain results[]");
    return value.results;
  } finally { clearTimeout(timer); clearTimeout(hardTimer); events.end(); stderr.end(); }
}

export async function extractWithCodex(options, { invoke = invokeCodex, onProgress = (value) => console.log(JSON.stringify(value)) } = {}) {
  const run = resolve(options.run);
  const manifest = await readJson(join(run, "task_manifest.json"));
  const db = resolve(options.db);
  if (manifest.database_path !== db || manifest.version !== 2) throw new Error("Handoff database/version mismatch");
  const contract = manifest.contract;
  const current = await extractionContract(contract.model_config);
  if (hashId("contract", [current]) !== hashId("contract", [contract])) throw new Error("Contract changed; prepare a fresh handoff before extraction");
  codexArguments(contract.model_config, run, "schema", "output");
  const batchSize = Number(options["batch-size"] ?? contract.model_config.batch_size ?? 8);
  const maxAttempts = Number(options["max-attempts"] ?? 3);
  const limit = Number(options.limit ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("--batch-size must be 1..100");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error("--max-attempts must be 1..5");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const lockPath = join(run, "codex-extract.lock");
  const lock = await open(lockPath, "wx").catch((error) => { throw new Error(`Extraction is locked: ${lockPath}; confirm the recorded process has ended before removing a stale lock`, { cause: error }); });
  await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const touched = new Set();
  const retryEligible = new Set();
  let batches = 0;
  let stoppedError = null;
  let activity = {};
  let batchStarted = null;
  const withStore = async (callback) => {
    const archive = await openPostArchive(db);
    try { return callback(taskStore(archive), archive); } finally { archive.close(); }
  };
  const snapshot = () => withStore((store) => manifest.task_ids.map((id) => store.get(id)));
  const progress = async (phase) => {
    const tasks = await snapshot();
    const counts = Object.fromEntries(["pending", "running", "succeeded", "failed"].map((status) => [status, tasks.filter((task) => task.status === status).length]));
    const value = { updated_at: new Date().toISOString(), phase, model: contract.model_config.model,
      reasoning: contract.model_config.model_reasoning_effort, service_tier: contract.model_config.service_tier,
      total: tasks.length, ...counts, batches, batch_size: batchSize, batch_started_at: batchStarted, batch_elapsed_seconds: batchStarted ? Math.floor((Date.now() - Date.parse(batchStarted)) / 1000) : null, ...activity, error: stoppedError, partial: tasks.some((task) => task.status !== "succeeded") };
    await writeJson(join(run, "codex_progress.json"), value); onProgress(value); return value;
  };
  try {
    const initial = await snapshot();
    for (const task of initial) {
      const preserved = manifest.selection?.preserve_succeeded && task.status === "succeeded" && task.rules_version === contract.rules_version && task.schema_version === contract.schema_version;
      if (!preserved && hashId("contract", [task.contract]) !== hashId("contract", [contract])) throw new Error(`Task ${task.task_id} contract differs from handoff`);
      if (options["retry-failed"] && task.status === "failed") retryEligible.add(task.task_id);
    }
    if (initial.some((task) => task.status === "running")) throw new Error("Unfinished running tasks remain; explicitly etl recover before resuming");
    await progress("started");
    for (;;) {
      const tasks = await snapshot();
      const candidates = tasks.filter((task) => (task.status === "pending" || (task.status === "failed" && retryEligible.has(task.task_id))) && task.attempts < maxAttempts && (touched.has(task.task_id) || touched.size < limit));
      const batch = [];
      for (const task of candidates) {
        if (batch.length >= batchSize) break;
        if (!touched.has(task.task_id) && touched.size >= limit) continue;
        touched.add(task.task_id); batch.push(task);
      }
      if (!batch.length) break;
      const corrections = await withStore((store, archive) => {
        const corrections = [];
        for (const task of batch) {
          if (task.status === "failed") {
            const previous = archive.rows("SELECT result_json,error FROM extraction_attempts WHERE task_id=$id ORDER BY attempt DESC LIMIT 1", { $id: task.task_id })[0];
            corrections.push({ id: task.task_id, error: previous?.error, previous_result: previous?.result_json ? JSON.parse(previous.result_json) : null });
            store.requeue({ id: task.task_id });
          }
        }
        store.start(batch.map((task) => task.task_id));
        return corrections;
      });
      const directory = join(run, "codex", `${String(++batches).padStart(4, "0")}-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      const schemaPath = await writeJson(join(directory, "response.schema.json"), batchResponseSchema(contract));
      const outputPath = join(directory, "response.json");
      const taskInput = batch.map((task) => ({ id: task.task_id, context: task.source.post.context }));
      await writeJson(join(directory, "tasks.json"), taskInput);
      batchStarted = new Date().toISOString();
      activity = { last_event: null, last_event_at: null };
      await progress("extracting");
      let pulse = null;
      let pulseError = null;
      const heartbeat = setInterval(() => {
        if (!pulse) pulse = progress("extracting").catch(error => { pulseError = error; }).finally(() => { pulse = null; });
      }, 15_000);
      let results;
      try { results = await invoke({ config: contract.model_config, directory, schemaPath, outputPath, prompt: extractionPrompt(contract, taskInput, corrections), onActivity: (event) => { activity = event; } }); }
      catch (error) {
        clearInterval(heartbeat);
        if (pulse) await pulse;
        await withStore((store) => { for (const task of batch) store.accept({ id: task.task_id, analysis: null }, error.message); });
        if (error.code === "CODEX_TIMEOUT") {
          for (const task of batch) retryEligible.add(task.task_id);
          // A bounded task retry, not an authentication/configuration failure.
          continue;
        }
        stoppedError = error.message;
        break;
      } finally {
        clearInterval(heartbeat);
        if (pulse) await pulse;
      }
      if (pulseError) throw pulseError;
      await writeJsonl(join(directory, "results.jsonl"), results);
      const knownIds = new Set(batch.map((task) => task.task_id));
      const unknown = results.filter((result) => !knownIds.has(result?.id));
      const outcomes = await withStore((store) => batch.map((task) => {
        const found = results.filter((result) => result?.id === task.task_id);
        const rejection = unknown.length ? "Unknown result IDs in Codex batch" : found.length !== 1 ? `${found.length ? "Duplicate" : "Missing"} analysis ID: ${task.task_id}` : null;
        const outcome = store.accept(found[0] ?? { id: task.task_id, analysis: null }, rejection);
        if (outcome.status === "failed") retryEligible.add(task.task_id);
        return outcome;
      }));
      await writeJson(join(directory, "validation.json"), { outcomes, unknown_ids: unknown.map((item) => item?.id) });
      await progress("validated");
    }
    const final = await progress(stoppedError ? "stopped" : "finished");
    if (options.out) final.publication = await runEtl("publish", { db, run, out: options.out });
    await writeJson(join(run, "codex_progress.json"), final);
    return final;
  } finally { await lock.close(); await unlink(lockPath); }
}
