import { access, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCsv } from "./lib/csv.mjs";
import { stableStringify } from "./lib/ids.mjs";
import { readJson, readRecords } from "./lib/io.mjs";
import { assertAnalysisMatchesSource, assertTaskShape } from "./lib/validation.mjs";
import { buildFinalized } from "./finalize.mjs";

export async function validateRun(runDirectory) {
  const directory = resolve(runDirectory);
  const release = await realpath(join(directory, "current")).catch((error) => { if (error.code !== "ENOENT") throw error; return directory; });
  const output = await readJson(join(release, "output_result.json"));
  if (output.schema_version !== "badminton-output-2") throw new Error("Old output contract: revalidate/re-extract then finalize into a fresh directory");
  const [joined, report, csvText, html] = await Promise.all([
    readJson(join(release, "joined_records.json")),
    readJson(join(release, "run_report.json")), readFile(join(release, "output_result.csv"), "utf8"),
    readFile(join(release, "index.html"), "utf8"),
  ]);
  const expected = buildFinalized(joined, { publicationId: output.publication_id, generatedAt: output.generated_at, joinedPath: report.joined_file });
  const equal = (left, right, message) => { if (stableStringify(left) !== stableStringify(right)) throw new Error(message); };
  equal(output, expected.result, "JSON output differs from validated joined source/analysis");
  equal(report, expected.report, "Report differs from publication data");
  if (csvText !== expected.csv) throw new Error("CSV differs from JSON publication (IDs, values, or ordering)");
  for (const [name, contents] of Object.entries(expected.tableFiles)) {
    if (await readFile(join(release, name), "utf8") !== contents) throw new Error(`Table ${name} differs from publication data`);
  }
  const embedded = html.match(/<script type="application\/json" id="session-data">([\s\S]*?)<\/script>/);
  if (!embedded) throw new Error("Browser is missing publication data");
  equal(JSON.parse(embedded[1]), { result: output, rows: parseCsv(csvText).rows, csv: csvText }, "Browser differs from JSON/CSV publication");
  let resultCount = joined.posts.filter((post) => post.analysis).length;
  const standalone = await access(join(directory, "source_records.json")).then(() => true, (error) => { if (error.code !== "ENOENT") throw error; return false; });
  if (standalone) {
    const [source, tasks, results] = await Promise.all([
      readJson(join(directory, "source_records.json")), readRecords(join(directory, "llm_tasks.jsonl")), readRecords(join(directory, "llm_results.jsonl")),
    ]);
    const uniqueMap = (items, label) => {
      const map = new Map(items.map((item) => [item.id, item]));
      if (map.size !== items.length) throw new Error(`Duplicate ${label} IDs`);
      return map;
    };
    const sourceById = uniqueMap(source.posts, "source");
    const taskById = uniqueMap(tasks, "task");
    const resultById = uniqueMap(results, "analysis");
    if (sourceById.size !== taskById.size) throw new Error("Task count differs from source post count");
    equal(source.batches, joined.batches, "Source batches differ from joined batches");
    for (const task of tasks) {
      assertTaskShape(task);
      if (!sourceById.has(task.id)) throw new Error(`Unknown task ID: ${task.id}`);
      equal(task.context, sourceById.get(task.id).context, `Task context differs for ${task.id}`);
    }
    for (const result of results) {
      if (!sourceById.has(result.id)) throw new Error(`Unknown analysis ID: ${result.id}`);
      assertAnalysisMatchesSource(result, sourceById.get(result.id).context.text);
    }
    if (joined.posts.length !== sourceById.size) throw new Error("Joined post count differs from source");
    for (const post of joined.posts) {
      const { analysis, ...savedSource } = post;
      equal(savedSource, sourceById.get(post.id), `Source record differs for ${post.id}`);
      equal(analysis, resultById.get(post.id)?.analysis ?? null, `Joined analysis differs for ${post.id}`);
    }
    const missing = source.posts.filter((post) => !resultById.has(post.id)).map((post) => post.id);
    equal(joined.join_report.missing_ids, missing, "Join missing IDs differ from actual results");
    if (joined.join_report.partial !== (missing.length > 0)) throw new Error("Join partial status differs from missing IDs");
    resultCount = results.length;
  }
  return { run: directory, batches: joined.batches.length, posts: joined.posts.length, results: resultCount, listings: output.listings.length, csv_rows: parseCsv(csvText).rows.length, partial: Boolean(report.partial) };
}

// Semantic acceptance is independent of schema validity. Only reviewed labels
// participate; candidate notes never count as a human-confirmed answer.
export async function evaluateQuality(samplesPath, resultsPath, outputPath) {
  const { writeJson } = await import("./lib/io.mjs");
  const corpus = await readJson(samplesPath);
  const results = await readRecords(resultsPath);
  if (!Array.isArray(corpus.samples)) throw new Error("Quality corpus requires samples[]");
  const samples = new Map(corpus.samples.map((sample) => [sample.id, sample]));
  if (samples.size !== corpus.samples.length) throw new Error("Duplicate quality sample IDs");
  const byId = new Map();
  for (const result of results) {
    if (!samples.has(result.id)) throw new Error(`Unknown quality result ID: ${result.id}`);
    if (byId.has(result.id)) throw new Error(`Duplicate quality result ID: ${result.id}`);
    byId.set(result.id, result);
  }
  const fields = ["schedule.date", "schedule.recurrence", "schedule.start_time", "schedule.end_time", "schedule.end_day_offset", "venue", "price_options", "skill", "availability", "registration", "court_count", "shuttlecock", "amenities", "listing_type", "play_format", "service_details"];
  const value = (listing, path) => path.split(".").reduce((item, key) => item?.[key], listing) ?? null;
  const anchor = (listing) => stableStringify([listing.schedule, listing.venue]);
  const sorted = (listings) => [...listings].sort((a, b) => anchor(a).localeCompare(anchor(b)));
  const metrics = Object.fromEntries(fields.map((field) => [field, { correct: 0, total: 0 }]));
  const cases = [];
  const covered = new Set();
  let reviewed = 0;
  for (const sample of corpus.samples) {
    assertTaskShape({ id: sample.id, context: sample.context });
    if (!sample.review?.reviewer?.trim() || !sample.review?.confirmed_at || !Number.isFinite(Date.parse(sample.review.confirmed_at)) || !sample.acceptable_analyses?.length) {
      cases.push({ id: sample.id, status: "awaiting_human_annotation" }); continue;
    }
    reviewed += 1;
    for (const category of sample.categories ?? []) if (category !== "truncated" || sample.context.is_truncated === true) covered.add(category);
    for (const analysis of sample.acceptable_analyses) assertAnalysisMatchesSource({ id: sample.id, analysis }, sample.context.text);
    const result = byId.get(sample.id);
    if (!result) { cases.push({ id: sample.id, status: "missing_result", missed_listings: Math.min(...sample.acceptable_analyses.map((analysis) => analysis.listings.length)) }); continue; }
    try { assertAnalysisMatchesSource(result, sample.context.text); }
    catch (error) { cases.push({ id: sample.id, status: "invalid_result", error: error.message }); continue; }
    const actual = sorted(result.analysis.listings);
    const alternatives = sample.acceptable_analyses.map((expectedAnalysis) => {
      const expected = sorted(expectedAnalysis.listings);
      const checks = [];
      for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) for (const field of fields) {
        checks.push({ field, correct: Boolean(expected[index] && actual[index]) && stableStringify(value(expected[index], field)) === stableStringify(value(actual[index], field)) });
      }
      const pool = actual.map(anchor);
      let missed = 0;
      for (const listing of expected) {
        const index = pool.indexOf(anchor(listing));
        if (index === -1) missed += 1; else pool.splice(index, 1);
      }
      const classification = expectedAnalysis.is_recruitment === result.analysis.is_recruitment;
      return { checks, classification, missed_listings: missed, unmatched_listings: pool.length, score: checks.filter((check) => check.correct).length + Number(classification) };
    }).sort((a, b) => b.score - a.score);
    const best = alternatives[0];
    for (const check of best.checks) { metrics[check.field].total += 1; if (check.correct) metrics[check.field].correct += 1; }
    cases.push({ id: sample.id, status: best.classification && best.checks.every((check) => check.correct) ? "passed" : "semantic_mismatch",
      missed_listings: best.missed_listings, unmatched_listings: best.unmatched_listings,
      incorrect_fields: [...new Set(best.checks.filter((check) => !check.correct).map((check) => check.field))], classification_correct: best.classification,
    });
  }
  const requiredCategories = ["single_session", "multiple_pairings", "recurrence_and_date", "overnight", "conditional_price", "missing_values", "truncated", "non_recruitment", "source_conflict"];
  const missingCategories = requiredCategories.filter((category) => !covered.has(category));
  const report = {
    generated_at: new Date().toISOString(), sample_count: corpus.samples.length, human_reviewed: reviewed,
    passed: reviewed >= 30 && missingCategories.length === 0 && cases.every((item) => item.status === "passed"),
    missing_categories: missingCategories,
    missed_listings: cases.reduce((sum, item) => sum + (item.missed_listings ?? 0), 0),
    unmatched_listings: cases.reduce((sum, item) => sum + (item.unmatched_listings ?? 0), 0),
    field_accuracy: Object.fromEntries(Object.entries(metrics).map(([field, counts]) => [field, { ...counts, accuracy: counts.total ? counts.correct / counts.total : null }])),
    metric_scope: "Field accuracy covers schema-valid results with human-reviewed labels; missing/invalid results fail acceptance and are listed separately. A quote match does not prove a semantic fact.",
    cases,
  };
  await writeJson(outputPath, report);
  return { output: resolve(outputPath), passed: report.passed, sample_count: report.sample_count, human_reviewed: reviewed, missing_categories: missingCategories };
}
