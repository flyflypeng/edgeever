import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_TAG_LENGTH, findTagNode, normalizeTagPath, planTagRename, resolveTagNodeKey, splitTagPath, type TagTreeNode } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AppConfirmDialog } from "@/components/dialogs/ConfirmDialogs";

/**
 * Renaming a tag edits its full path, so changing `a/b` to `b/a` moves it. The
 * dialog previews the whole rewritten subtree and asks for confirmation before
 * merging into a path that already exists.
 */
export const TagRenameDialog = ({
  node,
  tree,
  busy,
  onOpenChange,
  onSubmit,
}: {
  node: TagTreeNode | null;
  tree: readonly TagTreeNode[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (newPath: string) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);

  useEffect(() => {
    setValue(node?.key ?? "");
    setMergeOpen(false);
  }, [node]);

  const plan = useMemo(() => {
    if (!node) return null;
    const normalized = normalizeTagPath(value);
    const target = findTagNode(tree, resolveTagNodeKey(normalized));
    return planTagRename(node, value, {
      mergeTarget: target && target.key !== node.key ? { count: target.count } : null,
    });
  }, [node, tree, value]);

  const error = plan && !plan.ok
    ? plan.reason === "empty_path"
      ? t("tagTree.renameEmpty")
      : t("tagTree.renameTooLong", { name: longestTarget(node, value) })
    : null;

  const submit = async () => {
    if (!plan?.ok) return;
    if (plan.mergesInto) {
      setMergeOpen(true);
      return;
    }
    await onSubmit(value);
  };

  return (
    <>
      <Dialog open={Boolean(node)} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("tagTree.renameTitle")}</DialogTitle>
            <DialogDescription>{t("tagTree.renameDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-600" htmlFor="tag-rename-path">{t("tagTree.renameLabel")}</label>
            <Input
              id="tag-rename-path"
              value={value}
              maxLength={MAX_TAG_LENGTH}
              autoFocus
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <p className="text-xs text-slate-500">{t("tagTree.renameHint")}</p>
            {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="button" disabled={Boolean(error) || busy} onClick={() => void submit()}>
              {busy ? t("tagTree.working") : t("tagTree.rename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mergeOpen ? (
        <AppConfirmDialog
          title={t("tagTree.renameMergeTitle")}
          description={t("tagTree.renameMergeDescription", {
            name: normalizeTagPath(value),
            count: plan?.ok ? plan.mergesInto?.count ?? 0 : 0,
          })}
          confirmLabel={t("tagTree.renameMergeConfirm")}
          tone="primary"
          isWorking={busy}
          onCancel={() => setMergeOpen(false)}
          onConfirm={() => {
            setMergeOpen(false);
            void onSubmit(value);
          }}
        />
      ) : null}
    </>
  );
};

/** The rewritten name that breaks the 80 character limit, for the error message. */
const longestTarget = (node: TagTreeNode | null, value: string) => {
  if (!node) return "";
  const levels = splitTagPath(value);
  const depth = node.key.split("/").filter(Boolean).length;
  let longest = levels.join("/");
  for (const name of node.subtreeNames) {
    const candidate = [...levels, ...splitTagPath(name).slice(depth)].join("/");
    if (candidate.length > longest.length) longest = candidate;
  }
  return longest;
};
