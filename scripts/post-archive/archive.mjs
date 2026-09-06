import { createHash } from "node:crypto";
import { closeSync, openSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");

export async function openPostArchive(databasePath) {
  const absolutePath = resolve(databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const lockPath = `${absolutePath}.lock`;
  let lock;
  try { lock = openSync(lockPath, "wx"); }
  catch (error) { throw new Error(`Archive is locked: ${lockPath}. Close other archive commands; after a crashed process remove this lock before retrying.`, { cause: error }); }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, opened_at: new Date().toISOString(), database_path: absolutePath }));
  let database;
  try {
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  database = existsSync(absolutePath)
    ? new SQL.Database(readFileSync(absolutePath))
    : new SQL.Database();
  initialize(database);
  } catch (error) {
    database?.close(); closeSync(lock); unlinkSync(lockPath); throw error;
  }
  const connection = {
    rows: (sql, params) => rows(database, sql, params),
    run: (sql, params) => database.run(sql, params),
  };
  function transaction(callback) {
    database.run("BEGIN");
    let committed = false;
    try {
      const result = callback(connection);
      if (result?.then) throw new Error("Archive transactions must be synchronous");
      database.run("COMMIT"); committed = true;
      persist(database, absolutePath);
      return result;
    } catch (error) {
      if (!committed) database.run("ROLLBACK");
      throw error;
    }
  }

  return {
    databasePath: absolutePath,
    importFiles(paths, options = {}) {
      const writtenAt = requireIsoTime(options.writtenAt ?? new Date().toISOString(), "writtenAt");
      const inputs = paths.map((path) => readBatch(path));
      return transaction(() => {
        let observations = 0;
        let alreadyImported = 0;
        for (const input of inputs) {
          if (rows(database, "SELECT import_id FROM batch_imports WHERE input_digest = $digest LIMIT 1", { $digest: input.digest }).length) {
            alreadyImported += 1;
          } else observations += insertBatch(database, input, writtenAt);
        }
        return { database_path: absolutePath, written_at: writtenAt, batches: inputs.length, observations, already_imported: alreadyImported };
      });
    },
    transaction,
    rows: connection.rows,
    latestAll() {
      return rows(database, "SELECT * FROM latest_post_observations ORDER BY scraped_at_valid DESC, written_at DESC, observation_id DESC").map(toPublicObservation);
    },
    observation(id) {
      const row = rows(database, "SELECT * FROM post_observations WHERE observation_id = $id", { $id: id })[0];
      if (!row) throw new Error(`Unknown observation: ${id}`);
      return toPublicObservation(row);
    },
    observationIndex(id) {
      return rows(database, `SELECT COUNT(*) AS position FROM post_observations
        WHERE import_id=(SELECT import_id FROM post_observations WHERE observation_id=$id) AND observation_id < $id`, { $id: id })[0].position;
    },
    batch(importId) {
      const row = rows(database, "SELECT * FROM batch_imports WHERE import_id = $id", { $id: importId })[0];
      if (!row) throw new Error(`Unknown import: ${importId}`);
      return { source_file: row.source_path, raw: JSON.parse(row.raw_json).batch };
    },
    latest(options = {}) {
      const limit = requireLimit(options.limit ?? 50);
      const params = { $limit: limit };
      const where = options.groupUrl ? "WHERE group_url = $group_url" : "";
      if (options.groupUrl) params.$group_url = canonicalizeUrl(options.groupUrl);
      return rows(database, `
        SELECT * FROM latest_post_observations
        ${where}
        ORDER BY scraped_at_valid DESC, written_at DESC, observation_id DESC
        LIMIT $limit
      `, params).map(toPublicObservation);
    },
    history(identity, options = {}) {
      const limit = requireLimit(options.limit ?? 50);
      const postKey = identity.startsWith("url:") || identity.startsWith("post-id:") || identity.startsWith("fingerprint:")
        ? identity
        : `url:${canonicalizeUrl(identity)}`;
      return rows(database, `
        SELECT * FROM post_observations
        WHERE post_key = $post_key
        ORDER BY written_at DESC, observation_id DESC
        LIMIT $limit
      `, { $post_key: postKey, $limit: limit }).map(toPublicObservation);
    },
    close() {
      database.close();
      closeSync(lock); unlinkSync(lockPath);
    },
  };
}

function initialize(database) {
  database.run("PRAGMA foreign_keys = ON");
  database.run(`
    CREATE TABLE IF NOT EXISTS batch_imports (
      import_id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      group_id TEXT,
      group_url TEXT NOT NULL,
      source_path TEXT NOT NULL,
      written_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_observations (
      observation_id INTEGER PRIMARY KEY,
      import_id INTEGER NOT NULL REFERENCES batch_imports(import_id),
      post_key TEXT NOT NULL,
      key_kind TEXT NOT NULL CHECK (key_kind IN ('url', 'post_id', 'fingerprint')),
      batch_id TEXT NOT NULL,
      group_url TEXT NOT NULL,
      post_id TEXT,
      post_url TEXT,
      author_name TEXT,
      content_text TEXT NOT NULL,
      scraped_at TEXT,
      written_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS post_observations_key_history
      ON post_observations(post_key, written_at DESC, observation_id DESC);
    CREATE INDEX IF NOT EXISTS post_observations_group_latest
      ON post_observations(group_url, written_at DESC, observation_id DESC);

  `);
  // Additive migration preserves every raw record and observation ID, including old duplicates.
  if (!rows(database, "PRAGMA table_info(batch_imports)").some(({ name }) => name === "input_digest")) {
    database.run("ALTER TABLE batch_imports ADD COLUMN input_digest TEXT");
    for (const row of rows(database, "SELECT import_id, raw_json FROM batch_imports")) {
      database.run("UPDATE batch_imports SET input_digest=$digest WHERE import_id=$id", { $digest: digestJson(JSON.parse(row.raw_json)), $id: row.import_id });
    }
  }
  if (!rows(database, "PRAGMA table_info(post_observations)").some(({ name }) => name === "scraped_at_valid")) {
    database.run("ALTER TABLE post_observations ADD COLUMN scraped_at_valid TEXT");
    for (const row of rows(database, "SELECT observation_id, scraped_at FROM post_observations")) {
      database.run("UPDATE post_observations SET scraped_at_valid=$time WHERE observation_id=$id", { $time: normalizeTimestamp(row.scraped_at), $id: row.observation_id });
    }
  }
  database.run(`
    CREATE INDEX IF NOT EXISTS batch_imports_digest ON batch_imports(input_digest);
    CREATE INDEX IF NOT EXISTS post_observations_capture ON post_observations(post_key, scraped_at_valid DESC, written_at DESC, observation_id DESC);
    DROP VIEW IF EXISTS latest_post_observations;
    CREATE VIEW latest_post_observations AS
      SELECT observation.* FROM post_observations AS observation
      WHERE observation.observation_id = (
        SELECT newer.observation_id FROM post_observations AS newer
        WHERE newer.post_key = observation.post_key
        ORDER BY newer.scraped_at_valid DESC, newer.written_at DESC, newer.observation_id DESC LIMIT 1
      );
    PRAGMA user_version = 2;
  `);
}

function readBatch(path) {
  const absolutePath = resolve(path);
  const rawJson = readFileSync(absolutePath, "utf8");
  let envelope;
  try {
    envelope = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`${absolutePath}: invalid JSON (${error instanceof Error ? error.message : "parse error"})`);
  }
  if (!envelope?.batch || !Array.isArray(envelope.posts)) throw new Error(`${absolutePath}: expected a batch object and posts array`);
  if (!envelope.batch.batch_id || !envelope.batch.group_url) throw new Error(`${absolutePath}: batch_id and group_url are required`);
  return { absolutePath, rawJson, envelope, digest: digestJson(envelope) };
}

function insertBatch(database, input, writtenAt) {
  const { envelope } = input;
  database.run(`
    INSERT INTO batch_imports(batch_id, group_id, group_url, source_path, written_at, raw_json, input_digest)
    VALUES ($batch_id, $group_id, $group_url, $source_path, $written_at, $raw_json, $input_digest)
  `, {
    $batch_id: envelope.batch.batch_id,
    $group_id: envelope.batch.group_id ?? null,
    $group_url: canonicalizeUrl(envelope.batch.group_url),
    $source_path: input.absolutePath,
    $written_at: writtenAt,
    $raw_json: input.rawJson,
    $input_digest: input.digest,
  });
  const importId = scalar(database, "SELECT last_insert_rowid()");

  for (const post of envelope.posts) {
    if (!post || typeof post !== "object") throw new Error(`${input.absolutePath}: every post must be an object`);
    const identity = identifyPost(envelope.batch, post);
    database.run(`
      INSERT INTO post_observations(
        import_id, post_key, key_kind, batch_id, group_url, post_id, post_url,
        author_name, content_text, scraped_at, written_at, raw_json, scraped_at_valid
      ) VALUES (
        $import_id, $post_key, $key_kind, $batch_id, $group_url, $post_id, $post_url,
        $author_name, $content_text, $scraped_at, $written_at, $raw_json, $scraped_at_valid
      )
    `, {
      $import_id: importId,
      $post_key: identity.key,
      $key_kind: identity.kind,
      $batch_id: envelope.batch.batch_id,
      $group_url: canonicalizeUrl(envelope.batch.group_url),
      $post_id: post.post_id ?? null,
      $post_url: post.post_url ? canonicalizeUrl(post.post_url) : null,
      $author_name: post.author_name ?? null,
      $content_text: typeof post.content_text === "string" ? post.content_text : "",
      $scraped_at: typeof post.scraped_at === "string" ? post.scraped_at : null,
      $scraped_at_valid: normalizeTimestamp(post.scraped_at),
      $written_at: writtenAt,
      $raw_json: JSON.stringify(post),
    });
  }
  return envelope.posts.length;
}

export function identifyPost(batch, post) {
  if (post.post_url) return { kind: "url", key: `url:${canonicalizeUrl(post.post_url)}` };
  const groupUrl = canonicalizeUrl(batch.group_url);
  if (post.post_id) return { kind: "post_id", key: `post-id:${groupUrl}:${post.post_id}` };
  const fingerprintSource = [
    groupUrl,
    normalizeFingerprintPart(post.author_name),
    normalizeFingerprintPart(post.published_time_raw),
    normalizeFingerprintPart(post.content_text),
  ].join("\u001f");
  const digest = createHash("sha256").update(fingerprintSource).digest("hex");
  return { kind: "fingerprint", key: `fingerprint:${digest}` };
}

function canonicalizeUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    url.protocol = "https:";
    url.hash = "";
    if (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com")) {
      url.hostname = "www.facebook.com";
      for (const key of [...url.searchParams.keys()]) {
        if (["fbclid", "__cft__", "__tn__", "mibextid", "ref", "refid", "paipv"].includes(key) || key.startsWith("__cft__")) {
          url.searchParams.delete(key);
        }
      }
    }
    return url.toString();
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
}

function normalizeFingerprintPart(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLocaleLowerCase()
    .normalize("NFKC");
}

function toPublicObservation(row) {
  return {
    observation_id: row.observation_id,
    import_id: row.import_id,
    scraped_at_valid: row.scraped_at_valid,
    quality_warnings: [
      ...(!row.scraped_at_valid ? ["invalid_scraped_at"] : []),
      ...(row.key_kind === "fingerprint" ? ["fingerprint_identity"] : []),
      ...(JSON.parse(row.raw_json).content_is_truncated ? ["source_content_truncated"] : []),
    ],
    post_key: row.post_key,
    key_kind: row.key_kind,
    batch_id: row.batch_id,
    group_url: row.group_url,
    post_id: row.post_id,
    post_url: row.post_url,
    author_name: row.author_name,
    content_text: row.content_text,
    scraped_at: row.scraped_at,
    written_at: row.written_at,
    post: JSON.parse(row.raw_json),
  };
}

function rows(database, sql, params = {}) {
  const statement = database.prepare(sql);
  try {
    statement.bind(params);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function scalar(database, sql) {
  const result = database.exec(sql);
  return result[0]?.values[0]?.[0];
}

function persist(database, databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, Buffer.from(database.export()));
    renameSync(temporaryPath, databasePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function requireIsoTime(value, name) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).valueOf())) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function requireLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error("limit must be an integer from 1 to 10000");
  return parsed;
}

export function normalizeTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [date, time] = value.split("T");
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.valueOf()) || calendar.toISOString().slice(0, 10) !== date || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/.test(time)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function digestJson(value) {
  function canonical(item) {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
