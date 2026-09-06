export function csvValue(value) {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value.join("|") : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

export function serializeCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
}

export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/u, "");
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      records.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/u, ""));
    records.push(row);
  }
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0];
  return {
    headers,
    rows: records.slice(1).filter((record) => record.some(Boolean)).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]))),
  };
}
