import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarDays, History, Inbox, ListFilter, LoaderCircle, Plus, Search, X } from "lucide-react";
import { docToMarkdown, resolveMemoContentDoc, type MemoDetail, type MemoSummary, type Notebook } from "@edgeever/shared";
import { JotCard } from "@/components/jot/JotCard";
import { JotEditor, type JotEditorSubmit } from "@/components/jot/JotEditor";
import { JotFilters } from "@/components/jot/JotFilters";
import { JotReview } from "@/components/jot/JotReview";
import { JotUndoNotice, type JotUndoNoticeState } from "@/components/jot/JotUndoNotice";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/clipboard";
import { localDayRange, parseLocalDayKey } from "@/lib/jot-dates";
import { getJotDisplayMarkdown, toggleJotTaskInDoc } from "@/lib/jot-markdown";
import { submitJotCapture, submitJotEdit } from "@/lib/jot-persistence";
import type { EdgeEverRepository } from "@/lib/repository";
import { MEMO_ID_REMAPPED_EVENT } from "@/lib/sync-events";

const JOT_PAGE_SIZE = 20;
const JOT_SEARCH_DEBOUNCE_MS = 250;
const JOT_FRESH_HIGHLIGHT_MS = 1600;
const JOT_DRAFT_STORAGE_KEY = "edgeever.jotDraft";

type JotDraft = { markdown: string; tags: string[] };

const EMPTY_DRAFT: JotDraft = { markdown: "", tags: [] };

export const readJotDraftPreference = (): JotDraft => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(JOT_DRAFT_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return EMPTY_DRAFT;
    const { markdown, tags } = value as Partial<JotDraft>;
    return {
      markdown: typeof markdown === "string" ? markdown : "",
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
    };
  } catch {
    return EMPTY_DRAFT;
  }
};

export const writeJotDraftPreference = (draft: JotDraft) => {
  try {
    if (!draft.markdown.trim() && draft.tags.length === 0) window.localStorage.removeItem(JOT_DRAFT_STORAGE_KEY);
    else window.localStorage.setItem(JOT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
};

export type JotViewProps = {
  /** "review" shows On this day / Random over the whole workspace instead of the inbox stream. */
  view: "stream" | "review";
  repository: EdgeEverRepository;
  inboxNotebook: Notebook | null;
  notebooks: Notebook[];
  isDesktop: boolean;
  imageCompressionEnabled: boolean;
  onOpenMemo: (memoId: string) => void;
};

export function JotView({ view, repository, inboxNotebook, notebooks, isDesktop, imageCompressionEnabled, onOpenMemo }: JotViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const queryClient = useQueryClient();
  const inboxId = inboxNotebook?.id ?? null;
  const inboxName = inboxNotebook?.name ?? "";

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [initialDraft] = useState(readJotDraftPreference);
  const [captureKey, setCaptureKey] = useState(0);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [notice, setNotice] = useState<JotUndoNoticeState | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const draftRef = useRef<JotDraft>(initialDraft);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const noticeSeqRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), JOT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!freshId) return;
    const timer = window.setTimeout(() => setFreshId(null), JOT_FRESH_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [freshId]);

  // A capture first gets a temporary local_ id; once sync assigns the durable id,
  // rewrite cached cards right away so move/delete/edit never target the stale id.
  useEffect(() => {
    const handleMemoIdRemapped = (event: Event) => {
      const mappings = (event as CustomEvent<ReadonlyMap<string, string>>).detail;
      if (!(mappings instanceof Map) || mappings.size === 0) return;
      queryClient.setQueriesData<{ pages: Array<{ memos: MemoSummary[] }>; pageParams: unknown[] }>({ queryKey: ["jot", "stream"] }, (current) => current && {
        ...current,
        pages: current.pages.map((page) => ({ ...page, memos: page.memos.map((memo) => {
          const nextId = mappings.get(memo.id);
          return nextId ? { ...memo, id: nextId } : memo;
        }) })),
      });
      setFreshId((current) => (current && mappings.get(current)) || current);
      void queryClient.invalidateQueries({ queryKey: ["jot"] });
    };
    window.addEventListener(MEMO_ID_REMAPPED_EVENT, handleMemoIdRemapped);
    return () => window.removeEventListener(MEMO_ID_REMAPPED_EVENT, handleMemoIdRemapped);
  }, [queryClient]);

  const dayRange = useMemo(() => (selectedDay && parseLocalDayKey(selectedDay) ? localDayRange(selectedDay) : null), [selectedDay]);
  const hasFilters = Boolean(search || selectedTag || dayRange);

  // Jot caches live under ["jot"]: the ["memos"] namespace is reserved for MemoListPane-shaped
  // list keys that the shared cache helpers read positionally.
  const streamQueryKey = ["jot", "stream", inboxId, search, selectedTag, dayRange?.createdFrom ?? null, dayRange?.createdTo ?? null];
  const memosQuery = useInfiniteQuery({
    networkMode: "offlineFirst",
    refetchOnMount: "always",
    queryKey: streamQueryKey,
    queryFn: ({ pageParam }) => repository.listMemos({
      notebookId: inboxId,
      sort: "created-desc",
      pinnedFirst: false,
      withContent: true,
      q: search || undefined,
      tag: selectedTag ?? undefined,
      createdFrom: dayRange?.createdFrom,
      createdTo: dayRange?.createdTo,
      limit: JOT_PAGE_SIZE,
      offset: pageParam ? Number(pageParam) : 0,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(inboxId),
  });

  const activityQuery = useQuery({
    networkMode: "offlineFirst",
    refetchOnMount: "always",
    queryKey: ["jot", "activity", inboxId ?? "workspace"],
    queryFn: () => repository.listMemoActivity({ notebookId: inboxId }),
    enabled: Boolean(inboxId),
  });

  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: () => repository.listTags() });
  const availableTags = useMemo(() => (tagsQuery.data?.tags ?? []).map((tag) => tag.name), [tagsQuery.data]);

  const memos = useMemo(() => {
    const byId = new Map<string, MemoSummary>();
    for (const page of memosQuery.data?.pages ?? []) {
      for (const memo of page.memos) if (!hiddenIds.has(memo.id)) byId.set(memo.id, memo);
    }
    return [...byId.values()];
  }, [hiddenIds, memosQuery.data?.pages]);
  const filteredCount = memosQuery.data?.pages[0]?.totalCount ?? memos.length;
  const inboxCount = activityQuery.data?.memos.length ?? inboxNotebook?.memoCount ?? 0;

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = memosQuery;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { root: scrollRef.current, rootMargin: "320px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, memos.length, view]);

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["memos"] }),
      queryClient.invalidateQueries({ queryKey: ["jot"] }),
      queryClient.invalidateQueries({ queryKey: ["notebooks"] }),
    ]);
  }, [queryClient]);

  const showNotice = useCallback((value: Omit<JotUndoNoticeState, "id">) => {
    noticeSeqRef.current += 1;
    setNotice({ ...value, id: noticeSeqRef.current });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const showActionError = useCallback(() => showNotice({ message: t("jot.actionFailed"), tone: "error" }), [showNotice, t]);

  const setHidden = (memoId: string, hidden: boolean) => setHiddenIds((current) => {
    const next = new Set(current);
    if (hidden) next.add(memoId);
    else next.delete(memoId);
    return next;
  });

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setSelectedDay(null);
    setSelectedTag(null);
  };

  const handleCapture = async (value: JotEditorSubmit) => {
    if (!inboxId) throw new Error("Inbox notebook is unavailable");
    const created = await submitJotCapture({
      repository,
      notebookId: inboxId,
      markdown: value.markdown,
      tags: value.tags,
      pendingFiles: value.pendingFiles,
      imageCompressionEnabled,
    });
    draftRef.current = EMPTY_DRAFT;
    writeJotDraftPreference(EMPTY_DRAFT);
    // Show the new card at the top right away; the refetch below confirms it.
    const createdSummary: MemoSummary = { ...created, contentMarkdown: getJotDisplayMarkdown(created) };
    queryClient.setQueryData<typeof memosQuery.data>(streamQueryKey, (current) => {
      if (!current?.pages.length || hasFilters) return current;
      const [first, ...rest] = current.pages;
      return { ...current, pages: [{ ...first!, memos: [createdSummary, ...first!.memos.filter((memo) => memo.id !== created.id)], totalCount: first!.totalCount + 1 }, ...rest] };
    });
    setFreshId(created.id);
    setCaptureOpen(false);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    void invalidate();
  };

  const handleEdit = async (memo: MemoDetail, value: JotEditorSubmit) => {
    await submitJotEdit({
      repository,
      memo,
      markdown: value.markdown,
      tags: value.tags,
      pendingFiles: value.pendingFiles,
      imageCompressionEnabled,
    });
    void invalidate();
  };

  const handleMove = async (memo: MemoSummary, notebookId: string) => {
    if (!inboxId || notebookId === memo.notebookId) return;
    const target = notebooks.find((notebook) => notebook.id === notebookId);
    setHidden(memo.id, true);
    try {
      await repository.moveMemos({ memoIds: [memo.id], notebookId });
    } catch {
      setHidden(memo.id, false);
      showActionError();
      return;
    }
    await invalidate();
    setHidden(memo.id, false);
    showNotice({
      message: t("jot.move.moved", { name: target?.name ?? "" }),
      onUndo: () => {
        void repository.moveMemos({ memoIds: [memo.id], notebookId: inboxId })
          .then(invalidate)
          .catch(showActionError);
      },
    });
  };

  const handleDelete = async (memo: MemoSummary) => {
    setHidden(memo.id, true);
    try {
      await repository.deleteMemo(memo.id, false);
    } catch {
      setHidden(memo.id, false);
      showActionError();
      return;
    }
    await invalidate();
    setHidden(memo.id, false);
    showNotice({
      message: t("jot.deleted"),
      onUndo: () => {
        void repository.restoreMemo(memo.id).then(invalidate).catch(showActionError);
      },
    });
  };

  const handleCopy = async (memo: MemoSummary) => {
    try {
      const markdown = memo.contentMarkdown?.trim()
        ? memo.contentMarkdown
        : getJotDisplayMarkdown((await repository.getMemo(memo.id)).memo);
      const copied = await copyTextToClipboard(markdown);
      showNotice(copied ? { message: t("jot.card.copied") } : { message: t("jot.card.copyFailed"), tone: "error" });
    } catch {
      showNotice({ message: t("jot.card.copyFailed"), tone: "error" });
    }
  };

  const handleToggleTask = async (memo: MemoSummary, index: number) => {
    try {
      const { memo: detail } = await repository.getMemo(memo.id);
      // Task indexes follow the rendered Markdown, which mirrors the resolved document.
      const contentJson = toggleJotTaskInDoc(resolveMemoContentDoc(detail.contentJson, detail.contentMarkdown), index);
      if (!contentJson) return;
      await repository.updateMemo(detail, {
        expectedRevision: detail.revision,
        expectedContentHash: detail.contentHash,
        editSessionId: `jot:${detail.id}`,
        title: detail.title ?? "",
        contentJson,
        contentMarkdown: docToMarkdown(contentJson),
        tags: detail.tags,
      });
      await invalidate();
    } catch {
      showActionError();
    }
  };

  const filters = (
    <JotFilters
      search={searchInput}
      onSearchChange={setSearchInput}
      activity={activityQuery.data?.memos}
      activityLoading={activityQuery.isPending}
      selectedDay={selectedDay}
      onSelectDay={setSelectedDay}
      selectedTag={selectedTag}
      onSelectTag={setSelectedTag}
      inboxName={inboxName}
      className="min-h-full"
    />
  );

  const captureEditor = (mobile: boolean) => (
    <JotEditor
      key={captureKey}
      mode="capture"
      editorId="jot-capture"
      initialMarkdown={draftRef.current.markdown}
      initialTags={draftRef.current.tags}
      availableTags={availableTags}
      inboxName={inboxName}
      zenEnabled={!mobile}
      showCancel={mobile}
      autoFocus={mobile}
      className={mobile ? "min-h-0 flex-1" : undefined}
      onDraftChange={(draft) => {
        draftRef.current = draft;
        writeJotDraftPreference(draft);
      }}
      onSubmit={handleCapture}
      onCancel={mobile ? () => setCaptureOpen(false) : undefined}
    />
  );

  const dayLabel = selectedDay && parseLocalDayKey(selectedDay)
    ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(parseLocalDayKey(selectedDay)!)
    : null;

  const chipClass = "inline-flex h-6 items-center gap-0.5 whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 pl-2 pr-1 text-xs text-slate-700";
  const chipClear = (label: string, onClear: () => void) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="grid size-4 place-items-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
          aria-label={label}
          onClick={onClear}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
  const activeFilterCount = [search, selectedTag, dayLabel].filter(Boolean).length;
  const filterChips = hasFilters ? (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {search ? (
        <span className={chipClass}>
          <Search className="h-3 w-3 text-slate-500" aria-hidden="true" />
          <span className="max-w-[12rem] truncate">「{search}」</span>
          {chipClear(t("jot.filters.clearSearch"), () => {
            setSearchInput("");
            setSearch("");
          })}
        </span>
      ) : null}
      {selectedTag ? (
        <span className={chipClass}>
          <span className="max-w-[12rem] truncate">#{selectedTag}</span>
          {chipClear(t("jot.filters.clearTag"), () => setSelectedTag(null))}
        </span>
      ) : null}
      {dayLabel ? (
        <span className={chipClass}>
          <CalendarDays className="h-3 w-3 text-slate-500" aria-hidden="true" />
          {dayLabel}
          {chipClear(t("jot.filters.clearDay"), () => setSelectedDay(null))}
        </span>
      ) : null}
      {activeFilterCount > 1 ? (
        <button type="button" className="ml-1 rounded px-1 text-xs text-slate-500 hover:text-slate-900" onClick={clearFilters}>
          {t("jot.filters.clearAll")}
        </button>
      ) : null}
    </div>
  ) : null;

  let stream;
  if (!inboxNotebook) {
    stream = <div className="px-4 py-14 text-center text-[13px] text-slate-500">{t("jot.empty.noInbox")}</div>;
  } else if (memosQuery.isPending) {
    stream = (
      <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-slate-500">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t("jot.loading")}
      </div>
    );
  } else if (memosQuery.isError && memos.length === 0) {
    stream = (
      <div className="flex flex-col items-center gap-3 py-14 text-[13px] text-slate-500">
        {t("jot.loadFailed")}
        <Button type="button" variant="outline" size="sm" onClick={() => void memosQuery.refetch()}>{t("jot.retry")}</Button>
      </div>
    );
  } else if (memos.length === 0) {
    stream = (
      <div className="px-4 py-14 text-center text-slate-500">
        <div className="mx-auto mb-3 grid size-12 place-items-center rounded-xl border border-slate-200 bg-card text-slate-600">
          {hasFilters ? <Search className="h-5 w-5" aria-hidden="true" /> : <Inbox className="h-5 w-5" aria-hidden="true" />}
        </div>
        <h3 className="mb-1 text-[15px] font-semibold text-slate-900">{hasFilters ? t("jot.empty.filteredTitle") : t("jot.empty.inboxTitle")}</h3>
        <p className="mb-3.5 text-[13px]">{hasFilters ? t("jot.empty.filteredDescription") : t("jot.empty.inboxDescription")}</p>
        {hasFilters ? <Button type="button" variant="outline" size="sm" onClick={clearFilters}>{t("jot.empty.clearFilters")}</Button> : null}
      </div>
    );
  } else {
    stream = (
      <>
        <div className="mt-4 flex flex-col gap-3">
          {memos.map((memo) => (
            <JotCard
              key={memo.id}
              memo={memo}
              notebooks={notebooks}
              inboxId={inboxId}
              inboxName={inboxName}
              availableTags={availableTags}
              isDesktop={isDesktop}
              fresh={memo.id === freshId}
              selectedTag={selectedTag}
              onSelectTag={(tag) => setSelectedTag((current) => (current === tag ? null : tag))}
              onOpenMemo={onOpenMemo}
              onLoadDetail={async (target) => (await repository.getMemo(target.id)).memo}
              onSubmitEdit={handleEdit}
              onMove={(target, notebookId) => void handleMove(target, notebookId)}
              onCopy={(target) => void handleCopy(target)}
              onDelete={(target) => void handleDelete(target)}
              onToggleTask={(target, index) => void handleToggleTask(target, index)}
              onActionError={showActionError}
            />
          ))}
        </div>
        <div ref={sentinelRef} className="h-px" aria-hidden="true" />
        {isFetchingNextPage ? (
          <div className="flex justify-center py-5 text-slate-400">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-label={t("jot.loading")} />
          </div>
        ) : memosQuery.isFetchNextPageError ? (
          <div className="flex justify-center py-5">
            <Button type="button" variant="ghost" size="sm" onClick={() => void fetchNextPage()}>{t("jot.retry")}</Button>
          </div>
        ) : !hasNextPage ? (
          <div className="pt-5 text-center text-xs text-slate-400">
            {hasFilters ? t("jot.filteredCount", { count: filteredCount }) : t("jot.streamEnd", { count: filteredCount })}
          </div>
        ) : null}
      </>
    );
  }

  const meta = view === "stream" ? (
    <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
      <Inbox className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("jot.inboxMeta", { name: inboxName, count: inboxCount })}</span>
    </span>
  ) : (
    <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
      <History className="h-3.5 w-3.5" aria-hidden="true" />
      {t("jot.workspaceScope")}
    </span>
  );

  const body = view === "review" ? (
    <JotReview repository={repository} notebooks={notebooks} onOpenMemo={onOpenMemo} />
  ) : (
    <>
      {isDesktop && inboxNotebook ? captureEditor(false) : null}
      {filterChips}
      {stream}
    </>
  );

  if (isDesktop) {
    return (
      <div className="flex h-full min-h-0 min-w-0 bg-[var(--workspace-editor)]">
        {view === "stream" ? (
          <aside className="h-full w-[272px] shrink-0 overflow-y-auto border-r border-[var(--workspace-divider)]" aria-label={t("jot.filters.title")}>
            {filters}
          </aside>
        ) : null}
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--workspace-divider)] px-5">
            <h1 className="text-[15px] font-semibold text-slate-900">{t(view === "review" ? "jot.review.title" : "jot.title")}</h1>
            {meta}
          </header>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[660px] px-5 pb-10 pt-5">{body}</div>
          </div>
        </section>
        <JotUndoNotice notice={notice} onDismiss={dismissNotice} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--workspace-editor)]">
      <header className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <h1 className="ml-1 text-xl font-bold text-slate-900">{t(view === "review" ? "jot.review.title" : "jot.title")}</h1>
        {view === "stream" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative ml-auto"
            aria-label={t("jot.filters.title")}
            onClick={() => setFiltersOpen(true)}
          >
            <ListFilter className="h-4 w-4" />
            {hasFilters ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500" aria-hidden="true" /> : null}
          </Button>
        ) : null}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pb-24 pt-1">
          <div className="mb-1 flex text-xs">{meta}</div>
          {body}
        </div>
      </div>

      {view === "stream" && inboxNotebook ? (
        <button
          type="button"
          className="absolute bottom-5 right-4 z-10 grid size-[52px] place-items-center rounded-full bg-slate-900 text-white shadow-[0_8px_24px_rgb(0_0_0/0.22)] transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 focus-visible:ring-offset-2"
          aria-label={t("jot.mobile.write")}
          onClick={() => setCaptureOpen(true)}
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
        </button>
      ) : null}

      <Drawer open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DrawerContent className="max-h-[85dvh] overflow-hidden">
          <DrawerHeader className="flex flex-row items-center justify-between border-b border-slate-200 py-2">
            <DrawerTitle>{t("jot.filters.title")}</DrawerTitle>
            <DrawerDescription className="sr-only">{t("jot.filters.scopeNote", { name: inboxName })}</DrawerDescription>
            <Button type="button" variant="ghost" size="icon" aria-label={t("jot.mobile.close")} onClick={() => setFiltersOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">{filters}</div>
        </DrawerContent>
      </Drawer>

      <Drawer
        open={captureOpen}
        onOpenChange={(open) => {
          setCaptureOpen(open);
          // Remount so the editor picks up the stored draft next time.
          if (!open) setCaptureKey((key) => key + 1);
        }}
        handleOnly
        repositionInputs={false}
      >
        <DrawerContent className="inset-x-0 top-[env(safe-area-inset-top)] mt-0 h-[calc(100dvh_-_env(safe-area-inset-top))] max-h-none rounded-t-xl">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("jot.mobile.write")}</DrawerTitle>
            <DrawerDescription>{t("jot.editor.captureLabel")}</DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {captureOpen ? captureEditor(true) : null}
          </div>
        </DrawerContent>
      </Drawer>

      <JotUndoNotice notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}

export default JotView;
