/**
 * A minimal RFC 4180 CSV reader.
 *
 * Hand-written rather than pulled in as a dependency because the format is
 * small and the one feature that matters is quoted fields containing commas —
 * which these files are full of, since every price bucket looks like
 * `"65,000 to 69,999.99"`. A naive split on commas silently shreds them.
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];

  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const row: CsvRow = {};
    header.forEach((name, index) => {
      row[name] = (cells[index] ?? '').trim();
    });
    return row;
  });
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // Normalize line endings first so CRLF files do not leave stray \r in values.
  const input = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      field = '';
      // Skip blank lines rather than emitting an empty record for each.
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}
