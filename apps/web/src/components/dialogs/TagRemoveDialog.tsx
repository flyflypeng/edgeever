import { useTranslation } from "react-i18next";
import type { TagTreeNode } from "@edgeever/shared";
import { AppConfirmDialog } from "@/components/dialogs/ConfirmDialogs";

/**
 * Removing a tag drops it and every tag below it from the notes that carry
 * them; the notes themselves stay.
 */
export const TagRemoveDialog = ({
  node,
  busy,
  onOpenChange,
  onConfirm,
}: {
  node: TagTreeNode | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) => {
  const { t } = useTranslation();
  if (!node) return null;

  return (
    <AppConfirmDialog
      title={t("tagTree.removeTitle", { name: node.key })}
      description={t("tagTree.removeDescription", { count: node.count })}
      confirmLabel={t("tagTree.removeConfirm")}
      isWorking={busy}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void onConfirm()}
    />
  );
};
