import { randomUUID } from "node:crypto";
import { hashId } from "./lib/ids.mjs";
import { assertAnalysisMatchesSource, qualityWarnings } from "./lib/validation.mjs";
import { sourceFromObservation } from "./prepare.mjs";

// Uses the archive connection and its atomic persistence; no second database.
export function taskStore(archive) {
  archive.transaction(({ run }) => run(`
    CREATE TABLE IF NOT EXISTS extraction_tasks (
      task_id TEXT PRIMARY KEY,
      post_key TEXT NOT NULL,
      observation_id INTEGER NOT NULL REFERENCES post_observations(observation_id),
      context_hash TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      model_config_version TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      source_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      analysis_json TEXT,
      error TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0,
      reused_from TEXT REFERENCES extraction_tasks(task_id)
    );
    CREATE INDEX IF NOT EXISTS extraction_reuse ON extraction_tasks(post_key, context_hash, rules_version, schema_version, model_config_version, status);
    CREATE TABLE IF NOT EXISTS extraction_attempts (
      task_id TEXT NOT NULL REFERENCES extraction_tasks(task_id),
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      error TEXT,
      PRIMARY KEY(task_id, attempt)
    );
    CREATE TABLE IF NOT EXISTS extraction_targets (
      post_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES extraction_tasks(task_id)
    );
    CREATE TABLE IF NOT EXISTS extraction_publications (
      publication_id TEXT PRIMARY KEY,
      output_directory TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','published')),
      selection_json TEXT NOT NULL
    );
  `));
  const get = (id) => {
    const row = archive.rows("SELECT * FROM extraction_tasks WHERE task_id=$id", { $id: id })[0];
    if (!row) throw new Error(`Unknown task ID: ${id}`);
    return decode(row);
  };
  function start(ids) {
    const tasks = (Array.isArray(ids) ? ids : [ids]).map(get);
    for (const task of tasks) if (task.status !== "pending") throw new Error(`Task ${task.task_id} is ${task.status}; explicitly retry failed tasks or recover running tasks`);
    const now = new Date().toISOString();
    archive.transaction(({ run }) => {
      for (const task of tasks) {
        run("UPDATE extraction_tasks SET status='running', attempts=attempts+1, started_at=$now, finished_at=NULL, error=NULL WHERE task_id=$id", { $id: task.task_id, $now: now });
        run("INSERT INTO extraction_attempts(task_id,attempt,started_at) VALUES($id,$attempt,$now)", { $id: task.task_id, $attempt: task.attempts + 1, $now: now });
      }
    });
  }
  function accept(result, rejection = null) {
    let task = get(result.id);
    if (task.status === "succeeded") {
      if (rejection) throw new Error(rejection);
      // A repeat handoff is idempotent only when it contains the same analysis.
      if (hashId("analysis", [task.analysis]) !== hashId("analysis", [result.analysis])) throw new Error(`Task ${result.id} already succeeded; use prepare --post-key ... --rerun for a new task`);
      return { id: task.task_id, status: "succeeded", already_succeeded: true };
    }
    if (task.status === "failed") throw new Error(`Task ${result.id} failed; use etl retry --id ${result.id} before accepting corrected results`);
    if (task.status === "pending") start(result.id);
    task = get(result.id);
    let error = null;
    try { if (rejection) throw new Error(rejection); assertAnalysisMatchesSource(result, task.source.post.context.text); }
    catch (cause) { error = cause.message; }
    const now = new Date().toISOString();
    const review = !error && qualityWarnings({ ...task.source.post, analysis: result.analysis }).some((code) => code !== "not_recruitment");
    archive.transaction(({ run }) => {
      run(`UPDATE extraction_tasks SET status=$status, finished_at=$now, analysis_json=$analysis,
        error=$error, needs_review=$review WHERE task_id=$id`, {
        $id: task.task_id, $status: error ? "failed" : "succeeded", $now: now,
        $analysis: error ? null : JSON.stringify(result.analysis), $error: error, $review: review ? 1 : 0,
      });
      run("UPDATE extraction_attempts SET finished_at=$now, result_json=$result, error=$error WHERE task_id=$id AND attempt=$attempt", {
        $id: task.task_id, $attempt: task.attempts, $now: now, $result: JSON.stringify(result), $error: error,
      });
    });
    return { id: task.task_id, status: error ? "failed" : "succeeded", error };
  }
  return {
    get, start, accept,
    all() { return archive.rows("SELECT * FROM extraction_tasks ORDER BY created_at, rowid").map(decode); },
    targets() {
      return archive.rows("SELECT task.* FROM extraction_targets target JOIN extraction_tasks task USING(task_id)").map(decode);
    },
    prepare(contract, { postKey, batchIds, preserveSucceeded = false, rerun = false } = {}) {
      let selectedKeys;
      if (batchIds?.length) {
        selectedKeys = new Set();
        for (const batchId of batchIds) {
          const found = archive.rows("SELECT DISTINCT post_key FROM post_observations WHERE batch_id=$batch", { $batch: batchId });
          if (!found.length) throw new Error(`Unknown or empty batch: ${batchId}`);
          for (const row of found) selectedKeys.add(row.post_key);
        }
      }
      const observations = archive.latestAll().filter((observation) => (!postKey || observation.post_key === postKey) && (!selectedKeys || selectedKeys.has(observation.post_key)));
      if (postKey && !observations.length) throw new Error(`Unknown post key: ${postKey}`);
      if (rerun && !postKey) throw new Error("--rerun requires --post-key to preserve successful unrelated work");
      return archive.transaction(({ run }) => {
        const tasks = [];
        for (const observation of observations) {
          const source = sourceFromObservation(archive, observation, "post_00000000000000000000");
          const contextHash = hashId("context", [source.post.context]);
          const versions = [contract.rules_version, contract.schema_version, contract.model_config_version];
          const baseId = hashId("post", [observation.post_key, observation.observation_id, contextHash, ...versions]);
          const current = archive.rows("SELECT task.* FROM extraction_targets target JOIN extraction_tasks task USING(task_id) WHERE target.post_key=$key", { $key: observation.post_key })[0];
          if (preserveSucceeded && !rerun && current?.status === "succeeded" && current.observation_id === observation.observation_id && current.context_hash === contextHash && current.rules_version === contract.rules_version && current.schema_version === contract.schema_version) {
            tasks.push(get(current.task_id));
            continue; // Keep the original model provenance; never relabel a completed extraction.
          }
          // Preserve an explicitly rerun target on subsequent prepare invocations.
          const matching = current && current.observation_id === observation.observation_id && current.context_hash === contextHash && versions.every((version, index) => version === current[["rules_version", "schema_version", "model_config_version"][index]]);
          const id = rerun ? hashId("post", [baseId, randomUUID()]) : matching ? current.task_id : baseId;
          source.post.id = id;
          if (!archive.rows("SELECT task_id FROM extraction_tasks WHERE task_id=$id", { $id: id }).length) {
            const previous = !rerun && archive.rows(`SELECT * FROM extraction_tasks WHERE post_key=$key AND context_hash=$hash
              AND rules_version=$rules AND schema_version=$schema AND model_config_version=$model AND status='succeeded'
              ORDER BY finished_at DESC, rowid DESC LIMIT 1`, {
              $key: observation.post_key, $hash: contextHash, $rules: versions[0], $schema: versions[1], $model: versions[2],
            })[0];
            let analysis = previous ? JSON.parse(previous.analysis_json) : null;
            let reuseError = null;
            if (analysis) {
              // Revalidate the reusable analysis against this observation; never copy a listing.
              try { assertAnalysisMatchesSource({ id, analysis }, source.post.context.text); }
              catch (error) { analysis = null; reuseError = `Reuse requires re-extraction: ${error.message}`; }
            }
            run(`INSERT INTO extraction_tasks(task_id,post_key,observation_id,context_hash,
              rules_version,schema_version,model_config_version,contract_json,source_json,status,created_at,finished_at,analysis_json,needs_review,reused_from,error)
              VALUES($id,$key,$observation,$hash,$rules,$schema,$model,$contract,$source,$status,$now,$finished,$analysis,$review,$reused,$error)`, {
              $id: id, $key: observation.post_key, $observation: observation.observation_id, $hash: contextHash,
              $rules: versions[0], $schema: versions[1], $model: versions[2], $contract: JSON.stringify(contract), $source: JSON.stringify(source),
              $status: analysis ? "succeeded" : "pending", $now: new Date().toISOString(), $finished: analysis ? new Date().toISOString() : null,
              $analysis: analysis ? JSON.stringify(analysis) : null,
              $review: analysis && qualityWarnings({ ...source.post, analysis }).some((code) => code !== "not_recruitment") ? 1 : 0,
              $reused: analysis ? previous.task_id : null, $error: reuseError,
            });
          }
          run("INSERT INTO extraction_targets(post_key,task_id) VALUES($key,$id) ON CONFLICT(post_key) DO UPDATE SET task_id=excluded.task_id", { $key: observation.post_key, $id: id });
          tasks.push(get(id));
        }
        return tasks;
      });
    },
    requeue({ id, failed = false, recover = false }) {
      if (!id && !failed && !recover) throw new Error("Select --id, --failed, or recover");
      const selected = id ? [get(id)] : this.all().filter((task) => task.status === (recover ? "running" : "failed"));
      const expected = recover ? "running" : "failed";
      if (selected.some((task) => task.status !== expected)) throw new Error(`Only ${expected} tasks can be ${recover ? "recovered" : "retried"}; successful tasks remain immutable`);
      archive.transaction(({ run }) => {
        for (const task of selected) {
          if (recover) run("UPDATE extraction_attempts SET finished_at=$now,error=$error WHERE task_id=$id AND attempt=$attempt", {
            $now: new Date().toISOString(), $error: "Interrupted attempt explicitly recovered", $id: task.task_id, $attempt: task.attempts,
          });
          run("UPDATE extraction_tasks SET status='pending', started_at=NULL, finished_at=NULL, error=NULL WHERE task_id=$id", { $id: task.task_id });
        }
      });
      return { requeued_ids: selected.map((task) => task.task_id) };
    },
  };
}

function decode(row) {
  return { ...row, contract: JSON.parse(row.contract_json), source: JSON.parse(row.source_json), analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null };
}
