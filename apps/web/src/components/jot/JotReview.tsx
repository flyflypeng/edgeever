import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { History, LoaderCircle, Shuffle } from "lucide-react";
import type { MemoActivityItem, MemoDetail, Notebook } from "@edgeever/shared";
import { JotCard } from "@/components/jot/JotCard";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getJotDisplayMarkdown } from "@/lib/jot-markdown";
import type { EdgeEverRepository } from "@/lib/repository";

// Keeps "on this day" bounded for workspaces with many notes on one date.
const ON_THIS_DAY_LIMIT = 60;

type ReviewMode = "on-this-day" | "random";

export type JotReviewProps = {
  repository: EdgeEverRepository;
  notebooks: Notebook[];
  onOpenMemo: (memoId: string) => void;
};

const loadDetails = async (repository: EdgeEverRepository, items: MemoActivityItem[]) => {
  const results = await Promise.allSettled(items.map((item) => repository.getMemo(item.id)));
  return results.flatMap((result) => (result.status === "fulfilled" && !result.value.memo.isDeleted
    ? [{ ...result.value.memo, contentMarkdown: getJotDisplayMarkdown(result.value.memo) }]
    : []));
};

const pickRandomId = (items: MemoActivityItem[], excludeId: string | null) => {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!.id;
  let next = excludeId;
  while (next === excludeId) next = items[Math.floor(Math.random() * items.length)]!.id;
  return next;
};

const ReviewMessage = ({ children }: { children: string }) => (
  <div className="px-4 py-14 text-center text-[13px] text-slate-500">{children}</div>
);

export const JotReview = ({ repository, notebooks, onOpenMemo }: JotReviewProps) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [mode, setMode] = useState<ReviewMode>("on-this-day");
  const [randomId, setRandomId] = useState<string | null>(null);
  const notebookNames = useMemo(() => new Map(notebooks.map((notebook) => [notebook.id, notebook.name])), [notebooks]);

  const activityQuery = useQuery({
    networkMode: "offlineFirst",
    queryKey: ["jot", "activity", "workspace"],
    queryFn: () => repository.listMemoActivity({ notebookId: null }),
  });
  const activity = activityQuery.data?.memos;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const onThisDayItems = useMemo(() => {
    const now = new Date();
    return (activity ?? []).filter((item) => {
      const date = new Date(item.createdAt);
      return date.getMonth() === now.getMonth() && date.getDate() === now.getDate() && date.getFullYear() < now.getFullYear();
    }).slice(0, ON_THIS_DAY_LIMIT);
    // todayKey re-evaluates the match after midnight.
  }, [activity, todayKey]);

  const onThisDayQuery = useQuery({
    networkMode: "offlineFirst",
    queryKey: ["jot", "review", "on-this-day", todayKey, onThisDayItems.map((item) => item.id)],
    queryFn: () => loadDetails(repository, onThisDayItems),
    enabled: mode === "on-this-day" && onThisDayItems.length > 0,
  });

  // Pick once per activity load; re-pick only when the current note left the workspace.
  const randomIdValid = Boolean(randomId && activity?.some((item) => item.id === randomId));
  useEffect(() => {
    if (activity && !randomIdValid) setRandomId(pickRandomId(activity, null));
  }, [activity, randomIdValid]);
  const currentRandomId = randomIdValid ? randomId : null;
  const randomQuery = useQuery({
    networkMode: "offlineFirst",
    queryKey: ["jot", "review", "random", currentRandomId],
    queryFn: async () => {
      const { memo } = await repository.getMemo(currentRandomId!);
      return { ...memo, contentMarkdown: getJotDisplayMarkdown(memo) };
    },
    enabled: mode === "random" && Boolean(currentRandomId),
  });

  const yearGroups = useMemo(() => {
    const groups = new Map<number, MemoDetail[]>();
    for (const memo of onThisDayQuery.data ?? []) {
      const year = new Date(memo.createdAt).getFullYear();
      groups.set(year, [...(groups.get(year) ?? []), memo]);
    }
    return [...groups.entries()].sort(([first], [second]) => second - first);
  }, [onThisDayQuery.data]);

  const renderCard = (memo: MemoDetail) => (
    <JotCard
      key={memo.id}
      memo={memo}
      variant="review"
      notebookName={notebookNames.get(memo.notebookId)}
      onOpenMemo={onOpenMemo}
    />
  );

  const loading = (
    <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-slate-500">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t("jot.loading")}
    </div>
  );
  const failed = (retry: () => void) => (
    <div className="flex flex-col items-center gap-3 py-14 text-[13px] text-slate-500">
      {t("jot.loadFailed")}
      <Button type="button" variant="outline" size="sm" onClick={retry}>{t("jot.retry")}</Button>
    </div>
  );

  let body;
  if (activityQuery.isPending) body = loading;
  else if (activityQuery.isError) body = failed(() => void activityQuery.refetch());
  else if (mode === "on-this-day") {
    if (onThisDayItems.length === 0) body = <ReviewMessage>{t("jot.review.emptyOnThisDay")}</ReviewMessage>;
    else if (onThisDayQuery.isPending) body = loading;
    else if (onThisDayQuery.isError) body = failed(() => void onThisDayQuery.refetch());
    else if (yearGroups.length === 0) body = <ReviewMessage>{t("jot.review.emptyOnThisDay")}</ReviewMessage>;
    else {
      body = yearGroups.map(([year, memos]) => {
        const date = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" })
          .format(new Date(year, today.getMonth(), today.getDate()));
        return (
          <section key={year} aria-label={t("jot.review.yearsAgo", { count: today.getFullYear() - year, date })}>
            <div className="mb-2 mt-5 flex items-center gap-2 text-[12.5px] font-medium text-slate-500 after:h-px after:flex-1 after:bg-slate-200">
              {t("jot.review.yearsAgo", { count: today.getFullYear() - year, date })}
            </div>
            <div className="flex flex-col gap-3">{memos.map(renderCard)}</div>
          </section>
        );
      });
    }
  } else if (!activity?.length) body = <ReviewMessage>{t("jot.review.emptyRandom")}</ReviewMessage>;
  else if (!currentRandomId || randomQuery.isPending) body = loading;
  else if (randomQuery.isError) body = failed(() => void randomQuery.refetch());
  else {
    body = (
      <div className="mt-5">
        {renderCard(randomQuery.data)}
        <div className="mt-3.5 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={(activity?.length ?? 0) < 2}
            onClick={() => setRandomId(pickRandomId(activity ?? [], currentRandomId))}
          >
            <Shuffle className="h-3.5 w-3.5" />
            {t("jot.review.shuffle")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={mode}
          aria-label={t("jot.review.modes")}
          className="gap-0.5 rounded-[9px] border border-slate-200 bg-slate-50 p-[3px]"
          onValueChange={(value) => {
            if (value) setMode(value as ReviewMode);
          }}
        >
          <ToggleGroupItem value="on-this-day" size="sm" className="h-7 rounded-md px-3 text-[13px] data-[state=on]:bg-card data-[state=on]:shadow-2xs">
            <History className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t("jot.review.onThisDay")}
          </ToggleGroupItem>
          <ToggleGroupItem value="random" size="sm" className="h-7 rounded-md px-3 text-[13px] data-[state=on]:bg-card data-[state=on]:shadow-2xs">
            <Shuffle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t("jot.review.random")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {body}
    </div>
  );
};
