import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identifyPost, openPostArchive } from "./archive.mjs";

test("archive appends duplicate observations and latest returns the newest write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fb-post-archive-"));
  const databasePath = join(directory, "posts.sqlite");
  const firstPath = join(directory, "first.json");
  const secondPath = join(directory, "second.json");
  writeFileSync(firstPath, JSON.stringify(envelope("first content", "2026-09-01T10:00:00.000Z")));
  writeFileSync(secondPath, JSON.stringify(envelope("updated content", "2026-09-02T10:00:00.000Z")));

  let archive = await openPostArchive(databasePath);
  archive.importFiles([firstPath], { writtenAt: "2026-09-01T11:00:00.000Z" });
  archive.importFiles([secondPath], { writtenAt: "2026-09-02T11:00:00.000Z" });

  assert.equal(archive.latest().length, 1);
  assert.equal(archive.latest()[0].content_text, "updated content");
  const history = archive.history("https://www.facebook.com/groups/123/posts/456/?fbclid=tracking");
  assert.deepEqual(history.map((item) => item.content_text), ["updated content", "first content"]);
  assert.deepEqual(history.map((item) => item.written_at), ["2026-09-02T11:00:00.000Z", "2026-09-01T11:00:00.000Z"]);
  archive.close();

  archive = await openPostArchive(databasePath);
  assert.equal(archive.latest()[0].post.content_text, "updated content");
  archive.close();
});

test("identity prefers URL and has deterministic fallbacks", () => {
  const batch = { group_url: "https://www.facebook.com/groups/123/" };
  assert.deepEqual(identifyPost(batch, { post_url: "https://m.facebook.com/groups/123/posts/456/?fbclid=x" }), {
    kind: "url",
    key: "url:https://www.facebook.com/groups/123/posts/456/",
  });
  assert.deepEqual(identifyPost(batch, { post_url: null, post_id: "456" }), {
    kind: "post_id",
    key: "post-id:https://www.facebook.com/groups/123/:456",
  });
  const first = identifyPost(batch, { post_url: null, post_id: null, author_name: " Alice ", published_time_raw: null, content_text: "Same  text" });
  const second = identifyPost(batch, { post_url: null, post_id: null, author_name: "alice", published_time_raw: null, content_text: "Same text" });
  assert.equal(first.kind, "fingerprint");
  assert.equal(first.key, second.key);
});

function envelope(contentText, scrapedAt) {
  return {
    batch: {
      batch_id: `batch-${scrapedAt}`,
      group_id: "123",
      group_url: "https://www.facebook.com/groups/123/",
    },
    posts: [{
      post_id: "456",
      post_url: "https://www.facebook.com/groups/123/posts/456/",
      author_name: "Author",
      published_time_raw: null,
      content_text: contentText,
      scraped_at: scrapedAt,
    }],
  };
}

test("A1–A3: capture ordering, stable ties, invalid timestamps, truncation and repeated imports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fb-archive-order-"));
  const archive = await openPostArchive(join(directory, "posts.sqlite"));
  try {
    const save = (name, value) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const newest = envelope("newest truncated", "2026-09-05T18:00:00+08:00");
    newest.posts[0].content_is_truncated = true;
    const newPath = save("new.json", newest);
    archive.importFiles([newPath], { writtenAt: "2026-09-05T11:00:00Z" });
    archive.importFiles([save("old.json", envelope("older complete", "2026-09-04T10:00:00Z"))], { writtenAt: "2026-09-06T11:00:00Z" });
    for (const time of [null, "nonsense", "2026-02-30T10:00:00Z", "2026-09-07"]) {
      archive.importFiles([save("invalid.json", envelope("invalid time", time))], { writtenAt: "2026-09-07T11:00:00Z" });
    }
    assert.equal(archive.latest()[0].content_text, "newest truncated");
    assert.deepEqual(archive.latest()[0].quality_warnings, ["source_content_truncated"]);
    const id = archive.latest()[0].observation_id;
    assert.equal(archive.importFiles([newPath]).observations, 0);
    const formatted = save("copy.json", newest);
    writeFileSync(formatted, JSON.stringify(newest, null, 4));
    assert.equal(archive.importFiles([formatted]).already_imported, 1);
    assert.equal(archive.latest()[0].observation_id, id);
    archive.importFiles([save("tie.json", envelope("same instant later write", "2026-09-05T10:00:00Z"))], { writtenAt: "2026-09-08T00:00:00Z" });
    assert.equal(archive.latest()[0].content_text, "same instant later write");
    const unreliable = envelope("fingerprint", null); unreliable.posts[0].post_url = null; unreliable.posts[0].post_id = null;
    archive.importFiles([save("fingerprint.json", unreliable)]);
    const fallback = archive.latestAll().find((row) => row.key_kind === "fingerprint");
    assert.deepEqual(fallback.quality_warnings, ["invalid_scraped_at", "fingerprint_identity"]);
    assert.equal(archive.history(newest.posts[0].post_url).length, 7);
  } finally { archive.close(); }
});

test("A13: additive migration keeps legacy duplicates, raw JSON and observation IDs", async () => {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const directory = mkdtempSync(join(tmpdir(), "fb-archive-migrate-"));
  const path = join(directory, "legacy.sqlite");
  const raw = envelope("legacy raw", "2026-09-01T10:00:00Z");
  db.run(`CREATE TABLE batch_imports(import_id INTEGER PRIMARY KEY,batch_id TEXT,group_id TEXT,group_url TEXT,source_path TEXT,written_at TEXT,raw_json TEXT);
    CREATE TABLE post_observations(observation_id INTEGER PRIMARY KEY,import_id INTEGER,post_key TEXT,key_kind TEXT,batch_id TEXT,group_url TEXT,post_id TEXT,post_url TEXT,author_name TEXT,content_text TEXT,scraped_at TEXT,written_at TEXT,raw_json TEXT);`);
  db.run("INSERT INTO batch_imports VALUES(5,?,?,?,?,?,?)", [raw.batch.batch_id, "123", raw.batch.group_url, "legacy.json", "2026-09-01T11:00:00Z", JSON.stringify(raw)]);
  for (const id of [77, 78]) db.run("INSERT INTO post_observations VALUES(?,5,?,?,?,?,?,?,?,?,?,?,?)", [id, identifyPost(raw.batch, raw.posts[0]).key, "url", raw.batch.batch_id, raw.batch.group_url, "456", raw.posts[0].post_url, "Author", "legacy raw", raw.posts[0].scraped_at, "2026-09-01T11:00:00Z", JSON.stringify(raw.posts[0])]);
  writeFileSync(path, Buffer.from(db.export())); db.close();
  const archive = await openPostArchive(path);
  try {
    assert.deepEqual(archive.history(raw.posts[0].post_url).map((row) => row.observation_id), [78, 77]);
    assert.deepEqual(archive.latest()[0].post, raw.posts[0]);
    const input = join(directory, "raw.json"); writeFileSync(input, JSON.stringify(raw));
    assert.equal(archive.importFiles([input]).observations, 0);
    assert.equal(archive.rows("PRAGMA user_version")[0].user_version, 2);
  } finally { archive.close(); }
});

test("archive serializes snapshot writers and rolls back incomplete imports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fb-archive-lock-"));
  const path = join(directory, "posts.sqlite");
  const archive = await openPostArchive(path);
  try {
    await assert.rejects(openPostArchive(path), /Archive is locked/);
    const malformed = envelope("valid first post", "2026-09-01T00:00:00Z"); malformed.posts.push(null);
    const input = join(directory, "bad.json"); writeFileSync(input, JSON.stringify(malformed));
    assert.throws(() => archive.importFiles([input]), /every post/);
    assert.equal(archive.latestAll().length, 0);
  } finally { archive.close(); }
  const reopened = await openPostArchive(path); reopened.close();
});
