import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseCsv, serializeCsv } from "./lib/csv.mjs";
import { readJson, writeJson } from "./lib/io.mjs";
import { assertQueryPlan } from "./lib/validation.mjs";

import { filterRows } from "./lib/query-core.mjs";

const CONTACT_SCORE = { direct: 30, source: 20, partial: 10, unavailable: 0 };

function rowScore(row, preferences) {
  let score = CONTACT_SCORE[row.contactability] ?? 0;
  if (preferences.beginner_friendly === true) score += row.beginner_friendly === "true" ? 15 : row.beginner_friendly === "false" ? -30 : 0;
  if (preferences.beginner_friendly === false) score += row.beginner_friendly === "false" ? 10 : 0;
  if (preferences.max_fee_twd !== null) {
    const maximum = row.fee_max_twd === "" ? null : Number(row.fee_max_twd);
    score += maximum === null ? -5 : maximum <= preferences.max_fee_twd ? 10 : -15;
  }
  score += row.status === "open" ? 5 : row.status === "unknown" ? 1 : 0;
  score += (Number(row.confidence) || 0) * 5;
  return score;
}

function compareRows(a, b) {
  return b._score - a._score
    || String(a.date || "9999-99-99").localeCompare(String(b.date || "9999-99-99"))
    || String(a.start_time || "99:99").localeCompare(String(b.start_time || "99:99"))
    || String(a.venue_name || "").localeCompare(String(b.venue_name || ""));
}

function publicRow(row) {
  const { _score, ...result } = row;
  return result;
}

export async function queryCsv(csvPath, planPath, outputCsvPath) {
  const [csvText, plan] = await Promise.all([readFile(resolve(csvPath), "utf8"), readJson(planPath)]);
  assertQueryPlan(plan);
  const { headers, rows } = parseCsv(csvText);
  const required = ["listing_id", "event_group_id", "status", "dedupe_status", "contactability", "primary_contact_label", "primary_contact_url"];
  const missingHeaders = required.filter((header) => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`CSV is missing required fields: ${missingHeaders.join(", ")}`);

  const filtered = filterRows(rows, plan).map((row) => ({ ...row, _score: rowScore(row, plan.preferences) })).sort(compareRows);

  const groupsById = new Map();
  for (const row of filtered) {
    const groupId = row.event_group_id || row.listing_id;
    const group = groupsById.get(groupId) ?? [];
    group.push(row);
    groupsById.set(groupId, group);
  }
  const groups = [...groupsById.entries()].map(([eventGroupId, variants]) => ({
    event_group_id: eventGroupId,
    score: Math.max(...variants.map(({ _score }) => _score)),
    primary: publicRow([...variants].sort(compareRows)[0]),
    variants: variants.map(publicRow),
  })).sort((a, b) => b.score - a.score
    || String(a.primary.date || "9999-99-99").localeCompare(String(b.primary.date || "9999-99-99"))
    || String(a.primary.start_time || "99:99").localeCompare(String(b.primary.start_time || "99:99")));

  const selectedGroupIds = new Set(groups.map(({ event_group_id }) => event_group_id));
  const sortedRows = groups.flatMap(({ variants }) => variants).filter((row) => selectedGroupIds.has(row.event_group_id || row.listing_id));
  const outputCsv = resolve(outputCsvPath);
  await writeFile(outputCsv, serializeCsv(headers, sortedRows.map((row) => headers.map((header) => row[header]))), "utf8");
  const outputJson = join(dirname(outputCsv), `${basename(outputCsv, extname(outputCsv))}.json`);
  await writeJson(outputJson, {
    generated_at: new Date().toISOString(),
    interpretation: plan.interpretation,
    total_rows: filtered.length,
    total_groups: groups.length,
    groups,
    filtered_csv: outputCsv,
  });
  return { csv: outputCsv, result: outputJson, total_rows: filtered.length, total_groups: groups.length };
}
