/** psql's aligned output: centred headers, right-aligned numbers, row count footer. */
export function sqlTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  const isNumeric = headers.map((_, column) => rows.length > 0 && rows.every((row) => /^-?\d+(\.\d+)?$/.test(row[column])));
  const centre = (text: string, width: number) => {
    const left = Math.floor((width - text.length) / 2);
    return " ".repeat(left) + text + " ".repeat(width - text.length - left);
  };
  return [
    headers.map((header, column) => ` ${centre(header, widths[column])} `).join("|"),
    widths.map((width) => "-".repeat(width + 2)).join("+"),
    ...rows.map((row) =>
      row.map((cell, column) => ` ${isNumeric[column] ? cell.padStart(widths[column]) : cell.padEnd(widths[column])} `).join("|").trimEnd(),
    ),
    `(${rows.length} ${rows.length === 1 ? "row" : "rows"})`,
    "",
  ];
}
