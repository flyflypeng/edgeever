import type { MemoActivityItem } from "@edgeever/shared";
import { Search, Tag, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { JotHeatmap } from "@/components/jot/JotHeatmap";
import { Button } from "@/components/ui/button";
import { toLocalDayKey } from "@/lib/jot-dates";
import { cn } from "@/lib/utils";

export type JotFiltersProps = {
  search: string;
  onSearchChange: (value: string) => void;
  activity: MemoActivityItem[] | undefined;
  activityLoading: boolean;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void; // local YYYY-MM-DD
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
  inboxName: string;
  className?: string;
};

export function JotFilters({
  search,
  onSearchChange,
  activity,
  activityLoading,
  selectedDay,
  onSelectDay,
  selectedTag,
  onSelectTag,
  inboxName,
  className,
}: JotFiltersProps) {
  const { t } = useTranslation();

  const { dayCounts, tagCounts } = useMemo(() => {
    const days = new Map<string, number>();
    const tags = new Map<string, number>();
    for (const item of activity ?? []) {
      const dayKey = toLocalDayKey(item.createdAt);
      if (dayKey) days.set(dayKey, (days.get(dayKey) ?? 0) + 1);
      for (const tag of new Set(item.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    const sortedTags = [...tags].sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB));
    return { dayCounts: days, tagCounts: sortedTags };
  }, [activity]);

  return (
    <div className={cn("flex min-w-0 flex-col gap-5 bg-[var(--workspace-memo-list)] p-4", className)}>
      <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-card px-2.5 text-slate-500 transition-colors focus-within:border-slate-400">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <input
          type="text"
          role="searchbox"
          value={search}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="search"
          spellCheck={false}
          aria-label={t("jot.filters.search")}
          placeholder={t("jot.filters.search")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-slate-900 outline-none placeholder:text-slate-400"
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search) {
              event.preventDefault();
              onSearchChange("");
            }
          }}
        />
        {search ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="-mr-1 text-slate-400 hover:text-slate-700"
            title={t("jot.filters.clearSearch")}
            aria-label={t("jot.filters.clearSearch")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSearchChange("")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <JotHeatmap dayCounts={dayCounts} loading={activityLoading} selectedDay={selectedDay} onSelectDay={onSelectDay} />

      <section className="min-w-0">
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <Tag className="h-3.5 w-3.5" aria-hidden="true" />
          {t("jot.filters.tags")}
        </h3>
        {tagCounts.length > 0 ? (
          <div className="flex flex-col gap-px">
            {tagCounts.map(([tag, count]) => {
              const selected = tag === selectedTag;
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={selected}
                  className={cn(
                    "flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded-[7px] px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20",
                    selected ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-[var(--workspace-hover)]",
                  )}
                  onClick={() => onSelectTag(selected ? null : tag)}
                >
                  <span aria-hidden="true">#</span>
                  <span className="min-w-0 truncate">{tag}</span>
                  <span className={cn("ml-auto shrink-0 text-xs tabular-nums", selected ? "opacity-70" : "text-slate-400")}>{count}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-[11.5px] leading-normal text-slate-400">{activityLoading ? t("jot.loading") : t("jot.filters.noTags")}</p>
        )}
      </section>

      <p className="text-[11.5px] leading-normal text-slate-400">{t("jot.filters.scopeNote", { name: inboxName })}</p>
    </div>
  );
}
