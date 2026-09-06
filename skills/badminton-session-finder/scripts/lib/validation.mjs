import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const directory = dirname(fileURLToPath(import.meta.url));
const references = join(directory, "..", "..", "references");
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const extractionSchema = JSON.parse(readFileSync(join(references, "extraction.schema.json"), "utf8"));
const querySchema = JSON.parse(readFileSync(join(references, "query.schema.json"), "utf8"));
const validateExtractionSchema = ajv.compile(extractionSchema);
const serviceValidators = Object.fromEntries(["venue_rental", "coaching", "tournament"].map((type, index) => [type, ajv.compile({$defs: extractionSchema.$defs, $ref: "#/$defs/" + ["rentalDetails", "coachingDetails", "tournamentDetails"][index]})]));
const validateQuerySchema = ajv.compile(querySchema);

function formatErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

export function assertExtractionResult(value) {
  if (/https?:\/\//iu.test(JSON.stringify(value?.analysis))) throw new Error(`Result ${value?.id} analysis must not contain URLs`);
  if (!validateExtractionSchema(value)) throw new Error(`Result ${value?.id}: Invalid LLM result: ${formatErrors(validateExtractionSchema.errors)}. Revalidate/re-extract using extraction_contract.json (contract v2); do not synthesize evidence.`);
}

export function assertQueryPlan(value) {
  if (!validateQuerySchema(value)) throw new Error(`Invalid query plan: ${formatErrors(validateQuerySchema.errors)}`);
}

export function assertTaskShape(task) {
  const keys = Object.keys(task ?? {}).sort();
  if (keys.join(",") !== "context,id") throw new Error(`LLM task must contain only id and context; got ${keys.join(",") || "no fields"}`);
  const contextKeys = Object.keys(task.context ?? {}).sort();
  if (!["is_truncated,reference_time,text,timezone", "is_truncated,published_at,reference_time,reference_time_source,scraped_at,text,timezone"].includes(contextKeys.join(","))) throw new Error(`Task context has unexpected fields: ${contextKeys.join(",")}`);
  if (typeof task.id !== "string" || typeof task.context.text !== "string") throw new Error("Task id and context.text are required strings");
}

export function assertAnalysisMatchesSource(result, sourceText) {
  assertExtractionResult(result);
  if (typeof sourceText !== "string") throw new Error(`Result ${result.id}: missing source context.text`);
  if (result.analysis.is_recruitment && !result.analysis.listings.length && !result.analysis.warnings.includes("insufficient_information")) {
    throw new Error(`Result ${result.id}: recruitment with no listings requires insufficient_information`);
  }
  for (const [index, listing] of result.analysis.listings.entries()) {
    const fail = (field, message) => { throw new Error(`Result ${result.id} /analysis/listings/${index}/${field}: ${message}; revalidate/re-extract with the current contract`); };
    if (serviceValidators[listing.listing_type]) {
      const validateService = serviceValidators[listing.listing_type];
      if (!validateService(listing.service_details)) fail("service_details", "details do not match listing_type");
    } else if (listing.service_details != null) fail("service_details", "session or unclassified listing cannot carry service details");
    if (listing.listing_index !== index) fail("listing_index", "must be continuous from zero");
    if (listing.evidence !== undefined) {
    const facts = new Map();
    function leaves(value, path) {
      if (value === null || value === "" || value === "unknown") return;
      if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key);
      } else facts.set(path, value);
    }
    for (const field of ["schedule", "venue", "price_options", "skill", "availability", "registration", "court_count", "shuttlecock", "amenities", "title", "team_name", "notes"]) leaves(listing[field], field);
    const supported = new Set();
    for (const evidence of listing.evidence) {
      const path = evidence.field.replace(/\[(\d+)\]/g, ".$1");
      if (!facts.has(path)) fail(`evidence/${evidence.field}`, "evidence field must refer to an actually filled leaf value");
      if (!evidence.quote.trim() || !sourceText.includes(evidence.quote)) fail(`evidence/${evidence.field}`, `evidence quote is not present in source: ${evidence.quote}`);
      supported.add(path);
    }
    const derived = (path) => path === "schedule.timezone" || path === "schedule.recurrence.frequency" || /price_options\.\d+\.currency$/.test(path) || (path === "schedule.end_day_offset" && listing.schedule.end_day_offset === 0);
    for (const path of facts.keys()) {
      if (/^(title|team_name|notes)(\.|$)/.test(path) || derived(path)) continue;
      if (!supported.has(path)) fail(path, "missing field evidence");
    }
    if (facts.size && listing.evidence.length === 0) fail("evidence", "empty evidence cannot substantiate filled facts");
    }
    const schedule = listing.schedule;
    if (schedule.date) {
      const date = new Date(`${schedule.date}T00:00:00Z`);
      if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== schedule.date) fail("schedule/date", "invalid calendar date");
      if (schedule.recurrence && !schedule.recurrence.weekdays.includes(date.getUTCDay())) fail("schedule/recurrence", "date and recurrence weekday conflict");
    }
    if (listing.listing_type === "tournament") {
      for (const field of ["registration_deadline", "event_end_date"]) {
        const value = listing.service_details[field];
        if (value && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail("service_details/" + field, "invalid calendar date");
      }
      if (schedule.date && listing.service_details.event_end_date && listing.service_details.event_end_date < schedule.date) fail("service_details/event_end_date", "event ends before it starts");
    }
    if (schedule.start_time && schedule.end_time) {
      if (schedule.end_day_offset === null) fail("schedule/end_day_offset", "known start and end require an explicit day offset");
      const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
      const duration = minutes(schedule.end_time) + 1440 * schedule.end_day_offset - minutes(schedule.start_time);
      if (duration <= 0 || duration > 1440) fail("schedule/end_time", "invalid time or overnight relationship (duration must be 1..1440 minutes)");
    } else if (schedule.end_day_offset !== null) fail("schedule/end_day_offset", "unknown start/end requires null offset");
    if (listing.skill.min_level !== null && listing.skill.max_level !== null && listing.skill.min_level > listing.skill.max_level) fail("skill", "min_level exceeds max_level");
    const availability = listing.availability;
    if (availability.vacancies !== null && availability.capacity !== null && availability.vacancies > availability.capacity) fail("availability", "vacancies exceed capacity");
    if (availability.status === "full" && availability.vacancies > 0) fail("availability", "full status conflicts with positive vacancies");
    for (const key of ["line_id", "phone"]) {
      if (listing.registration[key] && !sourceText.includes(listing.registration[key])) fail(`registration/${key}`, `${key} is not present in source`);
    }
  }
}

export function qualityWarnings(post) {
  const codes = new Set([...(post.analysis?.warnings ?? []), ...(post.origin?.warnings ?? [])]);
  if (post.raw?.content_is_truncated) codes.add("source_content_truncated");
  if (post.context && Object.hasOwn(post.context, "scraped_at") && !post.context.scraped_at) codes.add("invalid_scraped_at");
  for (const listing of post.analysis?.listings ?? []) {
    for (const code of listing.warnings) codes.add(code);
    if (!listing.schedule.date && !listing.schedule.recurrence) codes.add("missing_date");
    if (!listing.schedule.start_time || !listing.schedule.end_time) codes.add("missing_time");
    if (!Object.values(listing.venue).some(Boolean)) codes.add("missing_venue");
    if (!listing.price_options.length) codes.add("missing_price");
    if ((!listing.listing_type || listing.listing_type === "session") && !Object.values(listing.skill).some((value) => value !== null)) codes.add("missing_skill");
    if (!listing.registration.methods.length) codes.add("missing_contact");
  }
  return [...codes];
}
