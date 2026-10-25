import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@uiw/react-codemirror";
import { resolveResourceUploadMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "@edgeever/shared";
import { Hash, Loader, Maximize2, Minimize2, Paperclip, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MarkdownSourceEditor } from "@/components/editor/MarkdownSourceEditor";
import { getResourceFilesFromDataTransfer } from "@/components/editor/editor-pane-helpers";
import { useMarkdownTheme } from "@/components/ThemeProvider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createClientUuid } from "@/lib/client-id";
import { JOT_CONTENT_CLASS, renderJotMarkdownHtml } from "@/lib/jot-markdown";
import { JOT_PENDING_PREFIX, JotUnsafeTableEditError } from "@/lib/jot-persistence";
import { resourceToMarkdown } from "@/lib/markdown-resource-paste";
import { cn } from "@/lib/utils";
import { insertLink, padAsBlock, toggleWrap } from "./jot-editor-commands";
import { JotFormatBar } from "./JotFormatBar";
import { JotTagSuggestions, type JotTagSuggestion } from "./JotTagSuggestions";

export type JotPendingFile = { url: string; file: File }; // url looks like "edgeever-jot-pending://<uuid>"
export type JotEditorSubmit = { markdown: string; tags: string[]; pendingFiles: JotPendingFile[] };
export type JotEditorProps = {
  mode: "capture" | "edit";
  /** Stable memo ID passed to MarkdownSourceEditor ("jot-capture" for capture, memo.id for edit). */
  editorId: string;
  /** Read on mount only; remount with a new key to load other content. */
  initialMarkdown: string;
  initialTags: string[];
  /** Candidates for `#` completion and the tag cloud. */
  availableTags: string[];
  /** Shown in the send hint: saved to "x". */
  inboxName: string;
  zenEnabled?: boolean;
  showCancel?: boolean;
  autoFocus?: boolean;
  className?: string;
  onDraftChange?: (draft: { markdown: string; tags: string[] }) => void;
  /** Rejecting keeps the content; resolving clears the editor in capture mode. */
  onSubmit: (value: JotEditorSubmit) => Promise<void>;
  onCancel?: () => void;
};

type HashState = {
  /** Document offset of the `#`. */
  from: number;
  query: string;
  items: JotTagSuggestion[];
  activeIndex: number;
  position: { top: number; left: number };
};

type EditorActions = {
  syncHash: (view: EditorView) => void;
  autoChip: (view: EditorView, from: number, to: number, text: string) => boolean;
  moveHash: (delta: number) => boolean;
  pickActiveHash: (view: EditorView) => boolean;
  escape: () => boolean;
  submit: () => boolean;
  toggleZen: () => boolean;
  dropFiles: (event: DragEvent, view: EditorView) => boolean;
};

const BOLD = toggleWrap("**", "text");
const ITALIC = toggleWrap("*", "text");
// `#query` right before the cursor, at the line start or after whitespace.
const HASH_BEFORE_CURSOR = /(?:^|\s)#([^\s#]*)$/;
const HASH_WORD_BEFORE_CURSOR = /(?:^|\s)#([^\s#]+)$/;
const MAX_TAG_SUGGESTIONS = 6;

/** `#` inside fenced or inline code is code, not a tag. */
const isInsideCode = (state: EditorState, pos: number) => {
  const line = state.doc.lineAt(pos);
  const fences = state.sliceDoc(0, line.from).match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0;
  const backticks = state.sliceDoc(line.from, pos).match(/`/g)?.length ?? 0;
  return fences % 2 === 1 || backticks % 2 === 1;
};

const jotEditorTheme = EditorView.theme({
  "&": { fontSize: "14px", fontFamily: "inherit", backgroundColor: "transparent" },
  ".cm-scroller": {
    minHeight: "64px",
    maxHeight: "var(--jot-editor-max-height, 50vh)",
    lineHeight: "1.75",
    fontFamily: "inherit",
  },
  ".cm-content": {
    padding: "10px var(--jot-editor-pad-right, 12px) 2px 12px",
    minHeight: "auto",
  },
});

const iconButtonClassName =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-700 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:pointer-events-none disabled:opacity-45";

export function JotEditor({
  mode,
  editorId,
  initialMarkdown,
  initialTags,
  availableTags,
  inboxName,
  zenEnabled = false,
  showCancel = false,
  autoFocus = false,
  className,
  onDraftChange,
  onSubmit,
  onCancel,
}: JotEditorProps) {
  const { t } = useTranslation();
  const { markdownTheme } = useMarkdownTheme();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [tags, setTags] = useState(initialTags);
  const [previewing, setPreviewing] = useState(false);
  const [zen, setZen] = useState(false);
  const [zenSlotHeight, setZenSlotHeight] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hash, setHash] = useState<HashState | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(new Map<string, { file: File; objectUrl: string | null }>());
  const hashRef = useRef<HashState | null>(null);
  // Esc dismisses the list for this `#` until the cursor leaves it.
  const dismissedHashFromRef = useRef<number | null>(null);
  const submittingRef = useRef(false);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const draftMountedRef = useRef(false);

  const isMac = /mac|iphone|ipad|ipod/i.test(window.navigator.platform);
  const submitShortcut = isMac ? "⌘↵" : "Ctrl+Enter";
  const zenShortcut = isMac ? "⌘⇧↵" : "Ctrl+Shift+Enter";

  const updateHash = (next: HashState | null) => {
    hashRef.current = next;
    setHash(next);
  };

  const addTag = (tag: string) => setTags((current) => (current.includes(tag) ? current : [...current, tag]));

  const createPendingReferences = useCallback((files: File[]) => files.map((file) => {
    const url = `${JOT_PENDING_PREFIX}${createClientUuid()}`;
    const isImage = SUPPORTED_IMAGE_MIME_TYPES.has(resolveResourceUploadMimeType(file.name, file.type));
    pendingRef.current.set(url, { file, objectUrl: isImage ? URL.createObjectURL(file) : null });
    return resourceToMarkdown({ kind: isImage ? "image" : "attachment", url, filename: file.name }, "file");
  }).join("\n"), []);

  const insertPendingFiles = (view: EditorView, files: File[], from: number, to: number) => {
    const text = padAsBlock(view.state.doc.toString(), from, to, createPendingReferences(files));
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
  };

  const releasePendingFiles = () => {
    for (const { objectUrl } of pendingRef.current.values()) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    pendingRef.current.clear();
  };

  const pickHash = (view: EditorView, item: JotTagSuggestion) => {
    const current = hashRef.current;
    if (!current) return;
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    const before = current.from === line.from ? "" : view.state.sliceDoc(current.from - 1, current.from);
    // Drop one adjoining space so "a #tag b" becomes "a b".
    const to = view.state.sliceDoc(head, head + 1) === " " && (before === "" || before === " ") ? head + 1 : head;
    view.dispatch({ changes: { from: current.from, to }, selection: { anchor: current.from }, userEvent: "delete" });
    updateHash(null);
    addTag(item.tag);
    view.focus();
  };

  const toggleZen = () => {
    if (!zenEnabled) return false;
    if (!zen) setZenSlotHeight(slotRef.current?.offsetHeight ?? null);
    setZen(!zen);
    return true;
  };

  const submit = async () => {
    const value = viewRef.current?.state.doc.toString() ?? markdown;
    if (submittingRef.current || (mode === "capture" && !value.trim())) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    updateHash(null);
    try {
      await onSubmit({
        markdown: value,
        tags,
        pendingFiles: [...pendingRef.current].map(([url, { file }]) => ({ url, file })),
      });
      if (mode === "capture") {
        releasePendingFiles();
        setMarkdown("");
        setTags([]);
        setPreviewing(false);
        setZen(false);
      }
    } catch (submitError) {
      setError(submitError instanceof JotUnsafeTableEditError
        ? t("jot.editor.unsafeTableEdit")
        : t(mode === "capture" ? "jot.editor.sendFailed" : "jot.editor.saveFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      // The editor is read-only while sending, which drops focus; hand it back for the next note.
      window.requestAnimationFrame(() => viewRef.current?.focus());
    }
  };

  // CodeMirror extensions are created once; they call the latest render's logic through this ref.
  const actions = useRef<EditorActions | null>(null);
  actions.current = {
    syncHash: (view) => {
      const selection = view.state.selection.main;
      const line = view.state.doc.lineAt(selection.head);
      const match = view.hasFocus && selection.empty && !isInsideCode(view.state, selection.head)
        ? HASH_BEFORE_CURSOR.exec(view.state.sliceDoc(line.from, selection.head))
        : null;
      if (!match) {
        dismissedHashFromRef.current = null;
        if (hashRef.current) updateHash(null);
        return;
      }
      const query = match[1]!;
      const from = selection.head - query.length - 1;
      if (dismissedHashFromRef.current === from) return;
      const lowerQuery = query.toLowerCase();
      const items: JotTagSuggestion[] = availableTags
        .filter((tag) => !tags.includes(tag) && tag.toLowerCase().includes(lowerQuery))
        .slice(0, MAX_TAG_SUGGESTIONS)
        .map((tag) => ({ tag, create: false }));
      if (query && !availableTags.includes(query) && !tags.includes(query)) items.push({ tag: query, create: true });
      const coords = items.length ? view.coordsAtPos(from) : null;
      if (!coords) {
        if (hashRef.current) updateHash(null);
        return;
      }
      const previous = hashRef.current;
      updateHash({
        from,
        query,
        items,
        activeIndex: previous?.from === from ? Math.min(previous.activeIndex, items.length - 1) : 0,
        position: { top: coords.bottom, left: coords.left },
      });
    },
    autoChip: (view, from, to, text) => {
      if (text !== " " || from !== to || view.composing || isInsideCode(view.state, from)) return false;
      const line = view.state.doc.lineAt(from);
      const match = HASH_WORD_BEFORE_CURSOR.exec(view.state.sliceDoc(line.from, from));
      if (!match) return false;
      const word = match[1]!;
      const start = from - word.length - 1;
      view.dispatch({ changes: { from: start, to: from }, selection: { anchor: start }, userEvent: "input" });
      updateHash(null);
      addTag(word);
      return true;
    },
    moveHash: (delta) => {
      const current = hashRef.current;
      if (!current) return false;
      const count = current.items.length;
      updateHash({ ...current, activeIndex: (current.activeIndex + delta + count) % count });
      return true;
    },
    pickActiveHash: (view) => {
      const current = hashRef.current;
      if (!current || view.composing) return false;
      pickHash(view, current.items[current.activeIndex]!);
      return true;
    },
    escape: () => {
      if (hashRef.current) {
        dismissedHashFromRef.current = hashRef.current.from;
        updateHash(null);
        return true;
      }
      if (zen) {
        setZen(false);
        return true;
      }
      if (mode === "edit" && onCancel && !submittingRef.current) {
        onCancel();
        return true;
      }
      return false;
    },
    submit: () => {
      void submit();
      return true;
    },
    toggleZen,
    dropFiles: (event, view) => {
      const files = getResourceFilesFromDataTransfer(event.dataTransfer);
      if (!files.length || submittingRef.current) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      insertPendingFiles(view, files, pos, pos);
      return true;
    },
  };

  const extensions = useMemo<Extension[]>(() => [
    ViewPlugin.define((view) => {
      viewRef.current = view;
      return {
        destroy: () => {
          if (viewRef.current === view) viewRef.current = null;
        },
      };
    }),
    Prec.highest(keymap.of([
      { key: "ArrowDown", run: () => actions.current!.moveHash(1) },
      { key: "ArrowUp", run: () => actions.current!.moveHash(-1) },
      { key: "Enter", run: (view) => actions.current!.pickActiveHash(view) },
      { key: "Tab", run: (view) => actions.current!.pickActiveHash(view) },
      { key: "Escape", run: () => actions.current!.escape() },
      { key: "Mod-Enter", run: () => actions.current!.submit() },
      { key: "Mod-Shift-Enter", run: () => actions.current!.toggleZen() },
      { key: "Mod-b", run: BOLD },
      { key: "Mod-i", run: ITALIC },
      { key: "Mod-k", run: insertLink },
    ])),
    // Files dropped into the text become pending references instead of CodeMirror's text drop.
    Prec.highest(EditorView.domEventHandlers({ drop: (event, view) => actions.current!.dropFiles(event, view) })),
    EditorView.inputHandler.of((view, from, to, text) => actions.current!.autoChip(view, from, to, text)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet || update.focusChanged) actions.current!.syncHash(update.view);
    }),
    Prec.highest(jotEditorTheme),
  ], []);

  useEffect(() => {
    if (!draftMountedRef.current) {
      draftMountedRef.current = true;
      return;
    }
    onDraftChangeRef.current?.({ markdown, tags });
  }, [markdown, tags]);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const { objectUrl } of pending.values()) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };
  }, []);

  // Esc also leaves zen mode while focus is on the editor chrome rather than the text.
  useEffect(() => {
    if (!zen || menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setZen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen, zen]);

  const handleChange = useCallback((value: string) => {
    setMarkdown(value);
    setError(null);
  }, []);

  const handlePasteFiles = useCallback(async (files: File[]) => {
    if (submittingRef.current) return "";
    const text = createPendingReferences(files);
    const state = viewRef.current?.state;
    return state ? padAsBlock(state.doc.toString(), state.selection.main.from, state.selection.main.to, text) : text;
  }, [createPendingReferences]);

  const handleEditorReady = useCallback(() => {
    const view = viewRef.current;
    if (!autoFocus || !view) return;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  }, [autoFocus]);

  const previewHtml = useMemo(() => (previewing && markdown.trim()
    ? renderJotMarkdownHtml(markdown, { resolvePendingUrl: (url) => pendingRef.current.get(url)?.objectUrl })
    : ""), [markdown, previewing]);

  const setPreview = (next: boolean) => {
    setPreviewing(next);
    if (!next) window.requestAnimationFrame(() => viewRef.current?.focus());
  };

  const focusEditor = (event: Event) => {
    event.preventDefault();
    viewRef.current?.focus();
  };

  const cloudTags = availableTags.filter((tag) => !tags.includes(tag));
  const hasPendingFiles = pendingRef.current.size > 0;
  const sendLabel = mode === "edit" ? t("jot.editor.save") : t("jot.editor.send");
  const sendHint = submitting && hasPendingFiles
    ? t("jot.editor.uploading")
    : mode === "edit"
      ? t("jot.editor.saveHint", { shortcut: submitShortcut })
      : t("jot.editor.sendHint", { shortcut: submitShortcut, name: inboxName });
  const zenLabel = zen ? t("jot.editor.exitZen") : t("jot.editor.zen", { shortcut: zenShortcut });

  return (
    <TooltipProvider>
      <div ref={slotRef} className={className} style={zen && zenSlotHeight ? { height: zenSlotHeight } : undefined}>
        {/* Same stacking context as the editor, so the scrim always sits right below it. */}
        {zen ? <div className="fixed inset-0 z-40 bg-black/40" onMouseDown={() => setZen(false)} aria-hidden="true" /> : null}
        <div
          role={zen ? "dialog" : undefined}
          aria-modal={zen ? true : undefined}
          aria-label={zen ? zenLabel : undefined}
          className={cn(
            "relative flex h-full w-full flex-col rounded-lg border border-slate-200 bg-card text-slate-900",
            zen && "fixed inset-0 z-50 m-auto h-[min(78vh,760px)] w-[min(880px,92vw)] rounded-xl shadow-2xl",
          )}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          {zenEnabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 z-10 grid size-8 place-items-center rounded-md text-slate-500 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
                  aria-label={zenLabel}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={toggleZen}
                >
                  {zen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{zenLabel}</TooltipContent>
            </Tooltip>
          ) : null}
          {focused || previewing || zen || menuOpen ? (
            <JotFormatBar
              getView={() => viewRef.current}
              previewing={previewing}
              onPreviewChange={setPreview}
              onMenuOpenChange={setMenuOpen}
              className={zenEnabled ? "pr-10" : undefined}
            />
          ) : null}
          {previewing ? (
            <div className={cn("overflow-auto px-3 pb-0.5 pt-2.5 text-sm", zen ? "min-h-0 flex-1" : "max-h-[50vh] min-h-16")}>
              {previewHtml
                ? <div className={JOT_CONTENT_CLASS} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                : <p className="leading-7 text-slate-400">{t("jot.editor.previewEmpty")}</p>}
            </div>
          ) : null}
          <div
            className={cn("min-h-0", zen && "flex-1", previewing && "hidden")}
            style={{
              "--jot-editor-max-height": zen ? "none" : "50vh",
              "--jot-editor-pad-right": zenEnabled ? "40px" : "12px",
            } as CSSProperties}
          >
            <MarkdownSourceEditor
              memoId={editorId}
              value={markdown}
              onChange={handleChange}
              onPasteFiles={handlePasteFiles}
              themeName={markdownTheme}
              readOnly={submitting}
              placeholder={t("jot.editor.placeholder")}
              ariaLabel={mode === "edit" ? t("jot.editor.editLabel") : t("jot.editor.captureLabel")}
              onReady={handleEditorReady}
              extensions={extensions}
            />
          </div>
          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-6 items-center gap-0.5 whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 pl-2 pr-1 text-xs text-slate-700"
                >
                  #{tag}
                  <button
                    type="button"
                    className="grid size-4 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
                    aria-label={t("jot.editor.removeTag", { tag })}
                    disabled={submitting}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setTags((current) => current.filter((item) => item !== tag))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {error ? <p role="alert" className="px-3 pt-1.5 text-xs leading-5 text-rose-600">{error}</p> : null}
          <div className="flex items-center justify-between p-2" onMouseDown={(event) => event.preventDefault()}>
            <div className="flex items-center gap-0.5 opacity-80">
              <DropdownMenu onOpenChange={setMenuOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className={iconButtonClassName} aria-label={t("jot.editor.tags")} disabled={submitting}>
                        <Hash className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("jot.editor.tags")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={focusEditor}>
                  {cloudTags.length > 0 ? (
                    <>
                      <div className="flex max-h-48 flex-wrap gap-x-1 overflow-auto">
                        {cloudTags.map((tag) => (
                          <DropdownMenuItem key={tag} className="px-1.5 py-0.5 text-[13px] text-slate-600" onSelect={() => addTag(tag)}>
                            #{tag}
                          </DropdownMenuItem>
                        ))}
                      </div>
                      <DropdownMenuLabel className="font-normal text-slate-400">{t("jot.editor.tagHint")}</DropdownMenuLabel>
                    </>
                  ) : (
                    <DropdownMenuLabel className="font-normal text-slate-500">{t("jot.editor.noTags")}</DropdownMenuLabel>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={iconButtonClassName}
                    aria-label={t("jot.editor.upload")}
                    disabled={submitting}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("jot.editor.upload")}</TooltipContent>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []).filter((file) => file.size > 0);
                  event.target.value = "";
                  const view = viewRef.current;
                  if (!files.length || !view || submittingRef.current) return;
                  const { from, to } = view.state.selection.main;
                  insertPendingFiles(view, files, from, to);
                  setPreviewing(false);
                }}
              />
            </div>
            <div className="flex items-center gap-0.5">
              {showCancel ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(iconButtonClassName, "text-slate-500")}
                      aria-label={t("jot.editor.cancel")}
                      disabled={submitting}
                      onClick={onCancel}
                    >
                      <X className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t("jot.editor.cancelHint")}</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(iconButtonClassName, "text-[var(--brand-green)] hover:text-[var(--brand-green-hover)] hover:opacity-100")}
                    aria-label={sendLabel}
                    aria-busy={submitting || undefined}
                    disabled={submitting || (mode === "capture" && !markdown.trim())}
                    onClick={() => void submit()}
                  >
                    {submitting ? <Loader className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">{sendHint}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
        {hash && viewRef.current ? (
          <JotTagSuggestions
            position={hash.position}
            query={hash.query}
            items={hash.items}
            activeIndex={hash.activeIndex}
            onActiveIndexChange={(activeIndex) => updateHash({ ...hash, activeIndex })}
            onPick={(item) => {
              if (viewRef.current) pickHash(viewRef.current, item);
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

export default JotEditor;
