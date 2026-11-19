const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function escapeCsvCell(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let str = raw instanceof Date ? raw.toISOString() : String(raw);

  // Neutralize spreadsheet formula injection (Excel / LibreOffice / Google Sheets)
  // Check both raw start and trimmed start so leading spaces before '=' cannot bypass
  if (FORMULA_TRIGGER.test(str) || FORMULA_TRIGGER.test(str.trimStart())) {
    str = `'${str}`;
  }

  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r') || str.startsWith("'")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildRfc4180Csv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function sanitizeCsvFilename(slug: string, suffix: string): string {
  const safe = slug.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'competition';
  return `${safe}-${suffix}.csv`;
}
