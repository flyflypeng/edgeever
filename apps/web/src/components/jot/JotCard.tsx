import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Component,
  Copy,
  ExternalLink,
  Folder as NotebookIcon,
  GitFork,
  Image as ImageIcon,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  PieChart,
  Table2,
  Trash2,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { isAutomaticMemoTitle, type MemoDetail, type MemoSummary, type Notebook } from "@edgeever/shared";
import { JotEditor, type JotEditorSubmit } from "@/components/jot/JotEditor";
import { JotCardContent } from "@/components/jot/JotCardContent";
import { MobileMoveSheet } from "@/components/MemoListMobileSheets";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getNotebookMoveOptions } from "@/lib/app-helpers";
import { stripJotLeadingTitle } from "@/lib/jot-markdown";
import { getJotEditableMarkdown } from "@/lib/jot-persistence";
import { cn } from "@/lib/utils";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 minutes ago", "yesterday 14:05", "3 days ago", then a calendar date. */
export const formatJotRelativeTime = (value: string, locale: string, now = new Date()) => {
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

type JotSpecialKind = "diagram" | "table" | "infographic" | "poster" | "video";

/** Notes whose body is not plain Markdown get a summary card and no inline editing. */
export const getJotSpecialKind = (memo: MemoSummary): JotSpecialKind | null => {
  if (memo.diagramKind) return "diagram";
  if (memo.structuredTable) return "table";
  if (memo.infographic) return "infographic";
  if (memo.poster) return "poster";
  if (memo.videoNote) return "video";
  return null;
};

const specialKindIcon = (memo: MemoSummary, kind: JotSpecialKind): LucideIcon => {
  if (kind === "diagram") return memo.diagramKind === "mind-map" ? GitFork : memo.diagramKind === "architecture" ? Component : Workflow;
  if (kind === "table") return Table2;
  if (kind === "infographic") return PieChart;
  if (kind === "poster") return ImageIcon;
  return Video;
};

export type JotCardProps = {
  memo: MemoSummary;
  /** Review cards are read-only and show their notebook. */
  variant?: "stream" | "review";
  notebookName?: string;
  notebooks?: Notebook[];
  inboxId?: string | null;
  inboxName?: string;
  availableTags?: string[];
  isDesktop?: boolean;
  fresh?: boolean;
  selectedTag?: string | null;
  onSelectTag?: (tag: string) => void;
  onOpenMemo: (memoId: string) => void;
  /** Loads the full note for inline editing. */
  onLoadDetail?: (memo: MemoSummary) => Promise<MemoDetail>;
  /** Saves an inline edit; rejecting keeps the editor open with its content. */
  onSubmitEdit?: (memo: MemoDetail, value: JotEditorSubmit) => Promise<void>;
  onMove?: (memo: MemoSummary, notebookId: string) => void;
  onCopy?: (memo: MemoSummary) => void;
  onDelete?: (memo: MemoSummary) => void;
  onToggleTask?: (memo: MemoSummary, index: number) => void;
  onActionError?: () => void;
};

export const JotCard = ({
  memo,
  variant = "stream",
  notebookName,
  notebooks = [],
  inboxId = null,
  inboxName = "",
  availableTags = [],
  isDesktop = true,
  fresh = false,
  selectedTag = null,
  onSelectTag,
  onOpenMemo,
  onLoadDetail,
  onSubmitEdit,
  onMove,
  onCopy,
  onDelete,
  onToggleTask,
  onActionError,
}: JotCardProps) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const readOnly = variant === "review";
  const specialKind = getJotSpecialKind(memo);
  const editable = !readOnly && !specialKind && Boolean(onLoadDetail && onSubmitEdit);
  const [editingMemo, setEditingMemo] = useState<MemoDetail | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [mobileMoveOpen, setMobileMoveOpen] = useState(false);
  // A title derived from the first line would only repeat it; show the body alone.
  const title = isAutomaticMemoTitle(memo.title, memo.contentMarkdown ?? memo.excerpt) ? "" : memo.title!.trim();
  const moveOptions = useMemo(
    () => getNotebookMoveOptions(notebooks).filter((option) => option.id !== inboxId),
    [inboxId, notebooks],
  );
  const absoluteTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(memo.createdAt));

  const startEdit = async () => {
    if (!editable || editingMemo || loadingEdit || !onLoadDetail) return;
    setLoadingEdit(true);
    try {
      setEditingMemo(await onLoadDetail(memo));
    } catch {
      onActionError?.();
    } finally {
      setLoadingEdit(false);
    }
  };

  if (editingMemo && onSubmitEdit) {
    return (
      <article className="rounded-xl" data-jot-memo-id={memo.id}>
        <JotEditor
          key={editingMemo.id}
          mode="edit"
          editorId={editingMemo.id}
          initialMarkdown={getJotEditableMarkdown(editingMemo)}
          initialTags={editingMemo.tags}
          availableTags={availableTags}
          inboxName={inboxName}
          showCancel
          autoFocus
          onSubmit={async (value) => {
            await onSubmitEdit(editingMemo, value);
            setEditingMemo(null);
          }}
          onCancel={() => setEditingMemo(null)}
        />
      </article>
    );
  }

  const SpecialIcon = specialKind ? specialKindIcon(memo, specialKind) : null;

  let menu: ReactNode = null;
  if (!readOnly) {
    menu = (
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-slate-500 opacity-100 transition-opacity data-[state=open]:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
                aria-label={t("jot.card.more")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("jot.card.more")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" collisionPadding={12} className="w-52">
          {editable ? (
            <DropdownMenuItem className="gap-2 text-xs" onSelect={() => void startEdit()}>
              <Pencil className="h-4 w-4 text-slate-500" />
              {t("jot.card.edit")}
              {isDesktop ? <DropdownMenuShortcut>{t("jot.card.editHint")}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => onOpenMemo(memo.id)}>
            <ExternalLink className="h-4 w-4 text-slate-500" />
            {t("jot.card.openInEditor")}
          </DropdownMenuItem>
          {onMove ? (
            isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 text-xs" disabled={moveOptions.length === 0}>
                  <NotebookIcon className="h-4 w-4 text-slate-500" />
                  <span className="min-w-0 flex-1 truncate">{t("jot.card.move")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent collisionPadding={12} sticky="always" className="max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] w-56 overflow-y-auto">
                  {moveOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.id}
                      className="flex h-9 items-center gap-2 px-3 text-xs text-slate-700"
                      style={{ paddingLeft: `${12 + option.depth * 14}px` }}
                      onSelect={() => onMove(memo, option.id)}
                    >
                      <NotebookIcon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem className="gap-2 text-xs" disabled={moveOptions.length === 0} onSelect={() => setMobileMoveOpen(true)}>
                <NotebookIcon className="h-4 w-4 text-slate-500" />
                {t("jot.card.move")}
              </DropdownMenuItem>
            )
          ) : null}
          {onCopy ? (
            <DropdownMenuItem className="gap-2 text-xs" onSelect={() => onCopy(memo)}>
              <Copy className="h-4 w-4 text-slate-500" />
              {t("jot.card.copy")}
            </DropdownMenuItem>
          ) : null}
          {onDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 text-xs text-rose-700 focus:bg-rose-50 focus:text-rose-700" onSelect={() => onDelete(memo)}>
                <Trash2 className="h-4 w-4" />
                {t("jot.card.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <article
      className={cn(
        "group relative rounded-xl border border-slate-200 bg-card px-4 pb-3.5 pt-3 transition-colors hover:border-slate-300",
        fresh && "animate-in fade-in-0 slide-in-from-top-2 duration-500",
        loadingEdit && "opacity-70",
      )}
      data-jot-memo-id={memo.id}
      onDoubleClick={(event) => {
        if (!editable) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button, a, [role='menu']")) return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        void startEdit();
      }}
    >
      <div className="mb-0.5 flex h-[26px] items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <time
              tabIndex={0}
              dateTime={memo.createdAt}
              className="rounded text-xs tabular-nums text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
            >
              {formatJotRelativeTime(memo.createdAt, locale)}
            </time>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("jot.card.createdAt", { time: absoluteTime })}</TooltipContent>
        </Tooltip>
        {notebookName ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-slate-500">
            <span aria-hidden="true">·</span>
            <NotebookIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{notebookName}</span>
          </span>
        ) : null}
        {loadingEdit ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" aria-label={t("jot.loading")} /> : null}
        {readOnly ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={() => onOpenMemo(memo.id)}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t("jot.card.openInEditor")}
          </Button>
        ) : menu}
      </div>

      {specialKind && SpecialIcon ? (
        <div className="mt-1 flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
            <SpecialIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-900">{title || t(`jot.card.kinds.${specialKind}`)}</div>
            <div className="truncate text-xs text-slate-500">{memo.excerpt || t(`jot.card.kinds.${specialKind}`)}</div>
          </div>
          {!readOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenMemo(memo.id)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t("jot.card.open")}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {title ? <h2 className="mb-1 mt-0.5 text-[15px] font-semibold leading-[1.45] text-slate-900">{title}</h2> : null}
          <JotCardContent
            markdown={stripJotLeadingTitle(memo.contentMarkdown ?? memo.excerpt, title)}
            collapsible={!readOnly}
            onToggleTask={!readOnly && onToggleTask ? (index) => onToggleTask(memo, index) : undefined}
            onOpenMemo={onOpenMemo}
          />
        </>
      )}

      {memo.tags.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {memo.tags.map((tag) => (readOnly || !onSelectTag ? (
            <span key={tag} className="inline-flex h-6 items-center rounded-full border border-slate-200 bg-slate-50 px-2 text-xs text-slate-600">#{tag}</span>
          ) : (
            <button
              key={tag}
              type="button"
              aria-pressed={selectedTag === tag}
              className={cn(
                "inline-flex h-6 items-center rounded-full border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20",
                selectedTag === tag
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              )}
              onClick={() => onSelectTag(tag)}
            >
              #{tag}
            </button>
          )))}
        </div>
      ) : null}

      {mobileMoveOpen && onMove ? (
        <MobileMoveSheet
          isMoving={false}
          notebooks={notebooks}
          selectedCount={1}
          selectedNotebookId={memo.notebookId}
          onClose={() => setMobileMoveOpen(false)}
          onMove={(notebookId) => {
            setMobileMoveOpen(false);
            if (notebookId !== memo.notebookId) onMove(memo, notebookId);
          }}
        />
      ) : null}
    </article>
  );
};
