import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { joinAnalysis } from "../scripts/join.mjs";
import { prepareSources } from "../scripts/prepare.mjs";
import { readRecords, writeJsonl } from "../scripts/lib/io.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const fixture = join(directory, "fixtures", "raw.json");
const emptyAnalysis = { is_recruitment: false, listings: [], warnings: ["not_recruitment"] };

async function prepared() {
  const run = await mkdtemp(join(tmpdir(), "badminton-join-"));
  await prepareSources([fixture], run);
  return { run, tasks: await readRecords(join(run, "llm_tasks.jsonl")) };
}

test("join rejects missing analysis IDs", async () => {
  const { run, tasks } = await prepared();
  await writeJsonl(join(run, "results.jsonl"), [{ id: tasks[0].id, analysis: emptyAnalysis }]);
  await assert.rejects(
    joinAnalysis(join(run, "source_records.json"), join(run, "results.jsonl"), join(run, "joined.json")),
    /Missing analysis IDs/u,
  );
});

test("join rejects unknown and duplicate IDs", async () => {
  const { run, tasks } = await prepared();
  await writeJsonl(join(run, "unknown.jsonl"), [{ id: "post_00000000000000000000", analysis: emptyAnalysis }]);
  await assert.rejects(
    joinAnalysis(join(run, "source_records.json"), join(run, "unknown.jsonl"), join(run, "joined.json")),
    /Unknown analysis ID/u,
  );
  const repeated = { id: tasks[0].id, analysis: emptyAnalysis };
  await writeJsonl(join(run, "duplicate.jsonl"), [repeated, repeated]);
  await assert.rejects(
    joinAnalysis(join(run, "source_records.json"), join(run, "duplicate.jsonl"), join(run, "joined.json"), { allowPartial: true }),
    /Duplicate analysis ID/u,
  );
});

test("join rejects URLs inside model analysis", async () => {
  const { run, tasks } = await prepared();
  const withUrl = {
    id: tasks[0].id,
    analysis: {
      is_recruitment: false,
      listings: [],
      warnings: ["see_https://example.com"],
    },
  };
  await writeJsonl(join(run, "url.jsonl"), [withUrl]);
  await assert.rejects(
    joinAnalysis(join(run, "source_records.json"), join(run, "url.jsonl"), join(run, "joined.json"), { allowPartial: true }),
    /must not contain URLs/u,
  );
});
