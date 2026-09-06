import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPostArchive } from "../../../scripts/post-archive/archive.mjs";
import { prepareArchive, runEtl } from "../scripts/etl.mjs";
import { extractWithCodex, codexArguments, extractionPrompt, invokeCodex } from "../scripts/codex-extract.mjs";
import { readJson, writeJson } from "../scripts/lib/io.mjs";
import { resultFor } from "./fixtures/analysis.mjs";

const modelConfig = { model: "gpt-5.6-luna", version: "test", mode: "codex-exec", model_reasoning_effort: "max", service_tier: "priority" };
async function setup(count = 2) {
  const directory = await mkdtemp(join(tmpdir(), "badminton-codex-test-"));
  const raw = JSON.parse(await readFile(new URL("fixtures/raw.json", import.meta.url), "utf8"));
  if (count !== 2) raw.posts = Array.from({ length: count }, (_, index) => ({
    ...raw.posts[index % raw.posts.length], post_id: String(10000 + index),
    post_url: `https://www.facebook.com/groups/fixture-group/posts/${10000 + index}/`,
  }));
  const old = structuredClone(raw); old.batch.batch_id = "unselected";
  old.posts = [{ ...old.posts[0], post_url: "https://www.facebook.com/groups/fixture-group/posts/unselected/" }];
  const db = join(directory, "posts.sqlite");
  const inputs = await Promise.all([writeJson(join(directory, "raw.json"), raw), writeJson(join(directory, "old.json"), old)]);
  const archive = await openPostArchive(db);
  try { archive.importFiles(inputs); } finally { archive.close(); }
  const run = join(directory, "handoff");
  await prepareArchive(db, run, { modelConfig, batchIds: [raw.batch.batch_id] });
  return { db, run, out: join(directory, "published") };
}
function results(request) {
  const tasks = JSON.parse(request.prompt.split("Tasks (id/context only):\n")[1].split("\n\nErrors from")[0]);
  return tasks.map((task) => resultFor(task, task.context.text.includes("秘密基地") ? "secret" : "line"));
}

test("Codex bridge fixes the requested model/effort/tier and passes paths as arguments", () => {
  const args = codexArguments(modelConfig, "/tmp/with space", "/tmp/schema.json", "/tmp/result.json");
  assert.ok(args.includes("gpt-5.6-luna"));
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(args.includes('service_tier="priority"'));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("/tmp/with space"));
  assert.ok(!args.some((arg) => arg.includes("bypass")));
});

test("Codex extraction retries only invalid tasks, includes corrections, resumes success and publishes selected batches", async () => {
  const options = await setup();
  let calls = 0;
  const invoke = async (request) => {
    calls += 1;
    assert.equal(request.config.model, "gpt-5.6-luna");
    assert.match(request.prompt, /場次拆分/);
    assert.ok(!request.prompt.includes("model_config_version"));
    const output = results(request);
    if (calls === 1) output[0].analysis.listings[0].evidence = [];
    else { assert.equal(output.length, 1); assert.match(request.prompt, /missing field evidence/); }
    return output;
  };
  const report = await extractWithCodex(options, { invoke, onProgress() {} });
  assert.equal(calls, 2); assert.equal(report.succeeded, 2); assert.equal(report.partial, false);
  assert.equal(report.publication.tasks.total, 2);
  const output = await readJson(join(options.out, "current", "output_result.json"));
  assert.equal(output.listings.length, 2);
  await extractWithCodex(options, { invoke() { throw new Error("Successful tasks must not be called again"); }, onProgress() {} });
  const status = await runEtl("status", { db: options.db });
  assert.deepEqual(status.tasks.map((task) => task.attempts).sort(), [1, 2]);
});

test("Codex transport failure is durable and stops subsequent work; validation retries have an upper bound", async () => {
  const transport = await setup();
  const stopped = await extractWithCodex({ ...transport, "batch-size": 1 }, { invoke() { throw new Error("model unavailable"); }, onProgress() {} });
  assert.equal(stopped.phase, "stopped"); assert.equal(stopped.failed, 1); assert.equal(stopped.pending, 1);
  const invalid = await setup();
  let calls = 0;
  const exhausted = await extractWithCodex({ ...invalid, "max-attempts": 2 }, { invoke(request) { calls++; return results(request).map((result) => { result.analysis.listings[0].evidence = []; return result; }); }, onProgress() {} });
  assert.equal(calls, 2); assert.equal(exhausted.failed, 2); assert.equal(exhausted.partial, true);
});

test("model switch preserves completed provenance and extracts remaining work with a 100-post limit", async () => {
  const options = await setup();
  await extractWithCodex({ ...options, limit: 1 }, { invoke: results, onProgress() {} });
  const old = await readJson(join(options.run, "task_manifest.json"));
  const config = { ...modelConfig, model: "gpt-5.6-sol", model_reasoning_effort: "low", version: "sol-low", batch_size: 100 };
  const next = join(options.run, "sol");
  const prepared = await prepareArchive(options.db, next, { modelConfig: config, batchIds: old.selection.batch_ids, preserveSucceeded: true });
  assert.equal(prepared.succeeded, 1);
  assert.equal(prepared.task_count, 1);
  let calls = 0;
  const report = await extractWithCodex({ ...options, run: next, "batch-size": 100 }, { invoke(request) {
    calls++;
    assert.equal(request.config.model, "gpt-5.6-sol");
    assert.equal(request.config.model_reasoning_effort, "low");
    assert.equal(results(request).length, 1);
    return results(request);
  }, onProgress() {} });
  assert.equal(calls, 1);
  assert.equal(report.succeeded, 2);
  assert.equal(report.publication.tasks.total, 2);
  const archive = await openPostArchive(options.db);
  try {
    const models = archive.rows("SELECT contract_json FROM extraction_tasks WHERE status='succeeded'").map(row => JSON.parse(row.contract_json).model_config.model).sort();
    assert.deepEqual(models, ["gpt-5.6-luna", "gpt-5.6-sol"]);
  } finally { archive.close(); }
});

test("a transient batch timeout retries without stopping after the first completed batch", async () => {
  const options = await setup();
  let calls = 0;
  const report = await extractWithCodex({ ...options, "batch-size": 1 }, { invoke(request) {
    calls++;
    if (calls === 2) throw Object.assign(new Error("codex exec timed out"), { code: "CODEX_TIMEOUT" });
    return results(request);
  }, onProgress() {} });
  assert.equal(report.succeeded, 2);
  assert.equal(calls, 3);
  assert.equal(report.phase, "finished");
});


test("prompt sends only id/context source fields and no repeated schema, model config or previous analysis", async () => {
  const options = await setup();
  const { contract } = await readJson(join(options.run, "task_manifest.json"));
  const prompt = extractionPrompt(contract, [{ id: "id1", context: { text: "週六羽球" }, raw: "FORBIDDEN_RAW" }], [{ id: "id1", error: "missing evidence", previous_result: { secret: "FORBIDDEN_PREVIOUS" } }]);
  assert.ok(!prompt.includes("FORBIDDEN_RAW"));
  assert.ok(!prompt.includes("FORBIDDEN_PREVIOUS"));
  assert.ok(!prompt.includes("model_config_version"));
  assert.ok(!prompt.includes('"$defs"'));
  assert.match(prompt, /relative_date_unanchored/);
  assert.match(prompt, /missing evidence/);
  assert.match(prompt, /週六羽球/);
});


test("real CLI timeout is classified as retryable and emits observable events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-timeout-test-"));
  const executable = join(directory, "fake-codex");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(executable, "#!/bin/sh\nprintf '{\"type\":\"turn.started\"}\\n'\nexec sleep 5\n");
  await chmod(executable, 0o755);
  let event;
  await assert.rejects(invokeCodex({ config: modelConfig, directory, schemaPath: join(directory, "schema.json"), outputPath: join(directory, "response.json"), prompt: "test", timeoutMs: 1000, executable, onActivity(value) { event = value; } }), error => error.code === "CODEX_TIMEOUT");
  assert.equal(event.last_event, "turn.started");
  assert.ok(event.last_event_at);
});

test("compact Codex results omit source quotations and publish through existing output format", async () => {
  const options = await setup();
  const report = await extractWithCodex(options, { invoke: async request => {
    const schema = await readJson(request.schemaPath);
    for (const key of ["title", "notes", "confidence", "evidence"]) assert.ok(!(key in schema.$defs.listing.properties));
    assert.ok(!schema.$defs.evidence);
    return results(request).map(result => {
      for (const listing of result.analysis.listings) for (const key of ["title", "notes", "confidence", "evidence"]) delete listing[key];
      return result;
    });
  }, onProgress() {} });
  assert.equal(report.succeeded, 2);
  const output = await readJson(join(options.out, "current", "output_result.json"));
  assert.equal(output.listings.length, 2);
  for (const listing of output.listings) {
    assert.deepEqual(listing.quality.evidence, []);
    assert.deepEqual(listing.notes, []);
    assert.equal(listing.title, null);
  }
  const { validateRun } = await import("../scripts/validate.mjs");
  await validateRun(options.out);
});

test("compact schema preserves fractional skill levels and still rejects inconsistent facts", async () => {
  const { assertAnalysisMatchesSource } = await import("../scripts/lib/validation.mjs");
  const task = { id: "post_00000000000000000000", context: { text: "程度7.5-8.5" } };
  const result = resultFor(task, "secret");
  const listing = result.analysis.listings[0];
  delete listing.evidence;
  listing.skill = { description: "7.5–8.5", min_level: 7.5, max_level: 8.5, beginner_friendly: null };
  assert.doesNotThrow(() => assertAnalysisMatchesSource(result, task.context.text));
  listing.skill.min_level = 9;
  assert.throws(() => assertAnalysisMatchesSource(result, task.context.text), /min_level exceeds max_level/);
});


// Controlled model completions test scheduling without relying on request timing.
function controlledModel() {
  const waiting = [];
  const ready = [];
  let active = 0;
  let peak = 0;
  let calls = 0;
  const invoke = request => new Promise((resolve, reject) => {
    active++; calls++; peak = Math.max(peak, active);
    const call = { request, succeed() { active--; resolve(results(request)); }, fail(error) { active--; reject(error); } };
    if (waiting.length) waiting.shift()(call);
    else ready.push(call);
  });
  return { invoke, next: () => ready.length ? Promise.resolve(ready.shift()) : new Promise(resolve => waiting.push(resolve)),
    get peak() { return peak; }, get calls() { return calls; } };
}

test("bounded concurrency saves out-of-order batches, fills freed slots and publishes only after draining", { timeout: 10000 }, async () => {
  const options = await setup(5);
  const model = controlledModel();
  const updates = [];
  const completion = extractWithCodex({ ...options, concurrency: 2, "batch-size": 1 }, { invoke: model.invoke, onProgress: value => updates.push(value) });
  const first = await model.next();
  const second = await model.next();
  assert.equal(model.calls, 2);
  assert.equal(updates.at(-1).running_batches, 2);
  second.succeed();
  const third = await model.next();
  assert.equal(updates.at(-1).succeeded, 1);
  assert.ok(updates.at(-1).active_batches.some(batch => batch.id === first.request.directory.split("/").at(-1)));
  await assert.rejects(readFile(join(options.out, "current", "output_result.json")), { code: "ENOENT" });
  third.succeed();
  const fourth = await model.next(); fourth.succeed();
  const fifth = await model.next(); fifth.succeed();
  first.succeed();
  const report = await completion;
  assert.equal(model.peak, 2);
  assert.equal(model.calls, 5);
  assert.equal(report.succeeded, 5);
  assert.equal(report.running_batches, 0);
  assert.equal(report.phase, "finished");
  assert.equal(report.publication.tasks.total, 5);
  const status = await runEtl("status", { db: options.db });
  assert.ok(status.tasks.every(task => task.attempts === 1));
  const batch = await readJson(join(first.request.directory, "batch.json"));
  assert.equal(batch.phase, "finished");
  assert.equal(batch.tasks[0].attempt, 1);
  assert.ok(batch.model_elapsed_ms >= 0);
  assert.ok(batch.validation_elapsed_ms >= 0);
  assert.equal((await readJson(join(options.run, "codex_progress.json"))).phase, "finished");
});

test("transport failure stops new dispatch while preserving in-flight success and holding the run lock", { timeout: 10000 }, async () => {
  const options = await setup(4);
  const model = controlledModel();
  let drained;
  const draining = new Promise(resolve => { drained = resolve; });
  const completion = extractWithCodex({ ...options, concurrency: 2, "batch-size": 1 }, {
    invoke: model.invoke, onProgress(value) { if (value.phase === "draining" && value.failed === 1) drained(value); },
  });
  const first = await model.next();
  const second = await model.next();
  first.fail(new Error("model unavailable"));
  const reportDuringDrain = await draining;
  assert.equal(reportDuringDrain.running, 1);
  assert.equal(model.calls, 2);
  await readFile(join(options.run, "codex-extract.lock"));
  await assert.rejects(readFile(join(options.out, "current", "output_result.json")), { code: "ENOENT" });
  second.succeed();
  const report = await completion;
  assert.equal(report.phase, "stopped");
  assert.equal(report.succeeded, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.pending, 2);
  assert.equal(report.running, 0);
  assert.equal(report.partial, true);
  assert.equal(model.calls, 2);
  await assert.rejects(readFile(join(options.run, "codex-extract.lock")), { code: "ENOENT" });
});

test("concurrent retries share the unique-post limit and never repeat successful tasks", async () => {
  const options = await setup(5);
  const attempts = new Map();
  const report = await extractWithCodex({ ...options, concurrency: 3, "batch-size": 1, limit: 2, "max-attempts": 2 }, {
    invoke(request) {
      const output = results(request);
      const id = output[0].id;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (attempts.size === 1 && attempts.get(id) === 1) throw Object.assign(new Error("timeout"), { code: "CODEX_TIMEOUT" });
      return output;
    }, onProgress() {},
  });
  assert.equal(attempts.size, 2);
  assert.deepEqual([...attempts.values()].sort(), [1, 2]);
  assert.equal(report.succeeded, 2);
  assert.equal(report.pending, 3);
  assert.equal(report.running, 0);
  const exhausted = await extractWithCodex({ ...options, concurrency: 2, "batch-size": 1, "max-attempts": 2 }, {
    invoke(request) { return results(request).map(result => ({ ...result, analysis: null })); }, onProgress() {},
  });
  assert.equal(exhausted.succeeded, 2);
  assert.equal(exhausted.failed, 3);
  assert.equal(exhausted.exhausted, 3);
  assert.equal(exhausted.retry_pending, 0);
});

test("SIGTERM stops dispatch and drains outstanding batches before publication", { timeout: 10000 }, async () => {
  const options = await setup(3);
  const model = controlledModel();
  const listenerCount = process.listenerCount("SIGTERM");
  const completion = extractWithCodex({ ...options, concurrency: 2, "batch-size": 1 }, { invoke: model.invoke, onProgress() {} });
  const first = await model.next();
  const second = await model.next();
  process.emit("SIGTERM");
  first.succeed(); second.succeed();
  const report = await completion;
  assert.equal(report.phase, "stopped");
  assert.match(report.error, /SIGTERM/);
  assert.equal(report.succeeded, 2);
  assert.equal(report.pending, 1);
  assert.equal(report.running, 0);
  assert.equal(model.calls, 2);
  assert.equal(process.listenerCount("SIGTERM"), listenerCount);
});

test("invalid concurrency is rejected before creating a run lock", async () => {
  const options = await setup();
  for (const concurrency of [0, -1, 1.5, 9, "invalid"]) {
    await assert.rejects(extractWithCodex({ ...options, concurrency }), /--concurrency must be 1..8/);
  }
  await assert.rejects(readFile(join(options.run, "codex-extract.lock")), { code: "ENOENT" });
});

test("a progress failure drains other workers before rejecting and never publishes", { timeout: 10000 }, async () => {
  const options = await setup(4);
  const model = controlledModel();
  let notifyFailure;
  const failure = new Promise(resolve => { notifyFailure = resolve; });
  let injected = false;
  let settled = false;
  const completion = extractWithCodex({ ...options, concurrency: 2, "batch-size": 1 }, {
    invoke: model.invoke,
    onProgress(value) {
      if (!injected && value.succeeded === 1) {
        injected = true;
        notifyFailure();
        throw new Error("progress sink failed");
      }
    },
  }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  const first = await model.next();
  const second = await model.next();
  first.succeed();
  await failure;
  assert.equal(settled, false);
  await readFile(join(options.run, "codex-extract.lock"));
  second.succeed();
  const { error } = await completion;
  assert.match(error.message, /progress sink failed/);
  assert.equal(model.calls, 2);
  const status = await runEtl("status", { db: options.db });
  assert.equal(status.tasks.filter(task => task.status === "succeeded").length, 2);
  assert.equal(status.tasks.filter(task => task.status === "running").length, 0);
  await assert.rejects(readFile(join(options.out, "current", "output_result.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(options.run, "codex-extract.lock")), { code: "ENOENT" });
});

test("concurrent batches preserve missing, duplicate and unknown result-ID rejection", async () => {
  for (const kind of ["missing", "duplicate", "unknown"]) {
    const options = await setup(4);
    let calls = 0;
    const report = await extractWithCodex({ ...options, concurrency: 2, "batch-size": 2, "max-attempts": 1 }, {
      invoke(request) {
        const output = results(request);
        if (++calls !== 1) return output;
        if (kind === "missing") return output.slice(1);
        if (kind === "duplicate") return [...output, output[0]];
        return [...output, { ...output[0], id: "unknown" }];
      }, onProgress() {},
    });
    assert.equal(calls, 2);
    assert.equal(report.failed, kind === "unknown" ? 2 : 1);
    assert.equal(report.succeeded, kind === "unknown" ? 2 : 3);
    assert.equal(report.running, 0);
    assert.equal(report.partial, true);
    const status = await runEtl("status", { db: options.db });
    assert.ok(status.tasks.filter(task => task.status === "failed").every(task => task.error.toLowerCase().includes(kind)));
  }
});
