const NUMBER_FIELDS = new Set(["weekday", "fee_min_twd", "fee_max_twd", "skill_min", "skill_max", "end_day_offset"]);
const BOOLEAN_FIELDS = new Set(["beginner_friendly"]);
const ARRAY_FIELDS = new Set(["recurrence_weekdays", "registration_methods"]);

function fieldValue(row, field) {
  const raw = row[field];
  if (ARRAY_FIELDS.has(field)) return raw ? raw.split("|").filter(Boolean).map((value) => field === "recurrence_weekdays" ? Number(value) : value) : [];
  if (NUMBER_FIELDS.has(field)) return (raw === "" || raw === undefined) ? null : Number(raw);
  if (BOOLEAN_FIELDS.has(field)) return (raw === "" || raw === undefined) ? null : raw === "true";
  return (raw === "" || raw === undefined) ? null : raw;
}

function comparable(value, sample) {
  if (typeof sample === "number") return value === null || value === "" ? null : Number(value);
  if (typeof sample === "boolean") return value === true || value === "true";
  return value;
}

function evaluateCondition(row, condition) {
  const actual = fieldValue(row, condition.field);
  const expected = comparable(condition.value, actual);
  switch (condition.op) {
    case "eq": return actual !== null && actual === expected;
    case "neq": return actual !== null && actual !== expected;
    case "contains": return Array.isArray(actual) ? actual.includes(comparable(condition.value, actual[0])) : String(actual ?? "").includes(String(condition.value));
    case "in": return Array.isArray(condition.value) && condition.value.map((value) => comparable(value, actual)).includes(actual);
    case "lt": return actual !== null && actual < expected;
    case "lte": return actual !== null && actual <= expected;
    case "gt": return actual !== null && actual > expected;
    case "gte": return actual !== null && actual >= expected;
    case "includes_text": return String(actual ?? "").normalize("NFKC").toLocaleLowerCase("zh-Hant-TW").includes(String(condition.value).normalize("NFKC").toLocaleLowerCase("zh-Hant-TW"));
    case "is_known": return condition.value ? actual !== null && (!Array.isArray(actual) || actual.length > 0) : actual === null || (Array.isArray(actual) && actual.length === 0);
    default: throw new Error(`Unsupported operator: ${condition.op}`);
  }
}

function evaluateNode(row, node) {
  if ("all" in node) return node.all.every((child) => evaluateNode(row, child));
  if ("any" in node) return node.any.some((child) => evaluateNode(row, child));
  return evaluateCondition(row, node);
}

export function filterRows(rows, plan) {
  return rows.filter((row) => {
    if (!plan.include.duplicates && row.dedupe_status === "duplicate") return false;
    if (!plan.include.full && row.status === "full") return false;
    if (!plan.include.cancelled && row.status === "cancelled") return false;
    if (plan.preferences.require_contactable && row.contactability === "unavailable") return false;
    return evaluateNode(row, plan.where);
  });
}
