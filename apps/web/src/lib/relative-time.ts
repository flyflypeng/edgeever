const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 minutes ago", "yesterday 14:05", "3 days ago", then a calendar date. */
export const formatRelativeTime = (value: string, locale: string, now = new Date()) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = now.getTime() - date.getTime();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);

  if (diff < MINUTE_MS) return relative.format(0, "second");
  if (diff < HOUR_MS) return relative.format(-Math.floor(diff / MINUTE_MS), "minute");
  if (dayStart === startOfToday) return relative.format(-Math.floor(diff / HOUR_MS), "hour");
  if (dayStart === startOfToday - DAY_MS) return `${relative.format(-1, "day")} ${time}`;
  if (diff < 7 * DAY_MS) return relative.format(-Math.round((startOfToday - dayStart) / DAY_MS), "day");
  return new Intl.DateTimeFormat(locale, date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
};
