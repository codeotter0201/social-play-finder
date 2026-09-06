import { resolve } from "node:path";
import { readJson, readRecords, writeJson } from "./lib/io.mjs";
import { assertAnalysisMatchesSource, assertExtractionResult } from "./lib/validation.mjs";

export async function joinAnalysis(sourcePath, analysisPath, outputPath, { allowPartial = false } = {}) {
  const [source, results] = await Promise.all([readJson(sourcePath), readRecords(analysisPath)]);
  if (!Array.isArray(source?.batches) || !Array.isArray(source?.posts)) throw new Error("source_records.json must contain batches[] and posts[]");
  const sourceById = new Map(source.posts.map((post) => [post.id, post]));
  if (sourceById.size !== source.posts.length) throw new Error("source_records.json contains duplicate post IDs");
  const resultById = new Map();

  for (const result of results) {
    assertExtractionResult(result);
    if (!sourceById.has(result.id)) throw new Error(`Unknown analysis ID: ${result.id}`);
    if (resultById.has(result.id)) throw new Error(`Duplicate analysis ID: ${result.id}`);
    assertAnalysisMatchesSource(result, sourceById.get(result.id).context.text);
    resultById.set(result.id, result.analysis);
  }

  const missingIds = source.posts.filter(({ id }) => !resultById.has(id)).map(({ id }) => id);
  if (missingIds.length && !allowPartial) throw new Error(`Missing analysis IDs: ${missingIds.join(", ")}`);
  const joined = {
    generated_at: new Date().toISOString(),
    contract: source.contract ?? null,
    batches: source.batches,
    posts: source.posts.map((post) => ({ ...post, analysis: resultById.get(post.id) ?? null })),
    join_report: {
      source_posts: source.posts.length,
      received_results: results.length,
      joined_results: resultById.size,
      missing_ids: missingIds,
      partial: missingIds.length > 0,
    },
  };
  const output = await writeJson(resolve(outputPath), joined);
  return { output, ...joined.join_report };
}
