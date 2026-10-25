import { createPortal } from "react-dom";
import { Hash, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";

export type JotTagSuggestion = { tag: string; create: boolean };

export type JotTagSuggestionsProps = {
  /** Viewport coordinates of the `#` that opened the list. */
  position: { top: number; left: number };
  query: string;
  items: JotTagSuggestion[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (item: JotTagSuggestion) => void;
};

/** `#` completion list. Keyboard handling stays in the editor so CodeMirror keeps focus. */
export function JotTagSuggestions({ position, query, items, activeIndex, onActiveIndexChange, onPick }: JotTagSuggestionsProps) {
  const { t } = useTranslation();
  return createPortal(
    <div
      className="fixed z-[90] w-56 rounded-lg border border-slate-200 bg-card p-1 shadow-lg"
      style={{ top: position.top + 4, left: position.left }}
      // Keep CodeMirror focused while choosing with the mouse.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Command
        shouldFilter={false}
        value={String(activeIndex)}
        onValueChange={(value) => onActiveIndexChange(Number(value))}
        className="bg-transparent"
      >
        <CommandList className="max-h-56">
          <CommandGroup heading={query ? t("jot.editor.pickTag") : t("jot.editor.recentTags")}>
            {items.map((item, index) => (
              <CommandItem
                key={`${item.create ? "create" : "tag"}:${item.tag}`}
                value={String(index)}
                onSelect={() => onPick(item)}
                className="min-h-8 gap-2 text-[13px]"
              >
                {item.create ? <Plus className="size-3.5 text-slate-500" /> : <Hash className="size-3.5 text-slate-500" />}
                <span className="truncate">{item.create ? t("jot.editor.createTag", { tag: item.tag }) : item.tag}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>,
    document.body,
  );
}
