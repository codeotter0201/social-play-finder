export function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCount(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.replace(/,/g, "").trim();
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(萬|万|K|k|M|m)?$/u);
  if (!match) return null;
  const number = Number(match[1]);
  const multiplier = match[2] === "萬" || match[2] === "万" ? 10_000 : /k/i.test(match[2] ?? "") ? 1_000 : /m/i.test(match[2] ?? "") ? 1_000_000 : 1;
  const result = number * multiplier;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export function normalizeAbsoluteTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function normalizedFingerprintPart(value: string | null): string {
  return cleanText(value).toLocaleLowerCase().normalize("NFKC");
}

export function makeFingerprint(author: string | null, time: string | null, content: string): string {
  return `${normalizedFingerprintPart(author)}\u001f${normalizedFingerprintPart(time)}\u001f${normalizedFingerprintPart(content)}`;
}
