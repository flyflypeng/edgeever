import { useState, useEffect, useRef } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Notebook } from "@edgeever/shared";

// Types derived from App.tsx
export type MemoDeleteConfirmation = { kind: "single" | "bulk"; memoIds: string[]; permanent: boolean };
// `artifact` switches the wording to Artifact Folders / the Artifact Library.
export type NotebookNameDialogState =
  | { mode: "create"; parentId: string | null; artifact?: boolean }
  | { mode: "rename"; notebook: Notebook; artifact?: boolean };

export const AppConfirmDialog = ({
  cancelLabel,
  confirmLabel,
  description,
  details,
  error,
  hideCancel = false,
  isWorking = false,
  title,
  tone = "danger",
  onCancel,
  onConfirm,
}: {
  cancelLabel?: string;
  confirmLabel: string;
  description: string;
  /** One line per item, listed below the description. */
  details?: string[];
  error?: string | null;
  hideCancel?: boolean;
  isWorking?: boolean;
  title: string;
  tone?: "danger" | "neutral" | "primary";
  closeOnBrowserBack?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const { t } = useTranslation();
  const toneClassName =
    tone === "danger"
      ? "bg-rose-50 text-rose-700"
      : tone === "primary"
        ? "bg-slate-100 text-slate-800"
        : "bg-slate-100 text-slate-600";
  const confirmVariant = tone === "danger" ? "danger" : "solid";
  const Icon = tone === "danger" ? AlertTriangle : ShieldCheck;

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !isWorking) onCancel(); }}>
      <DialogContent className="max-w-md p-0 overflow-hidden border border-slate-200 bg-card shadow-lg rounded-lg">
        <DialogHeader className="flex flex-row items-start gap-4 border-b border-slate-200 px-5 py-5 text-left">
          <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", toneClassName)}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-semibold text-slate-950">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm leading-5 text-slate-500">
              {description}
            </DialogDescription>
            {details?.length ? (
              <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto break-words text-xs leading-5 text-slate-600" data-notice-details>
                {details.map((detail, index) => <li key={index}>{detail}</li>)}
              </ul>
            ) : null}
            {error ? <p className="mt-2 text-xs leading-5 text-rose-600" role="alert">{error}</p> : null}
          </div>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:justify-end border-t border-slate-50 bg-slate-50/50">
          {!hideCancel && (
            <Button className="justify-center" variant="outline" onClick={onCancel} disabled={isWorking}>
              {cancelLabel ?? t("common.cancel")}
            </Button>
          )}
          <Button className="justify-center" variant={confirmVariant} onClick={onConfirm} disabled={isWorking}>
            {isWorking ? t("common.processing") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const MemoDeleteConfirmDialog = ({
  confirmation,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  confirmation: MemoDeleteConfirmation;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const { t } = useTranslation();
  const count = confirmation.memoIds.length;
  const isBulk = confirmation.kind === "bulk" || count > 1;
  const title = confirmation.permanent
    ? isBulk
      ? t("dialogs.memoDelete.permanentBulkTitle", { count })
      : t("dialogs.memoDelete.permanentSingleTitle")
    : isBulk
      ? t("dialogs.memoDelete.softBulkTitle", { count })
      : t("dialogs.memoDelete.softSingleTitle");
  const description = confirmation.permanent ? t("dialogs.memoDelete.permanentDescription") : t("dialogs.memoDelete.softDescription");
  const confirmLabel = confirmation.permanent ? t("dialogs.memoDelete.permanentConfirm") : t("dialogs.memoDelete.softConfirm");

  return (
    <AppConfirmDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone="danger"
      isWorking={isDeleting}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
};

export const NotebookNameDialog = ({
  dialog,
  isSaving,
  onCancel,
  onSubmit,
}: {
  dialog: NotebookNameDialogState;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) => {
  const { t } = useTranslation();
  const initialName = dialog.mode === "rename" ? dialog.notebook.name : "";
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmedName = name.trim();
  const unchanged = dialog.mode === "rename" && trimmedName === dialog.notebook.name;
  const artifactLibraryRename = dialog.mode === "rename" && dialog.notebook.systemKind === "artifact_library";
  const title = dialog.artifact
    ? t(dialog.mode === "create" ? "artifactLibrary.folderName.createTitle" : artifactLibraryRename ? "artifactLibrary.folderName.libraryRenameTitle" : "artifactLibrary.folderName.renameTitle")
    : dialog.mode === "create" ? t("dialogs.notebookName.createTitle") : t("dialogs.notebookName.renameTitle");
  const description = dialog.artifact
    ? t(dialog.mode === "create" ? "artifactLibrary.folderName.createDescription" : "artifactLibrary.folderName.renameDescription")
    : dialog.mode === "create" ? t("dialogs.notebookName.createDescription") : t("dialogs.notebookName.renameDescription");
  const submitLabel = dialog.mode === "create" ? t("dialogs.notebookName.createSubmit") : t("common.save");

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !isSaving) onCancel(); }}>
      <DialogContent className="max-w-md p-0 overflow-hidden border border-slate-200 bg-card shadow-lg rounded-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmedName || unchanged || isSaving) {
              return;
            }
            onSubmit(trimmedName);
          }}
        >
          <DialogHeader className="flex flex-row items-start justify-between gap-3 border-b border-slate-200 px-5 py-5 text-left">
            <div className="min-w-0">
              <DialogTitle className="font-semibold text-slate-950">
                {title}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-slate-500">
                {description}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="px-5 py-5">
            <label className="block text-xs font-semibold uppercase text-slate-500" htmlFor="notebook-name-input">
              {t("dialogs.notebookName.nameLabel")}
            </label>
            <Input
              id="notebook-name-input"
              ref={inputRef}
              className="mt-2 h-11 text-base focus-visible:border-slate-400 focus-visible:ring-slate-900/10"
              value={name}
              disabled={isSaving}
              maxLength={80}
              placeholder={dialog.artifact ? t("artifactLibrary.folderName.namePlaceholder") : t("dialogs.notebookName.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter className="flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:justify-end border-t border-slate-50 bg-slate-50/50">
            <Button className="justify-center" type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
              {t("common.cancel")}
            </Button>
            <Button className="justify-center" type="submit" variant="solid" disabled={!trimmedName || unchanged || isSaving}>
              {isSaving ? t("common.saving") : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
