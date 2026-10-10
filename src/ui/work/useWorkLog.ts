import { useCallback, useState } from "react";

/**
 * Which tasks you've shipped, today and before, kept in this browser so the board can put fresh
 * tasks first and show today's progress. A convenience only: it pays nothing by itself, and the
 * server caps what a work day can claim.
 */
const STORAGE_KEY = "sev1.work.v1";

type Log = { readonly days: Readonly<Record<string, readonly string[]>> };

function load(): Log {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && "days" in parsed && typeof parsed.days === "object" && parsed.days) return parsed as Log;
  } catch {
    // Blocked or corrupt storage: start an empty log.
  }
  return { days: {} };
}

function save(log: Log) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    // The log is a convenience; losing it only reorders the board.
  }
}

export function useWorkLog(day: string) {
  const [log, setLog] = useState<Log>(load);
  const shippedToday = new Set(log.days[day] ?? []);
  const finishedBefore = new Set(Object.entries(log.days).flatMap(([logged, ids]) => (logged === day ? [] : ids)));
  const ship = useCallback(
    (taskId: string) =>
      setLog((current) => {
        const today = current.days[day] ?? [];
        if (today.includes(taskId)) return current;
        const next = { days: { ...current.days, [day]: [...today, taskId] } };
        save(next);
        return next;
      }),
    [day],
  );
  return { shippedToday, finishedBefore, ship };
}
