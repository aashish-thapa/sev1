/** A calendar day in the player's own time zone, formatted YYYY-MM-DD. */
export type LocalDate = string & { readonly brand: "LocalDate" };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseLocalDate(value: string): LocalDate {
  if (!ISO_DAY.test(value)) throw new RangeError(`not a YYYY-MM-DD date: ${value}`);
  return value as LocalDate;
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  // en-CA formats as YYYY-MM-DD, which keeps this free of manual padding.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return parseLocalDate(formatted);
}

export function previousDay(day: LocalDate): LocalDate {
  const [year, month, date] = day.split("-").map(Number);
  const utcNoon = Date.UTC(year, month - 1, date, 12);
  return parseLocalDate(new Date(utcNoon - 86_400_000).toISOString().slice(0, 10));
}
