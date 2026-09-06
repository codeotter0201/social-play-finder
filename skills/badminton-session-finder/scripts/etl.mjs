import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openPostArchive } from "../../../scripts/post-archive/archive.mjs";
import { taskStore } from "./task-store.mjs";
import { extractionContract, canRefreshV3Publication } from "./lib/contract.mjs";
import { hashId } from "./lib/ids.mjs";
import { readJson, writeJson, writeJsonl } from "./lib/io.mjs";
import { finalizeJoined } from "./finalize.mjs";
import { readDatasets, getDataset, datasetPostKeys } from "../../../scripts/datasets.mjs";

export async function prepareArchive(databasePath, outputDirectory, { modelConfig, postKey, batchIds, dataset: datasetId, datasetsPath, preserveSucceeded = false, rerun = false } = {}) {
  if (!modelConfig) throw new Error("Archive prepare requires --model-config <json> recording model, version, and settings used for this handoff");
  if (datasetId && batchIds) throw new Error("Use --dataset or --batch-ids, not both");
  const dataset = datasetId ? getDataset(await readDatasets(datasetsPath), datasetId, { requireBatches: true }) : null;
  if (dataset) batchIds = dataset.batch_ids;
  const archive = await openPostArchive(databasePath);
  try {
    const contract = await extractionContract(modelConfig);
    const out = resolve(outputDirectory);
    const oldManifest = await readJson(join(out, "task_manifest.json")).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (oldManifest && JSON.stringify(oldManifest.dataset ?? null) !== JSON.stringify(dataset)) throw new Error("Dataset selection changed; choose a fresh handoff directory");
    if (oldManifest && (rerun || oldManifest.database_path !== archive.databasePath || hashId("contract", [oldManifest.contract]) !== hashId("contract", [contract]))) throw new Error("Existing handoff belongs to a different task/contract; choose a fresh --out directory");
    const tasks = taskStore(archive).prepare(contract, { postKey, batchIds, preserveSucceeded, rerun });
    if (oldManifest && hashId("ids", [oldManifest.task_ids]) !== hashId("ids", [tasks.map((task) => task.task_id)])) throw new Error("New observations change this handoff; choose a fresh --out directory (existing handoff preserved)");
    await mkdir(out, { recursive: true });
    const batches = [...new Map(tasks.map((task) => [task.source.batch.id, task.source.batch])).values()];
    const source = await writeJson(join(out, "source_records.json"), { generated_at: new Date().toISOString(), contract, batches, posts: tasks.map((task) => task.source.post) });
    const pending = tasks.filter((task) => task.status === "pending");
    const taskPath = await writeJsonl(join(out, "llm_tasks.jsonl"), pending.map((task) => ({ id: task.task_id, context: task.source.post.context })));
    const contractPath = await writeJson(join(out, "extraction_contract.json"), contract);
    const manifest = await writeJson(join(out, "task_manifest.json"), {
      version: 2, database_path: archive.databasePath, contract,
      ...(dataset ? { dataset } : {}),
      selection: { batch_ids: batchIds ?? null, post_key: postKey ?? null, preserve_succeeded: preserveSucceeded },
      task_ids: tasks.map((task) => task.task_id), handoff_ids: oldManifest?.handoff_ids ?? pending.map((task) => task.task_id),
    });
    const summary = summarize(tasks);
    const report = await writeJson(join(out, "run_report.json"), { generated_at: new Date().toISOString(), ...summary });
    return { source, tasks: taskPath, contract: contractPath, manifest, report, task_count: pending.length, ...summary };
  } finally { archive.close(); }
}

async function handoff(archive, store, runDirectory) {
  const manifest = await readJson(join(resolve(runDirectory), "task_manifest.json"));
  if (manifest.version !== 2 || manifest.database_path !== archive.databasePath) throw new Error("Handoff manifest belongs to a different database/version; prepare again");
  if (!Array.isArray(manifest.handoff_ids) || new Set(manifest.handoff_ids).size !== manifest.handoff_ids.length) throw new Error("Invalid handoff IDs");
  for (const id of manifest.handoff_ids) {
    if (hashId("contract", [store.get(id).contract]) !== hashId("contract", [manifest.contract])) throw new Error(`Task ${id}: contract mismatch; prepare again`);
  }
  return manifest;
}

export async function runEtl(action, options) {
  const archive = await openPostArchive(options.db);
  try {
    const store = taskStore(archive);
    if (action === "status") return { ...summarize(store.targets()), tasks: store.all().map(publicTask), publications: archive.rows("SELECT publication_id, output_directory, created_at, status FROM extraction_publications ORDER BY created_at DESC") };
    if (action === "retry" || action === "recover") return store.requeue({ id: options.id, failed: Boolean(options.failed), recover: action === "recover" });
    if (action === "start") {
      const manifest = await handoff(archive, store, options.run);
      const started = manifest.handoff_ids.filter((id) => store.get(id).status === "pending");
      store.start(started);
      return { started_ids: started };
    }
    if (action === "accept") {
      const manifest = await handoff(archive, store, options.run);
      const allowed = new Set(manifest.handoff_ids);
      const lines = (await readFile(resolve(options.analysis), "utf8")).split(/\r?\n/);
      const errors = [];
      const records = [];
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try { records.push({ line: index + 1, result: JSON.parse(line) }); }
        catch (error) { errors.push({ line: index + 1, error: `Invalid JSON: ${error.message}` }); }
      }
      const counts = new Map();
      for (const { result } of records) counts.set(result?.id, (counts.get(result?.id) ?? 0) + 1);
      const outcomes = [];
      const seen = new Set();
      for (const { result, line } of records) {
        const id = result?.id;
        if (!allowed.has(id)) { errors.push({ line, id, error: `Unknown analysis ID for this handoff: ${id}` }); continue; }
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const task = store.get(id);
          const currentContract = await extractionContract(task.contract.model_config);
          let rejection = counts.get(id) > 1 ? `Duplicate analysis ID: ${id}` : null;
          if (currentContract.rules_version !== task.rules_version || currentContract.schema_version !== task.schema_version) rejection = `Task ${id}: old contract; prepare again and re-extract with the current contract`;
          outcomes.push(store.accept(result, rejection));
        } catch (error) { errors.push({ line, id, error: error.message }); }
      }
      const tasks = manifest.task_ids.map((id) => store.get(id));
      const summary = summarize(tasks);
      const report = { generated_at: new Date().toISOString(), analysis_file: resolve(options.analysis), ...summary, partial: summary.partial || errors.length > 0, outcomes, errors };
      const reportPath = await writeJson(join(resolve(options.run), "run_report.json"), report);
      return { ...report, report: reportPath };
    }
    if (action === "publish") return await publishArchive(archive, store, options.out, options);
    throw new Error(`Unknown ETL action: ${action}`);
  } finally { archive.close(); }
}

async function publishArchive(archive, store, outputDirectory, { beforeActivate, refresh = false, run: runDirectory, dataset: datasetId, datasetsPath } = {}) {
  if (datasetId && runDirectory) throw new Error("Use --dataset for the whole dataset or --run for a frozen handoff, not both");
  const manifest = runDirectory ? await handoff(archive, store, runDirectory) : null;
  const dataset = datasetId ? getDataset(await readDatasets(datasetsPath), datasetId, { requireBatches: true }) : manifest?.dataset ?? null;
  const out = resolve(outputDirectory);
  let previous = null;
  let previousRelease = null;
  try {
    previousRelease = await realpath(join(out, "current"));
    previous = await readJson(join(previousRelease, "output_result.json"));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous) {
    if (previous.dataset && previous.dataset.id !== dataset?.id) throw new Error("Publication directory belongs to a different dataset; select its dataset or use a separate directory");
    const record = archive.rows("SELECT * FROM extraction_publications WHERE publication_id=$id AND output_directory=$out", { $id: previous.publication_id, $out: out })[0];
    if (!record) throw new Error("Current publication is not registered in this archive; choose a fresh output directory");
    // Reconcile interruption between pointer activation and the publication status write.
    archive.transaction(({ run }) => run("UPDATE extraction_publications SET status='published' WHERE publication_id=$id", { $id: previous.publication_id }));
  }
  const previousPosts = new Map((previous?.source_posts ?? []).map((post) => [post.origin.post_key, post]));
  const previousBatches = new Map((previous?.source_batches ?? []).map((batch) => [batch.id, { id: batch.id, source_file: batch.source_file, raw: batch.batch }]));
  const targets = new Map(store.targets().map((task) => [task.post_key, task]));
  const posts = [];
  const batches = new Map();
  const states = [];
  const selectedKeys = manifest ? new Set(manifest.task_ids.map((id) => store.get(id).post_key)) : dataset ? datasetPostKeys(archive, dataset) : null;
  for (const observation of archive.latestAll()) {
    if (selectedKeys && !selectedKeys.has(observation.post_key)) continue;
    const task = targets.get(observation.post_key);
    const ready = task?.observation_id === observation.observation_id && task.status === "succeeded";
    let post = null;
    if (ready) {
      const current = await extractionContract(task.contract.model_config);
      if ((current.rules_version !== task.rules_version || current.schema_version !== task.schema_version) && !(refresh && canRefreshV3Publication(task, previousPosts.get(observation.post_key), current))) throw new Error(`Task ${task.task_id} uses an old contract; prepare and re-extract before publication`);
      post = { ...task.source.post, analysis: task.analysis, extraction: { context_hash: task.context_hash, rules_version: task.rules_version, schema_version: task.schema_version, model_config_version: task.model_config_version, reused_from: task.reused_from } };
      batches.set(task.source.batch.id, task.source.batch);
    } else if (previousPosts.has(observation.post_key)) {
      post = previousPosts.get(observation.post_key);
      batches.set(post.batch_id, previousBatches.get(post.batch_id));
    }
    if (post) posts.push({ ...post, publication: { latest_observation_id: observation.observation_id, target_task_id: task?.task_id ?? null, stale: !ready } });
    states.push({ post_key: observation.post_key, latest_observation_id: observation.observation_id,
      task_id: task?.observation_id === observation.observation_id ? task.task_id : null,
      status: task?.observation_id === observation.observation_id ? task.status : "pending",
      error: task?.observation_id === observation.observation_id ? task.error : "Latest observation needs prepare",
      reused: ready && Boolean(task.reused_from), needs_review: ready && Boolean(task.needs_review),
      published: Boolean(post), stale: Boolean(post) && !ready,
    });
  }
  const count = (predicate) => states.filter(predicate).length;
  const taskReport = {
    unit: "source_posts (one latest target per post_key); listing counts are in stats.listings",
    total: states.length, pending: count((state) => state.status === "pending"), running: count((state) => state.status === "running"),
    succeeded: count((state) => state.status === "succeeded"), failed: count((state) => state.status === "failed"),
    reused: count((state) => state.reused), needs_review: count((state) => state.needs_review),
    published: count((state) => state.published), stale: count((state) => state.stale),
    incomplete_ids: states.filter((state) => state.status !== "succeeded").map((state) => state.task_id ?? state.post_key),
    failed_ids: states.filter((state) => state.status === "failed").map((state) => state.task_id), states,
  };
  const joined = { ...(dataset ? { dataset } : {}), batches: [...batches.values()], posts, task_report: taskReport, join_report: { partial: taskReport.incomplete_ids.length > 0, missing_ids: taskReport.incomplete_ids } };
  if (previousRelease) {
    const oldJoined = await readJson(join(previousRelease, "joined_records.json"));
    if (!refresh && hashId("publication", [oldJoined]) === hashId("publication", [joined])) return { current: join(out, "current"), page: join(previousRelease, "index.html"), publication_id: previous.publication_id, reused_publication: true, partial: joined.join_report.partial, tasks: taskReport };
  }
  const publicationId = randomUUID();
  const staging = join(out, "releases", publicationId);
  await mkdir(staging, { recursive: true });
  const joinedPath = await writeJson(join(staging, "joined_records.json"), joined);
  const result = await finalizeJoined(joinedPath, out, { publicationId, beforeActivate: async (documents) => {
    archive.transaction(({ run }) => run("INSERT INTO extraction_publications(publication_id,output_directory,created_at,status,selection_json) VALUES($id,$out,$now,'prepared',$selection)", {
      $id: publicationId, $out: out, $now: documents.result.generated_at,
      $selection: JSON.stringify(posts.map((post) => ({ post_key: post.origin.post_key, observation_id: post.origin.observation_id, task_id: post.id, latest_observation_id: post.publication.latest_observation_id, stale: post.publication.stale }))),
    }));
    if (beforeActivate) await beforeActivate(documents);
  } });
  archive.transaction(({ run }) => run("UPDATE extraction_publications SET status='published' WHERE publication_id=$id", { $id: publicationId }));
  return { ...result, partial: joined.join_report.partial, tasks: taskReport };
}

function publicTask(task) {
  return Object.fromEntries(["task_id", "post_key", "observation_id", "context_hash", "rules_version", "schema_version", "model_config_version", "status", "attempts", "started_at", "finished_at", "error", "needs_review", "reused_from"].map((key) => [key, task[key]]));
}
function summarize(tasks) {
  const count = (status) => tasks.filter((task) => task.status === status).length;
  return { unit: "tasks", total: tasks.length, pending: count("pending"), running: count("running"), succeeded: count("succeeded"), failed: count("failed"),
    reused: tasks.filter((task) => task.reused_from).length, needs_review: tasks.filter((task) => task.needs_review).length,
    incomplete_ids: tasks.filter((task) => task.status !== "succeeded").map((task) => task.task_id),
    failed_ids: tasks.filter((task) => task.status === "failed").map((task) => task.task_id), partial: tasks.some((task) => task.status !== "succeeded"),
  };
}
