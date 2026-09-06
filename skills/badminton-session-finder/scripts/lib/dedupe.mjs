import { hashId } from "./ids.mjs";

function normalizeIdentity(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant-TW")
    .replace(/^\d{3}(?=新北市|臺北市|台北市|桃園市)/u, "")
    .replace(/[\s_（）()。．·・,，、:：/／\\-]+/gu, "")
    .trim();
}

function scheduleIdentity(schedule) {
  const occurrence = schedule?.date
    ? `date:${schedule.date}`
    : schedule?.recurrence?.weekdays?.length
      ? `weekly:${[...schedule.recurrence.weekdays].sort((a, b) => a - b).join("-")}`
      : "";
  if (!occurrence || !schedule?.start_time || !schedule?.end_time) return null;
  return `${occurrence}|${schedule.start_time}|${schedule.end_time}|${schedule.end_day_offset ?? 0}`;
}

function venueIdentity(venue) {
  const address = normalizeIdentity(venue?.address);
  if (address) return `address:${address}`;
  const name = normalizeIdentity(venue?.name);
  if (!name) return null;
  return `name:${normalizeIdentity(venue?.city)}:${normalizeIdentity(venue?.district)}:${name}`;
}

function organizerIdentities(listing) {
  return [
    ["team", listing.team_name],
    ["line", listing.registration?.line_id],
    ["phone", listing.registration?.phone],
  ].filter(([, value]) => normalizeIdentity(value)).map(([kind, value]) => `${kind}:${normalizeIdentity(value)}`);
}

export function applyDedupeRules(listings) {
  const groups = new Map();
  for (const listing of listings) {
    const schedule = scheduleIdentity(listing.schedule);
    const venue = venueIdentity(listing.venue);
    const scope = listing.listing_type && listing.listing_type !== "session" ? listing.listing_type : "";
    const rawKey = schedule && venue ? `${scope ? scope + "|" : ""}${schedule}|${venue}${listing.play_format ? "|" + listing.play_format : ""}` : null;
    const organizers = organizerIdentities(listing);
    listing.event_group_id = rawKey ? hashId("event", [rawKey]) : null;
    listing.dedupe = {
      status: "unique",
      key_complete: Boolean(rawKey),
      duplicate_of: null,
      candidate_ids: [],
      match_reasons: [],
    };
    if (!rawKey) continue;
    const group = groups.get(rawKey) ?? [];
    group.push({ listing, organizers, content: normalizeIdentity(listing.raw_text) });
    groups.set(rawKey, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let index = 1; index < group.length; index += 1) {
      const current = group[index];
      const earlier = group.slice(0, index);
      const strongMatch = earlier.find((candidate) =>
        candidate.listing.source_post_id === current.listing.source_post_id
        || current.organizers.some((organizer) => candidate.organizers.includes(organizer))
        || (current.content && candidate.content === current.content));
      if (strongMatch) {
        current.listing.dedupe.status = "duplicate";
        current.listing.dedupe.duplicate_of = strongMatch.listing.listing_id;
        current.listing.dedupe.match_reasons = [
          "same_schedule",
          "same_venue",
          strongMatch.listing.source_post_id === current.listing.source_post_id
            ? "same_source_post"
            : current.organizers.some((organizer) => strongMatch.organizers.includes(organizer))
              ? "same_organizer"
              : "same_source_content",
        ];
        continue;
      }
      current.listing.dedupe.status = "possible_duplicate";
      current.listing.dedupe.candidate_ids = earlier.map(({ listing }) => listing.listing_id);
      current.listing.dedupe.match_reasons = ["same_schedule", "same_venue"];
      for (const candidate of earlier) {
        if (candidate.listing.dedupe.status !== "unique") continue;
        candidate.listing.dedupe.status = "possible_duplicate";
        candidate.listing.dedupe.candidate_ids = group.filter((item) => item !== candidate).map(({ listing }) => listing.listing_id);
        candidate.listing.dedupe.match_reasons = ["same_schedule", "same_venue"];
      }
    }
  }
  return listings;
}
