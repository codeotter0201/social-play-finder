export const PLAY_FORMATS = {
  doubles: "雙打", mens_doubles: "男雙", womens_doubles: "女雙", mixed_doubles: "混雙",
  singles: "單打", mens_singles: "男單", womens_singles: "女單",
};
export const SERVICE_TABLES = {
  venue_rental: { name: "venue_rentals", fields: ["rental_kind", "billing_unit", "transfer_terms"] },
  coaching: { name: "coaching_courses", fields: ["coach_name", "audience", "course_schedule", "lesson_count", "class_size", "billing_unit"] },
  tournament: { name: "tournaments", fields: ["event_name", "divisions", "registration_deadline", "event_end_date", "billing_unit"] },
};
export function playFormatValues(value) {
  if (value === "doubles") return ["doubles", "mens_doubles", "womens_doubles", "mixed_doubles"];
  if (value === "singles") return ["singles", "mens_singles", "womens_singles"];
  return [value];
}
