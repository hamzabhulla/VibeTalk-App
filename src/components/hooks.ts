import { useEffect, useState } from "react";

// Minimal structural type so we don't import rxjs directly (it is only a
// transitive dependency of WatermelonDB).
type ObservableLike<T> = {
  subscribe: (next: (value: T) => void) => { unsubscribe: () => void };
};

// Minimal observe() -> state bridge for Watermelon queries.
// `observable` MUST be memoised by the caller (useMemo) - a new object on
// every render would resubscribe in a loop.
export function useObserved<T>(observable: ObservableLike<T[]> | null): T[] {
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    if (!observable) {
      setRows([]);
      return;
    }
    const sub = observable.subscribe((next) => setRows(next as T[]));
    return () => sub.unsubscribe();
  }, [observable]);
  return rows;
}

export function formatListTime(ms?: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    let h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${min} ${ampm}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function formatBubbleTime(date: Date): string {
  let h = date.getHours();
  const min = String(date.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}
