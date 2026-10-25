import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildMonthGrid, formatLocalDayKey, getJotHeatLevel, parseLocalDayKey, shiftMonth, type JotHeatLevel, type JotMonth } from "@/lib/jot-dates";
import { cn } from "@/lib/utils";

export type JotHeatmapProps = {
  /** Note count per local `YYYY-MM-DD`. */
  dayCounts: ReadonlyMap<string, number>;
  loading: boolean;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
  className?: string;
};

// Tailwind's emerald scale is mapped to --brand-green-*. The dark palette already
// re-tunes 100/700/900 for contrast; only the stronger tiers need dark overrides.
const HEAT_LEVEL_CLASS: Record<Exclude<JotHeatLevel, 0>, string> = {
  1: "bg-emerald-100 text-emerald-700",
  2: "bg-emerald-300 text-emerald-900 dark:bg-emerald-200",
  3: "bg-emerald-500 text-white dark:bg-emerald-300 dark:text-emerald-50",
};

// 2024-01-01 is a Monday; used to derive localized Monday-first weekday labels.
const MONDAY_REFERENCE = new Date(2024, 0, 1);

export function JotHeatmap({ dayCounts, loading, selectedDay, onSelectDay, className }: JotHeatmapProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const [month, setMonth] = useState<JotMonth>(() => {
    const date = (selectedDay && parseLocalDayKey(selectedDay)) || new Date();
    return { year: date.getFullYear(), monthIndex: date.getMonth() };
  });
  // Follow external day selection (e.g. a card's date) into its month.
  const [syncedDay, setSyncedDay] = useState(selectedDay);
  if (selectedDay !== syncedDay) {
    setSyncedDay(selectedDay);
    const date = selectedDay ? parseLocalDayKey(selectedDay) : null;
    if (date) setMonth({ year: date.getFullYear(), monthIndex: date.getMonth() });
  }

  const formatters = useMemo(
    () => ({
      title: new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: "narrow" }),
      day: new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }),
    }),
    [locale],
  );
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const date = new Date(MONDAY_REFERENCE.getFullYear(), MONDAY_REFERENCE.getMonth(), MONDAY_REFERENCE.getDate() + index);
        return { key: index, narrow: formatters.weekday.format(date) };
      }),
    [formatters],
  );

  const cells = useMemo(() => buildMonthGrid(month), [month]);
  const monthTotal = cells.reduce((sum, cell) => (cell.inMonth ? sum + (dayCounts.get(cell.key) ?? 0) : sum), 0);
  const todayKey = formatLocalDayKey(new Date());

  return (
    <section className={cn("min-w-0", className)}>
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold text-slate-900" aria-live="polite">
          {formatters.title.format(new Date(month.year, month.monthIndex, 1))}
        </h3>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t("jot.filters.previousMonth")}
            aria-label={t("jot.filters.previousMonth")}
            onClick={() => setMonth((current) => shiftMonth(current, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t("jot.filters.nextMonth")}
            aria-label={t("jot.filters.nextMonth")}
            onClick={() => setMonth((current) => shiftMonth(current, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        className={cn("grid grid-cols-7 justify-items-center gap-1 transition-opacity", loading && "opacity-60")}
        aria-busy={loading || undefined}
      >
        {weekdays.map((weekday) => (
          <span key={weekday.key} className="text-[11px] leading-5 text-slate-400" aria-hidden="true">
            {weekday.narrow}
          </span>
        ))}
        {cells.map((cell) => {
          const count = cell.inMonth ? (dayCounts.get(cell.key) ?? 0) : 0;
          const level = getJotHeatLevel(count);
          const isToday = cell.key === todayKey;
          const selected = cell.inMonth && cell.key === selectedDay;
          const cellClass = cn(
            "relative grid size-7 place-items-center rounded-full text-[11.5px] tabular-nums text-slate-400",
            !cell.inMonth && "opacity-45",
            level !== 0 && HEAT_LEVEL_CLASS[level],
            isToday &&
              "after:absolute after:-bottom-[3px] after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-[var(--brand-green)] after:content-['']",
            selected && "ring-2 ring-[var(--brand-green)] ring-offset-2 ring-offset-[var(--workspace-memo-list)]",
          );

          // A selected day stays a button even after its notes leave the inbox, so it can be cleared here.
          if (level === 0 && !selected) {
            return (
              <span key={cell.key} className={cellClass}>
                {cell.day}
              </span>
            );
          }

          const label = t("jot.filters.dayCount", { date: formatters.day.format(parseLocalDayKey(cell.key) ?? new Date()), count });
          return (
            <Tooltip key={cell.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    cellClass,
                    "transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-green)]",
                  )}
                  aria-pressed={selected}
                  aria-label={label}
                  onClick={() => onSelectDay(selected ? null : cell.key)}
                >
                  {cell.day}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-400">
        <span>{t("jot.filters.monthTotal", { count: monthTotal })}</span>
        <span className="flex items-center gap-[3px]" aria-hidden="true">
          {t("jot.filters.less")}
          {([1, 2, 3] as const).map((level) => (
            <i key={level} className={cn("inline-block size-2.5 rounded-full", HEAT_LEVEL_CLASS[level])} />
          ))}
          {t("jot.filters.more")}
        </span>
      </div>
    </section>
  );
}
