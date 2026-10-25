import { useState, type ComponentType } from "react";
import type { StateCommand } from "@codemirror/state";
import type { EditorView } from "@uiw/react-codemirror";
import {
  Bold,
  CircleHelp,
  Code,
  Heading,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Sigma,
  SquareCode,
  Strikethrough,
  Table,
  Table2,
  TextQuote,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTable, insertCodeBlock, insertLink, insertTable, toggleLinePrefix, toggleWrap } from "./jot-editor-commands";

const MARKDOWN_SYNTAX_HELP_URL = "https://commonmark.org/help/";
const TABLE_PICKER_SIZE = 8;

type FormatAction = {
  /** Key suffix under `jot.editor.format.` */
  id: string;
  icon: ComponentType<{ className?: string }>;
  run: StateCommand;
};

/** Format bar buttons in display order (memos FormatBar parity). The table picker sits before `formatTable`. */
const FORMAT_ACTIONS: FormatAction[] = [
  { id: "heading", icon: Heading, run: toggleLinePrefix("heading") },
  { id: "bold", icon: Bold, run: toggleWrap("**", "text") },
  { id: "italic", icon: Italic, run: toggleWrap("*", "text") },
  { id: "strikethrough", icon: Strikethrough, run: toggleWrap("~~", "text") },
  { id: "quote", icon: TextQuote, run: toggleLinePrefix("quote") },
  { id: "bulletList", icon: List, run: toggleLinePrefix("bullet") },
  { id: "orderedList", icon: ListOrdered, run: toggleLinePrefix("ordered") },
  { id: "task", icon: ListTodo, run: toggleLinePrefix("task") },
  { id: "inlineCode", icon: Code, run: toggleWrap("`", "code") },
  { id: "codeBlock", icon: SquareCode, run: insertCodeBlock },
  { id: "link", icon: Link, run: insertLink },
  { id: "math", icon: Sigma, run: toggleWrap("$", "x^2") },
];

const iconButtonClassName =
  "grid size-6 shrink-0 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:pointer-events-none disabled:opacity-40";

export type JotFormatBarProps = {
  getView: () => EditorView | null;
  previewing: boolean;
  onPreviewChange: (previewing: boolean) => void;
  /** Keeps the bar visible while one of its menus has focus. */
  onMenuOpenChange: (open: boolean) => void;
  className?: string;
};

export function JotFormatBar({ getView, previewing, onPreviewChange, onMenuOpenChange, className }: JotFormatBarProps) {
  const { t } = useTranslation();
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const [tableSize, setTableSize] = useState({ rows: 3, cols: 3 });

  const runCommand = (command: StateCommand) => {
    const view = getView();
    if (!view) return;
    command(view);
    view.focus();
  };

  const setTableMenu = (open: boolean) => {
    setTableMenuOpen(open);
    onMenuOpenChange(open);
    if (!open) setTableSize({ rows: 3, cols: 3 });
  };

  const actionButton = (action: FormatAction) => {
    const label = t(`jot.editor.format.${action.id}`);
    return (
      <Tooltip key={action.id}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={iconButtonClassName}
            aria-label={label}
            disabled={previewing}
            onClick={() => runCommand(action.run)}
          >
            <action.icon className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div
      className={cn("flex w-full items-center gap-1 border-b border-slate-100 px-2 pb-1 pt-1.5", className)}
      // Keep the editor focused while clicking the bar so the bar does not hide itself.
      // React events bubble through portals, so this also covers the table picker.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
        {FORMAT_ACTIONS.map(actionButton)}
        <DropdownMenu open={tableMenuOpen} onOpenChange={setTableMenu}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button type="button" className={iconButtonClassName} aria-label={t("jot.editor.format.table")} disabled={previewing}>
                  <Table className="size-4" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("jot.editor.format.table")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="p-2"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              getView()?.focus();
            }}
          >
            <div
              className="grid gap-0.5"
              style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_SIZE}, 1rem)` }}
              onMouseLeave={() => setTableSize({ rows: 3, cols: 3 })}
            >
              {Array.from({ length: TABLE_PICKER_SIZE * TABLE_PICKER_SIZE }, (_, index) => {
                const rows = Math.floor(index / TABLE_PICKER_SIZE) + 1;
                const cols = (index % TABLE_PICKER_SIZE) + 1;
                const active = rows <= tableSize.rows && cols <= tableSize.cols;
                return (
                  <button
                    key={index}
                    type="button"
                    aria-label={`${cols} × ${rows}`}
                    className={cn(
                      "size-4 rounded-sm border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                      active ? "border-emerald-500 bg-emerald-100" : "border-slate-300",
                    )}
                    onMouseEnter={() => setTableSize({ rows, cols })}
                    onFocus={() => setTableSize({ rows, cols })}
                    onClick={() => {
                      setTableMenu(false);
                      runCommand(insertTable(rows, cols));
                    }}
                  />
                );
              })}
            </div>
            <div className="mt-1 text-center text-xs tabular-nums text-slate-500">
              {tableSize.cols} × {tableSize.rows}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        {actionButton({ id: "formatTable", icon: Table2, run: formatTable })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            className={cn(iconButtonClassName, "text-slate-400")}
            href={MARKDOWN_SYNTAX_HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("jot.editor.syntaxHelp")}
          >
            <CircleHelp className="size-4" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("jot.editor.syntaxHelp")}</TooltipContent>
      </Tooltip>
      <div className="flex shrink-0 items-center overflow-hidden rounded border border-slate-200 text-xs" role="group">
        {[false, true].map((preview) => (
          <button
            key={String(preview)}
            type="button"
            aria-pressed={previewing === preview}
            className={cn(
              "px-2 py-0.5 leading-5 transition-colors",
              previewing === preview ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50",
            )}
            onClick={() => onPreviewChange(preview)}
          >
            {preview ? t("jot.editor.preview") : t("jot.editor.edit")}
          </button>
        ))}
      </div>
    </div>
  );
}
