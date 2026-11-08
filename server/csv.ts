// CSV in and out. Files come from spreadsheets: a byte order mark, commas or semicolons (Excel in Türkiye and Germany
// writes semicolons), quoted fields with line breaks and doubled quotes, and CRLF line ends are all read.

/** The rows of a CSV, the first being the header. Empty lines are left out. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = guessDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const end = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    end();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) end();
    else if (c === "\n") endRow();
    else if (c === "\r") {
      if (s[i + 1] !== "\n") endRow();
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** The delimiter of the header line: the one of , ; and tab it has most of, outside quotes. */
function guessDelimiter(s: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c in counts) counts[c]!++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ",";
}

/**
 * One CSV field. A value a spreadsheet would run as a formula (=, +, -, @, tab or carriage return first) gets a
 * leading apostrophe, so an exported segment cannot carry a formula into someone's spreadsheet.
 */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csvLine = (values: unknown[]) => values.map(csvField).join(",") + "\r\n";
