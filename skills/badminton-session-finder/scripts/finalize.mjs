import { PLAY_FORMATS, SERVICE_TABLES } from "./lib/listing-types.mjs";
import { randomUUID } from "node:crypto";
import { normalizeTimestamp } from "../../../scripts/post-archive/archive.mjs";
import { mkdir, writeFile, rename, symlink, lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildContact, priceDisplay } from "./lib/contacts.mjs";
import { serializeCsv } from "./lib/csv.mjs";
import { applyDedupeRules } from "./lib/dedupe.mjs";
import { createListingId } from "./lib/ids.mjs";
import { assertAnalysisMatchesSource, qualityWarnings } from "./lib/validation.mjs";
import { buildBrowser } from "./browser.mjs";
import { readJson, writeJson } from "./lib/io.mjs";

export const CSV_HEADERS = [
  "listing_id", "source_post_id", "source_file", "batch_id", "raw_batch_id", "group_id", "group_name", "group_url",
  "source_post_index", "post_id", "post_url", "author_name", "author_url", "published_at", "published_time_raw",
  "scraped_at", "content_is_truncated", "source_warnings", "date", "weekday", "recurrence_weekdays", "start_time", "end_time",
  "timezone", "title", "team_name", "venue_name", "address", "city", "district", "status", "vacancies", "capacity",
  "court_count", "shuttlecock", "amenities", "skill_description", "skill_min", "skill_max", "beginner_friendly",
  "price_options_json", "fee_min_twd", "fee_max_twd", "price_display", "registration_methods",
  "registration_instructions", "line_id", "phone", "registration_urls", "primary_contact_method",
  "primary_contact_label", "primary_contact_url", "contactability", "contact_links_json", "confidence", "warnings",
  "event_group_id", "dedupe_status", "duplicate_of", "dedupe_candidates", "dedupe_match_reasons", "raw_text", "search_text", "end_day_offset", "post_key", "observation_id", "latest_observation_id", "source_stale", "needs_review", "listing_type", "play_format",
];

function normalizeSearchText(parts) {
  return parts.filter(Boolean).join(" ").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-Hant-TW");
}

export function listingToCsvRow(item) {
  const source = item.source;
  return [
    item.listing_id, item.source_post_id, source.source_file, source.batch_id, source.raw_batch_id, source.group_id,
    source.group_name, source.group_url, source.source_post_index, source.post_id, source.post_url, source.author_name,
    source.author_url, source.published_at, source.published_time_raw, source.scraped_at, source.content_is_truncated,
    source.warnings, item.schedule.date, item.weekday, item.schedule.recurrence?.weekdays ?? [], item.schedule.start_time,
    item.schedule.end_time, item.schedule.timezone, item.title, item.team_name, item.venue.name, item.venue.address,
    item.venue.city, item.venue.district, item.availability.status, item.availability.vacancies, item.availability.capacity,
    item.court_count, item.shuttlecock, item.amenities, item.skill.description, item.skill.min_level, item.skill.max_level,
    item.skill.beginner_friendly, JSON.stringify(item.price_options), item.fee_min_twd, item.fee_max_twd, item.price_display,
    item.registration.methods, item.registration.instructions, item.registration.line_id, item.registration.phone,
    JSON.stringify(item.contact.registration_urls), item.contact.primary_method, item.contact.primary_label,
    item.contact.primary_url, item.contact.contactability, JSON.stringify(item.contact.links), item.quality.confidence,
    item.quality.warnings, item.event_group_id, item.dedupe.status, item.dedupe.duplicate_of, item.dedupe.candidate_ids,
    item.dedupe.match_reasons, item.raw_text, item.search_text, item.schedule.end_day_offset,
    source.post_key, source.observation_id, source.latest_observation_id, source.stale, item.quality.needs_review, item.listing_type, item.play_format,
  ];
}

function countBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]));
}

export function buildFinalized(joined, { publicationId = randomUUID(), generatedAt = new Date().toISOString(), joinedPath = null } = {}) {
  if (!Array.isArray(joined?.batches) || !Array.isArray(joined?.posts)) throw new Error("joined_records.json must contain batches[] and posts[]");
  if (new Set(joined.posts.map(({ id }) => id)).size !== joined.posts.length) throw new Error("Duplicate joined post IDs");
  const batchById = new Map(joined.batches.map((batch) => [batch.id, batch]));
  if (batchById.size !== joined.batches.length) throw new Error("Duplicate joined batch IDs");
  const allListings = [];

  for (const post of joined.posts) {
    if (post.analysis) assertAnalysisMatchesSource({ id: post.id, analysis: post.analysis }, post.context?.text);
    const batch = batchById.get(post.batch_id);
    if (!batch) throw new Error(`Post ${post.id} references unknown batch ${post.batch_id}`);
    if (!post.analysis?.is_recruitment) continue;
    for (const analysisListing of post.analysis.listings) {
      const { confidence = null, warnings, evidence = [], ...semantic } = analysisListing;
      const fees = semantic.price_options.map(({ amount }) => amount);
      const contact = buildContact(semantic.registration, post.links, post.raw?.author_name ?? null);
      const source = {
        post_key: post.origin?.post_key ?? null,
        observation_id: post.origin?.observation_id ?? null,
        latest_observation_id: post.publication?.latest_observation_id ?? post.origin?.observation_id ?? null,
        stale: Boolean(post.publication?.stale),
        task_id: post.id,
        origin_warnings: post.origin?.warnings ?? [],
        source_file: post.source_file,
        batch_id: post.batch_id,
        raw_batch_id: batch.raw?.batch_id ?? null,
        group_id: batch.raw?.group_id ?? null,
        group_name: post.raw?.group_name ?? batch.raw?.group_name ?? null,
        group_url: post.raw?.group_url ?? batch.raw?.group_url ?? null,
        source_post_index: post.source_post_index,
        post_id: post.raw?.post_id ?? null,
        post_url: post.links?.post?.raw_url ?? post.raw?.post_url ?? null,
        author_name: post.raw?.author_name ?? null,
        author_url: post.links?.author?.raw_url ?? post.raw?.author_url ?? null,
        published_at: normalizeTimestamp(post.raw?.published_at),
        published_time_raw: post.raw?.published_time_raw ?? null,
        scraped_at: normalizeTimestamp(post.raw?.scraped_at),
        content_is_truncated: post.raw?.content_is_truncated ?? null,
        warnings: post.raw?.warnings ?? [],
      };
      const item = {
        listing_id: createListingId(post.id, analysisListing),
        source_post_id: post.id,
        source,
        title: null,
        notes: [],
        ...semantic,
        listing_type: semantic.listing_type ?? null,
        play_format: semantic.play_format ?? null,
        service_details: semantic.service_details ?? null,
        fee_min_twd: fees.length ? Math.min(...fees) : null,
        fee_max_twd: fees.length ? Math.max(...fees) : null,
        price_display: priceDisplay(semantic.price_options),
        contact,
        quality: {
          confidence,
          warnings: qualityWarnings({ ...post, analysis: { ...post.analysis, listings: [analysisListing] } }),
          needs_review: qualityWarnings({ ...post, analysis: { ...post.analysis, listings: [analysisListing] } }).some((code) => code !== "not_recruitment"),
          evidence,
        },
        raw_text: post.raw?.content_text ?? "",
      };
      item.weekday = item.schedule.date ? new Date(`${item.schedule.date}T00:00:00Z`).getUTCDay() : null;
      item.search_text = normalizeSearchText([
        item.title, item.team_name, item.venue.name, item.venue.address, item.venue.city, item.venue.district,
        item.skill.description, item.price_display, item.registration.instructions, item.registration.line_id,
        item.registration.phone, source.author_name, item.raw_text, PLAY_FORMATS[item.play_format],
      ]);
      allListings.push(item);
    }
  }

  applyDedupeRules(allListings);
  const listings = allListings.filter(item => !item.listing_type || item.listing_type === "session");
  const tables = Object.fromEntries(Object.entries(SERVICE_TABLES).map(([type, {name}]) => [name, allListings.filter(item => item.listing_type === type)]));
  const stats = {
    source_batches: joined.batches.length,
    source_posts: joined.posts.length,
    analyzed_posts: joined.posts.filter(({ analysis }) => analysis).length,
    recruitment_posts: joined.posts.filter(({ analysis }) => analysis?.is_recruitment).length,
    non_recruitment_posts: joined.posts.filter(({ analysis }) => analysis && !analysis.is_recruitment).length,
    unanalyzed_posts: joined.posts.filter(({ analysis }) => !analysis).length,
    listings: listings.length,
    total_records: allListings.length,
    tables: Object.fromEntries(Object.entries(tables).map(([name, records]) => [name, records.length])),
    duplicates: listings.filter(({ dedupe }) => dedupe.status === "duplicate").length,
    possible_duplicates: listings.filter(({ dedupe }) => dedupe.status === "possible_duplicate").length,
    contactability: countBy(listings.map(({ contact }) => contact.contactability)),
  };
  const result = {
    schema_version: "badminton-output-2",
    publication_id: publicationId,
    generated_at: generatedAt,
    contract: joined.contract ?? null,
    source_batches: joined.batches.map(({ id, source_file, raw }) => ({ id, source_file, batch: raw })),
    source_posts: joined.posts,
    listings,
    tables,
    stats,
  };
  const report = {
    schema_version: "badminton-output-2",
    publication_id: publicationId,
    generated_at: generatedAt,
    joined_file: joinedPath ? resolve(joinedPath) : null,
    tasks: joined.task_report ?? null,
    partial: Boolean(joined.join_report?.partial),
    missing_ids: joined.join_report?.missing_ids ?? [],
    stats,
    warnings: countBy(allListings.flatMap(({ quality }) => quality.warnings)),
  };
  const tableFiles = {};
  for (const {name, fields} of Object.values(SERVICE_TABLES)) {
    const records = tables[name];
    tableFiles[name + ".json"] = JSON.stringify({schema_version: result.schema_version, publication_id: publicationId, generated_at: generatedAt, listings: records}, null, 2) + "\n";
    const headers = ["listing_id", "source_post_id", "listing_type", "play_format", "date", "start_time", "end_time", "end_day_offset", "recurrence_weekdays", "venue_name", "address", "court_count", ...fields, "price_options_json", "price_display", "registration_instructions", "line_id", "phone", "post_url", "author_url", "author_name", "raw_text", "group_name", "scraped_at", "event_group_id", "status", "dedupe_status", "contactability", "primary_contact_label", "primary_contact_url", "fee_min_twd", "fee_max_twd", "search_text"];
    tableFiles[name + ".csv"] = serializeCsv(headers, records.map(item => [
      item.listing_id, item.source_post_id, item.listing_type, item.play_format, item.schedule.date, item.schedule.start_time, item.schedule.end_time, item.schedule.end_day_offset, item.schedule.recurrence?.weekdays ?? [],
      item.venue.name, item.venue.address, item.court_count, ...fields.map(field => item.service_details[field]),
      JSON.stringify(item.price_options), item.price_display, item.registration.instructions, item.registration.line_id, item.registration.phone, item.source.post_url, item.source.author_url, item.source.author_name, item.raw_text, item.source.group_name, item.source.scraped_at, item.event_group_id, item.availability.status, item.dedupe.status, item.contact.contactability, item.contact.primary_label, item.contact.primary_url, item.fee_min_twd, item.fee_max_twd, item.search_text,
    ]));
  }
  return { result, report, csv: serializeCsv(CSV_HEADERS, listings.map(listingToCsvRow)), tableFiles };
}

// Readers resolve current once and consume that immutable release. The pointer is
// replaced only after every product, including the browser, is complete.
export async function finalizeJoined(joinedPath, outputDirectory, { beforeActivate, publicationId = randomUUID() } = {}) {
  const joined = await readJson(joinedPath);
  const output = resolve(outputDirectory);
  const release = join(output, "releases", publicationId);
  const documents = buildFinalized(joined, { joinedPath, publicationId });
  await mkdir(release, { recursive: true });
  await writeJson(join(release, "joined_records.json"), joined);
  await writeJson(join(release, "output_result.json"), documents.result);
  await writeJson(join(release, "run_report.json"), documents.report);
  await writeFile(join(release, "output_result.csv"), documents.csv, "utf8");
  for (const [name, contents] of Object.entries(documents.tableFiles)) await writeFile(join(release, name), contents, "utf8");
  await buildBrowser(documents.result, documents.csv, join(release, "index.html"));
  // A legacy output directory must be migrated explicitly, never silently overwritten.
  for (const name of ["output_result.json", "output_result.csv", "run_report.json", "index.html", ...Object.keys(documents.tableFiles)]) {
    const path = join(output, name);
    const stat = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (stat && (!stat.isSymbolicLink() || await readlink(path) !== `current/${name}`)) {
      throw new Error(`Existing output ${path} is not a managed publication; choose a fresh output directory (existing data preserved)`);
    }
    if (!stat) await symlink(`current/${name}`, path);
  }
  if (beforeActivate) await beforeActivate({ release, ...documents });
  const temporary = join(output, `.current-${publicationId}`);
  await symlink(`releases/${publicationId}`, temporary);
  await rename(temporary, join(output, "current"));
  return {
    output: join(release, "output_result.json"), csv: join(release, "output_result.csv"), report: join(release, "run_report.json"),
    tables: Object.fromEntries(Object.keys(documents.tableFiles).map(name => [name, join(release, name)])),
    page: join(release, "index.html"), current: join(output, "current"), publication_id: publicationId, stats: documents.result.stats,
  };
}
