import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createBatchId, createPostId, stableStringify } from "./lib/ids.mjs";
import { readJson, writeJson, writeJsonl } from "./lib/io.mjs";
import { buildLinkInventory, maskInlineUrls } from "./lib/links.mjs";
import { normalizeTimestamp } from "../../../scripts/post-archive/archive.mjs";
import { extractionContract } from "./lib/contract.mjs";
import { assertTaskShape } from "./lib/validation.mjs";

function assertRawExport(input, inputPath) {
  if (!input || typeof input !== "object" || !input.batch || !Array.isArray(input.posts)) {
    throw new Error(`${inputPath} must contain batch and posts[]`);
  }
}

export async function prepareSources(inputPaths, outputDirectory, { modelConfig } = {}) {
  if (!inputPaths.length) throw new Error("At least one raw JSON input is required");
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const batches = [];
  const posts = [];
  const tasks = [];
  const seenBatchIds = new Map();
  const seenPostIds = new Map();

  for (const inputArgument of inputPaths) {
    const sourceFile = resolve(inputArgument);
    const input = await readJson(sourceFile);
    assertRawExport(input, sourceFile);
    const batchId = createBatchId(input.batch);
    const previousBatch = seenBatchIds.get(batchId);
    if (previousBatch && stableStringify(previousBatch.raw) !== stableStringify(input.batch)) throw new Error(`Batch ID collision: ${batchId}`);
    if (previousBatch) throw new Error(`Duplicate raw batch input: ${sourceFile}`);
    const batchRecord = { id: batchId, source_file: sourceFile, raw: input.batch };
    seenBatchIds.set(batchId, batchRecord);
    batches.push(batchRecord);

    for (const [sourcePostIndex, rawPost] of input.posts.entries()) {
      const postId = createPostId(batchId, sourcePostIndex, rawPost);
      if (seenPostIds.has(postId)) throw new Error(`Post ID collision: ${postId}`);
      const postRecord = buildSourceRecord({ id: postId, batchId, sourceFile, sourcePostIndex, batch: input.batch, rawPost });
      const { context } = postRecord;
      const task = { id: postId, context };
      assertTaskShape(task);
      seenPostIds.set(postId, postRecord);
      posts.push(postRecord);
      tasks.push(task);
    }
  }

  const contract = await extractionContract(modelConfig);
  const contractPath = await writeJson(join(out, "extraction_contract.json"), contract);
  const sourcePath = await writeJson(join(out, "source_records.json"), {
    generated_at: new Date().toISOString(),
    contract,
    batches,
    posts,
  });
  const tasksPath = await writeJsonl(join(out, "llm_tasks.jsonl"), tasks);
  return { source: sourcePath, tasks: tasksPath, contract: contractPath, batch_count: batches.length, task_count: tasks.length };
}

export function buildSourceRecord({ id, batchId, sourceFile, sourcePostIndex, batch, rawPost, observation }) {
  const links = buildLinkInventory(batch, rawPost);
  const publishedAt = normalizeTimestamp(rawPost?.published_at);
  const scrapedAt = normalizeTimestamp(rawPost?.scraped_at);
  const finishedAt = normalizeTimestamp(batch?.finished_at);
  const context = {
    text: maskInlineUrls(rawPost?.content_text ?? "", links.inline.map(({ raw_url }) => raw_url)),
    reference_time: publishedAt ?? scrapedAt ?? finishedAt,
    reference_time_source: publishedAt ? "published_at" : scrapedAt ? "scraped_at" : finishedAt ? "batch_finished_at" : "unavailable",
    published_at: publishedAt,
    scraped_at: scrapedAt,
    timezone: "Asia/Taipei",
    is_truncated: rawPost?.content_is_truncated ?? null,
  };
  const record = { id, batch_id: batchId, source_file: sourceFile, source_post_index: sourcePostIndex, raw: rawPost, links, context };
  if (observation) record.origin = {
    post_key: observation.post_key, observation_id: observation.observation_id,
    key_kind: observation.key_kind, written_at: observation.written_at,
    warnings: observation.quality_warnings,
  };
  assertTaskShape({ id, context });
  return record;
}

export function sourceFromObservation(archive, observation, id) {
  const batch = archive.batch(observation.import_id);
  const batchId = createBatchId(batch.raw);
  return {
    batch: { id: batchId, ...batch },
    post: buildSourceRecord({ id, batchId, sourceFile: batch.source_file, sourcePostIndex: archive.observationIndex(observation.observation_id), batch: batch.raw, rawPost: observation.post, observation }),
  };
}
