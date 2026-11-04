import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as m from "motion/react-m";
import { ChevronDown, MoreHorizontal, Pencil, Tag as TagIcon, Trash2 } from "lucide-react";
import {
  findTagNode,
  planTagRemoval,
  planTagRename,
  tagNodeAncestorKeys,
  type TagTreeNode,
} from "@edgeever/shared";
import type { EdgeEverRepository } from "@/lib/repository";
import {
  focusTreeButton,
  readTagTreeExpandedKeysPreference,
  readTagTreeSectionCollapsedPreference,
  writeTagTreeExpandedKeysPreference,
  writeTagTreeSectionCollapsedPreference,
} from "@/lib/app-helpers";
import { cn } from "@/lib/utils";
import { treeEnterMotion } from "@/lib/motion";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TagRenameDialog } from "@/components/dialogs/TagRenameDialog";
import { TagRemoveDialog } from "@/components/dialogs/TagRemoveDialog";

export const TAG_TREE_QUERY_KEY = ["tagTree"] as const;

const TagTreeItem = ({
  node,
  depth,
  selectedTagKey,
  expandedKeys,
  onToggle,
  onSelect,
  onRename,
  onRemove,
}: {
  node: TagTreeNode;
  depth: number;
  selectedTagKey: string | null;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  onSelect: (key: string) => void;
  onRename: (node: TagTreeNode) => void;
  onRemove: (node: TagTreeNode) => void;
}) => {
  const { t } = useTranslation();
  const open = expandedKeys.has(node.key);
  const hasChildren = node.children.length > 0;
  const selected = node.key === selectedTagKey;
  const name = node.label || node.icon || node.key;
  const [actionsOpen, setActionsOpen] = useState(false);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex h-9 items-center gap-1 rounded-md pr-1 transition-colors duration-200",
              selected ? "edgeever-workspace-selection" : "hover:bg-slate-50"
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            data-tag-tree-node={node.key}
          >
            {hasChildren ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex h-6 w-5 items-center justify-center rounded transition-colors hover:bg-slate-100/50"
                      type="button"
                      onClick={() => onToggle(node.key, !open)}
                      aria-label={open ? t("tagTree.collapse", { name }) : t("tagTree.expand", { name })}
                      aria-expanded={open}
                    >
                      <ChevronDown
                        className={cn("h-4 w-4 transition-transform duration-150 ease-out", open ? "rotate-0" : "-rotate-90")}
                        aria-hidden="true"
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("tagTree.expandCollapse")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <span className="h-6 w-5 shrink-0" aria-hidden="true" />
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-tag-tree-button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    type="button"
                    aria-label={t(selected ? "tagTree.current" : "tagTree.switchTo", { name, count: node.count })}
                    aria-current={selected ? "page" : undefined}
                    aria-expanded={hasChildren ? open : undefined}
                    onClick={() => onSelect(node.key)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        focusTreeButton(
                          event.currentTarget,
                          event.key === "Home" ? "first" : event.key === "End" ? "last" : event.key === "ArrowDown" ? "next" : "previous",
                          "[data-tag-tree]",
                          "[data-tag-tree-button]",
                        );
                        return;
                      }
                      if (event.key === "ArrowRight" && hasChildren && !open) {
                        event.preventDefault();
                        onToggle(node.key, true);
                        return;
                      }
                      if (event.key === "ArrowLeft" && hasChildren && open) {
                        event.preventDefault();
                        onToggle(node.key, false);
                      }
                    }}
                  >
                    {node.icon ? (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[15px] leading-none" aria-hidden="true">{node.icon}</span>
                    ) : (
                      <TagIcon className={cn("h-3.5 w-3.5 shrink-0 transition-colors duration-200", selected ? "text-slate-950" : "text-slate-500")} aria-hidden="true" />
                    )}
                    <span
                      className={cn(
                        "truncate text-sm transition-colors duration-200",
                        selected ? "font-semibold text-black dark:text-slate-950" : "font-medium text-slate-800 group-hover:text-slate-950",
                      )}
                    >
                      {node.label}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 tabular-nums text-xs font-normal transition-colors duration-200",
                        selected ? "font-medium text-slate-900" : "text-slate-400 group-hover:text-slate-500",
                      )}
                      aria-hidden="true"
                    >
                      {node.count}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{node.key}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="relative shrink-0">
              <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          className={cn(
                            "edgeever-reveal-on-touch h-6 w-6 items-center justify-center rounded-md transition-colors duration-150",
                            actionsOpen ? "flex" : "hidden group-focus-within:flex group-hover:flex",
                            selected ? "hover:bg-slate-200" : "hover:bg-slate-100",
                          )}
                          type="button"
                          aria-label={t("tagTree.actionsAria", { name })}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{t("tagTree.actions")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem className="flex h-9 items-center gap-2 px-3 text-xs" onSelect={() => onRename(node)}>
                    <Pencil className="h-4 w-4" />
                    {t("tagTree.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="flex h-9 items-center gap-2 px-3 text-xs text-rose-700"
                    onSelect={() => onRemove(node)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("tagTree.remove")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48 rounded-md border border-slate-200 bg-card py-1 shadow-md">
          <ContextMenuItem className="flex h-9 cursor-pointer items-center gap-2 px-3 text-xs" onClick={() => onRename(node)}>
            <Pencil className="h-4 w-4" />
            {t("tagTree.rename")}
          </ContextMenuItem>
          <ContextMenuSeparator className="my-1 h-px bg-slate-100" />
          <ContextMenuItem
            className="flex h-9 cursor-pointer items-center gap-2 px-3 text-xs text-rose-700 outline-none hover:bg-rose-50"
            onClick={() => onRemove(node)}
          >
            <Trash2 className="h-4 w-4" />
            {t("tagTree.remove")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {hasChildren && open ? (
        <m.div className="mt-1 space-y-1" {...treeEnterMotion}>
          {node.children.map((child) => (
            <TagTreeItem
              key={child.key}
              node={child}
              depth={depth + 1}
              selectedTagKey={selectedTagKey}
              expandedKeys={expandedKeys}
              onToggle={onToggle}
              onSelect={onSelect}
              onRename={onRename}
              onRemove={onRemove}
            />
          ))}
        </m.div>
      ) : null}
    </div>
  );
};

export const TagTreeSection = ({
  repository,
  tree,
  isLoading,
  selectedTagKey,
  onSelectTag,
  onTagRenamed,
  revealRequest,
}: {
  repository: EdgeEverRepository;
  tree: readonly TagTreeNode[];
  isLoading: boolean;
  selectedTagKey: string | null;
  onSelectTag: (key: string, tagNames: string[]) => void;
  /** Reports a finished subtree rename so an active filter can follow it. */
  onTagRenamed?: (oldKey: string, newKey: string) => void;
  /** Bumped by the toolbar entry points to expand the section and scroll to it. */
  revealRequest?: number;
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [sectionCollapsed, setSectionCollapsed] = useState(readTagTreeSectionCollapsedPreference);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(readTagTreeExpandedKeysPreference);
  const [renameNode, setRenameNode] = useState<TagTreeNode | null>(null);
  const [removeNode, setRemoveNode] = useState<TagTreeNode | null>(null);
  const [failureCount, setFailureCount] = useState(0);

  const handleToggle = useCallback((key: string, open: boolean) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      writeTagTreeExpandedKeysPreference(next);
      return next;
    });
  }, []);

  const handleSelect = useCallback((key: string) => {
    const node = findTagNode(tree, key);
    if (!node) return;
    onSelectTag(node.key, node.subtreeNames);
  }, [onSelectTag, tree]);

  useEffect(() => {
    if (!revealRequest) return;
    setSectionCollapsed((previous) => {
      if (!previous) return previous;
      writeTagTreeSectionCollapsedPreference(false);
      return false;
    });
    sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealRequest]);

  // Keep the selected node visible when a note card selects a deep tag.
  useEffect(() => {
    if (!selectedTagKey) return;
    const ancestors = tagNodeAncestorKeys(selectedTagKey);
    if (ancestors.length === 0) return;
    setExpandedKeys((previous) => {
      if (ancestors.every((key) => previous.has(key))) return previous;
      const next = new Set(previous);
      for (const key of ancestors) next.add(key);
      writeTagTreeExpandedKeysPreference(next);
      return next;
    });
  }, [selectedTagKey]);

  useEffect(() => {
    if (!selectedTagKey) return;
    const element = sectionRef.current?.querySelector(`[data-tag-tree-node="${CSS.escape(selectedTagKey)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [selectedTagKey, tree]);

  const renameMutation = useMutation({
    mutationFn: async (input: { node: TagTreeNode; newPath: string }) => {
      const plan = planTagRename(input.node, input.newPath);
      if (!plan.ok) return { ok: false as const, reason: plan.reason, failed: 0, oldKey: input.node.key, newKey: input.node.key };
      let failed = 0;
      for (const operation of plan.operations) {
        try {
          await repository.renameTag(operation.from, operation.to);
        } catch {
          failed += 1;
        }
      }
      return { ok: true as const, failed, newKey: plan.newKey, oldKey: input.node.key };
    },
    onSettled: async (result) => {
      if (result?.ok && result.oldKey !== result.newKey) {
        onTagRenamed?.(result.oldKey, result.newKey);
        setExpandedKeys((previous) => {
          const next = new Set<string>();
          for (const key of previous) {
            if (key === result.oldKey) next.add(result.newKey);
            else if (key.startsWith(`${result.oldKey}/`)) next.add(`${result.newKey}${key.slice(result.oldKey.length)}`);
            else next.add(key);
          }
          writeTagTreeExpandedKeysPreference(next);
          return next;
        });
      }
      await queryClient.invalidateQueries({ queryKey: TAG_TREE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (node: TagTreeNode) => {
      const plan = planTagRemoval(node);
      let failed = 0;
      for (const name of plan.names) {
        try {
          await repository.deleteTag(name);
        } catch {
          failed += 1;
        }
      }
      return { failed };
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TAG_TREE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["tags"] });
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
    },
  });

  useEffect(() => {
    const failed = renameMutation.data?.failed ?? removeMutation.data?.failed ?? 0;
    setFailureCount(failed);
  }, [removeMutation.data, renameMutation.data]);

  const isBusy = renameMutation.isPending || removeMutation.isPending;

  return (
    <section ref={sectionRef} aria-label={t("tagTree.title")} data-tag-tree-section className="mt-2">
      <div className="group mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left text-xs font-medium leading-none tracking-wide text-slate-500 transition-colors duration-200 hover:bg-slate-50 hover:text-slate-900"
          aria-expanded={!sectionCollapsed}
          onClick={() => {
            setSectionCollapsed((previous) => {
              writeTagTreeSectionCollapsedPreference(!previous);
              return !previous;
            });
          }}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center"><TagIcon className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1 truncate">{t("tagTree.title")}</span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 transition-transform duration-150 ease-out", sectionCollapsed ? "-rotate-90" : "rotate-0")}
            aria-hidden="true"
          />
        </button>
      </div>

      {sectionCollapsed ? null : isLoading ? (
        <div className="px-3 py-2 text-xs text-slate-500">{t("tagTree.loading")}</div>
      ) : tree.length === 0 ? (
        <p className="px-3 py-2 text-xs leading-5 text-slate-500">{t("tagTree.empty")}</p>
      ) : (
        <div className="mb-4 space-y-1" data-tag-tree>
          {tree.map((node) => (
            <TagTreeItem
              key={node.key}
              node={node}
              depth={0}
              selectedTagKey={selectedTagKey}
              expandedKeys={expandedKeys}
              onToggle={handleToggle}
              onSelect={handleSelect}
              onRename={setRenameNode}
              onRemove={setRemoveNode}
            />
          ))}
        </div>
      )}

      {failureCount > 0 ? (
        <p className="px-3 pb-2 text-xs text-rose-600" role="status">{t("tagTree.partialFailure", { count: failureCount })}</p>
      ) : null}

      <TagRenameDialog
        node={renameNode}
        tree={tree}
        busy={isBusy}
        onOpenChange={(open) => {
          if (!open) setRenameNode(null);
        }}
        onSubmit={async (newPath) => {
          if (!renameNode) return;
          await renameMutation.mutateAsync({ node: renameNode, newPath });
          setRenameNode(null);
        }}
      />
      <TagRemoveDialog
        node={removeNode}
        busy={isBusy}
        onOpenChange={(open) => {
          if (!open) setRemoveNode(null);
        }}
        onConfirm={async () => {
          if (!removeNode) return;
          await removeMutation.mutateAsync(removeNode);
          setRemoveNode(null);
        }}
      />
    </section>
  );
};
