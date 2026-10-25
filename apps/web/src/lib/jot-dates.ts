// Local-calendar helpers for the Jot filters. Day keys are `YYYY-MM-DD` in the
// browser's local time zone; ranges are converted back to ISO for listMemos.

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (value: number) => String(value).padStart(2, "0");

export const formatLocalDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** Local `YYYY-MM-DD` for an ISO timestamp; empty string when the input is not a valid date. */
export const toLocalDayKey = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatLocalDayKey(date);
};

/** Parses a `YYYY-MM-DD` key into a local Date at 00:00, or null when the key is not a real calendar day. */
export const parseLocalDayKey = (dayKey: string): Date | null => {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) return null;
  return date;
};

/**
 * Local day [00:00, next day 00:00) as ISO timestamps. The next day is built from
 * local calendar fields rather than +24h so DST days span 23 or 25 hours.
 */
export const localDayRange = (dayKey: string): { createdFrom: string; createdTo: string } => {
  const start = parseLocalDayKey(dayKey);
  if (!start) throw new RangeError(`Invalid day key: ${dayKey}`);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { createdFrom: start.toISOString(), createdTo: end.toISOString() };
};

export type JotMonth = { year: number; monthIndex: number };

export const shiftMonth = (month: JotMonth, delta: number): JotMonth => {
  const date = new Date(month.year, month.monthIndex + delta, 1);
  return { year: date.getFullYear(), monthIndex: date.getMonth() };
};

export type JotCalendarDay = { key: string; day: number; inMonth: boolean };

/**
 * Monday-first grid for a month: leading days from the previous month, every day of
 * the month, then trailing days to complete the last week. Length is a multiple of 7.
 */
export const buildMonthGrid = (month: JotMonth): JotCalendarDay[] => {
  const { year, monthIndex } = month;
  const leading = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const total = Math.ceil((leading + daysInMonth) / 7) * 7;
  const cells: JotCalendarDay[] = [];
  for (let index = 0; index < total; index += 1) {
    // Date normalizes day overflow/underflow into the neighbouring months.
    const date = new Date(year, monthIndex, index - leading + 1);
    cells.push({ key: formatLocalDayKey(date), day: date.getDate(), inMonth: date.getMonth() === monthIndex });
  }
  return cells;
};

export type JotHeatLevel = 0 | 1 | 2 | 3;

/** Three heat tiers for the month calendar: 1–2, 3–5, 6+ notes. */
export const getJotHeatLevel = (count: number): JotHeatLevel => {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  return 3;
};
