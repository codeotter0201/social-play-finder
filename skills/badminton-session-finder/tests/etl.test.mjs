import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPostArchive } from "../../../scripts/post-archive/archive.mjs";
import { prepareArchive, runEtl } from "../scripts/etl.mjs";
import { readJson, readRecords, writeJson, writeJsonl } from "../scripts/lib/io.mjs";
import { resultFor } from "./fixtures/analysis.mjs";
import { validateRun } from "../scripts/validate.mjs";

const modelConfig = { model: "manual-fixture", version: "1", temperature: 0 };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "badminton-etl-"));
  const db = join(dir, "archive.sqlite");
  const raw = JSON.parse(await readFile(new URL("fixtures/raw.json", import.meta.url), "utf8"));
  const out = join(dir, "published");
  async function importRaw(value = raw, file = "raw.json") {
    const path = await writeJson(join(dir, file), value);
    const archive = await openPostArchive(db);
    try { return archive.importFiles([path]); } finally { archive.close(); }
  }
  async function prepare(name = "handoff", options = {}) {
    const run = join(dir, name);
    const summary = await prepareArchive(db, run, { modelConfig, ...options });
    return { run, summary, tasks: await readRecords(join(run, "llm_tasks.jsonl")) };
  }
  async function accept(handoff, results) {
    const analysis = await writeJsonl(join(handoff.run, "results.jsonl"), results);
    return runEtl("accept", { db, run: handoff.run, analysis });
  }
  async function publish(options = {}) { return runEtl("publish", { db, out, ...options }); }
  return { dir, db, raw, out, importRaw, prepare, accept, publish };
}
function resultsFor(handoff) { return handoff.tasks.map((task) => resultFor(task, task.context.text.includes("秘密基地") ? "secret" : "line")); }

test("A1,A2,A4: latest archive tasks are idempotent; reuse only effective context and all versions", async () => {
  const s = await setup(); await s.importRaw();
  const first = await s.prepare();
  assert.equal((await s.accept(first, resultsFor(first).reverse())).succeeded, 2);
  const initial = await s.publish();
  assert.equal((await s.importRaw()).observations, 0);
  assert.equal((await s.prepare()).tasks.length, 0);
  assert.equal((await s.publish()).publication_id, initial.publication_id);

  const metadata = structuredClone(s.raw); metadata.batch.batch_id = "metadata";
  metadata.posts[1].reaction_count = 99;
  metadata.posts[1].content_text = metadata.posts[1].content_text.replace("event=2", "event=3");
  metadata.posts[1].author_name = "Changed author";
  await s.importRaw(metadata);
  const reused = await s.prepare("reuse");
  assert.equal(reused.tasks.length, 0); assert.equal(reused.summary.reused, 2);
  await s.publish();
  const output = await readJson(join(s.out, "current", "output_result.json"));
  const line = output.listings.find((listing) => listing.registration.line_id);
  assert.equal(line.contact.registration_urls[0], "https://example.com/register?event=3");
  assert.equal(line.source.author_name, "Changed author");
  assert.ok(line.source.observation_id > 2);

  const newer = structuredClone(metadata); newer.batch.batch_id = "new capture"; newer.posts[1].scraped_at = "2026-09-02T11:30:00Z";
  await s.importRaw(newer);
  const changed = await s.prepare("changed"); assert.equal(changed.tasks.length, 1);
  const modelChanged = await s.prepare("model", { modelConfig: { ...modelConfig, version: "2" } }); assert.equal(modelChanged.tasks.length, 2);
  const archive = await openPostArchive(s.db);
  try {
    const { taskStore } = await import("../scripts/task-store.mjs");
    const { extractionContract } = await import("../scripts/lib/contract.mjs");
    const contract = await extractionContract(modelConfig);
    const tasks = taskStore(archive).prepare({ ...contract, rules_version: "changed-rules" });
    assert.equal(tasks.filter((task) => task.status === "pending").length, 2);
    assert.ok(tasks.every((task) => task.rules_version === "changed-rules"));
  } finally { archive.close(); }
});

test("A7: partial validation, process interruption, explicit recovery and failed retry preserve successful work", async () => {
  const s = await setup(); await s.importRaw(); const first = await s.prepare();
  await runEtl("start", { db: s.db, run: first.run });
  const results = resultsFor(first);
  results[0].analysis.listings[0].evidence[0].quote = "fabricated";
  const partial = await s.accept(first, [results[0]]);
  assert.equal(partial.failed, 1); assert.equal(partial.running, 1); assert.equal(partial.partial, true);
  assert.match(partial.outcomes[0].error, /evidence/);
  await runEtl("recover", { db: s.db });
  await runEtl("retry", { db: s.db, failed: true });
  const retry = await s.prepare("retry"); assert.equal(retry.tasks.length, 2);
  const accepted = await s.accept(retry, resultsFor(retry)); assert.equal(accepted.succeeded, 2);
  const status = await runEtl("status", { db: s.db }); assert.ok(status.tasks.every((task) => task.attempts === 2));
  assert.equal((await s.prepare("finished")).tasks.length, 0);
  await s.publish(); assert.equal((await validateRun(s.out)).listings, 2);
  await assert.rejects(runEtl("retry", { db: s.db, id: retry.tasks[0].id }), /successful tasks remain immutable/);
});

test("A8–A10: replace entire source, withdraw non-recruitment, retain stale versions, reject late overwrite, atomic products", async () => {
  const s = await setup(); s.raw.posts = [s.raw.posts[1]];
  s.raw.posts[0].content_text += "；另18:00-20:00；另20:00-22:00";
  await s.importRaw(); const first = await s.prepare();
  const three = resultFor(first.tasks[0], "line");
  for (const [index, [start, end]] of [["18:00", "20:00"], ["20:00", "22:00"]].entries()) {
    const listing = structuredClone(three.analysis.listings[0]); listing.listing_index = index + 1;
    listing.schedule.start_time = start; listing.schedule.end_time = end;
    for (const evidence of listing.evidence) if (["schedule.start_time", "schedule.end_time", "price_options.0.duration_minutes"].includes(evidence.field)) evidence.quote = `${start}-${end}`;
    three.analysis.listings.push(listing);
  }
  await s.accept(first, [three]); await s.publish();
  assert.equal((await readJson(join(s.out, "current", "output_result.json"))).listings.length, 3);
  const next = structuredClone(s.raw); next.batch.batch_id = "second"; next.posts[0].scraped_at = "2026-09-02T10:00:00Z";
  await s.importRaw(next); const second = await s.prepare("second");
  const invalid = resultFor(second.tasks[0], "line"); invalid.analysis.listings[0].evidence = [];
  await s.accept(second, [invalid]); const stale = await s.publish();
  assert.equal(stale.tasks.stale, 1); assert.equal(stale.partial, true);
  assert.ok((await readJson(join(s.out, "current", "output_result.json"))).listings.every((item) => item.source.stale && item.source.latest_observation_id !== item.source.observation_id));

  await runEtl("retry", { db: s.db, failed: true });
  await s.accept(second, [resultFor(second.tasks[0], "line")]);
  const before = await realpath(join(s.out, "current"));
  const beforeProducts = await Promise.all(["output_result.json", "output_result.csv", "run_report.json", "index.html"].map((name) => readFile(join(s.out, "current", name), "utf8")));
  await assert.rejects(s.publish({ beforeActivate() { throw new Error("simulated interruption"); } }), /simulated interruption/);
  assert.equal(await realpath(join(s.out, "current")), before);
  assert.deepEqual(await Promise.all(["output_result.json", "output_result.csv", "run_report.json", "index.html"].map((name) => readFile(join(s.out, "current", name), "utf8"))), beforeProducts);
  await s.publish(); assert.equal((await readJson(join(s.out, "current", "output_result.json"))).listings.length, 1);

  const old = structuredClone(next); old.batch.batch_id = "third"; old.posts[0].scraped_at = "2026-09-03T10:00:00Z";
  await s.importRaw(old); const late = await s.prepare("late");
  const newest = structuredClone(old); newest.batch.batch_id = "fourth"; newest.posts[0].scraped_at = "2026-09-04T10:00:00Z"; newest.posts[0].content_text = "出售二手球拍";
  await s.importRaw(newest); const last = await s.prepare("last");
  await s.accept(last, [{ id: last.tasks[0].id, analysis: { is_recruitment: false, listings: [], warnings: ["not_recruitment"] } }]);
  await s.publish(); assert.equal((await readJson(join(s.out, "current", "output_result.json"))).listings.length, 0);
  await s.accept(late, [resultFor(late.tasks[0], "line")]); await s.publish();
  assert.equal((await readJson(join(s.out, "current", "output_result.json"))).listings.length, 0);
  assert.equal((await validateRun(s.out)).listings, 0);
});

test("A5: duplicate/unknown/malformed handoff records are reported while independent valid posts finish", async () => {
  const s = await setup(); await s.importRaw(); const first = await s.prepare();
  const results = resultsFor(first);
  const result = await s.accept(first, [results[0], results[0], { ...results[1], id: "post_00000000000000000000" }, results[1]]);
  assert.equal(result.failed, 1); assert.equal(result.succeeded, 1); assert.equal(result.errors.length, 1);
  const published = await s.publish(); assert.equal(published.partial, true); assert.equal(published.stats.listings, 1);
  const file = join(first.run, "malformed.jsonl"); await writeFile(file, '{bad json}\n');
  const malformed = await runEtl("accept", { db: s.db, run: first.run, analysis: file });
  assert.equal(malformed.errors[0].line, 1); assert.equal(malformed.partial, true);
});

test("A1: archive prepare reads all latest keys without the CLI display limit", async () => {
  const s = await setup();
  s.raw.posts = Array.from({ length: 64 }, (_, index) => ({ ...s.raw.posts[1], post_id: String(index), post_url: `https://www.facebook.com/groups/fixture-group/posts/${index}/` }));
  await s.importRaw();
  const older = structuredClone(s.raw); older.batch.batch_id = "older imported later";
  for (const post of older.posts) { post.scraped_at = "2026-08-01T00:00:00Z"; post.content_text = "older text"; }
  await s.importRaw(older, "older.json");
  const prepared = await s.prepare();
  assert.equal(prepared.tasks.length, 64);
  assert.ok(prepared.tasks.every((task) => task.context.text.includes("板橋羽球館")));
  const source = await readJson(join(prepared.run, "source_records.json"));
  assert.ok(source.posts.every((post) => post.origin.observation_id <= 64));
  assert.deepEqual(source.posts.map((post) => post.source_post_index).sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index));
});
