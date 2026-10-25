import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export const JOT_UNDO_NOTICE_DURATION_MS = 5000;

export type JotUndoNoticeState = {
  id: number;
  message: string;
  tone?: "default" | "error";
  onUndo?: () => void;
};

/** Bottom-centred status bar with an optional undo action; dismisses itself after five seconds. */
export const JotUndoNotice = ({
  notice,
  onDismiss,
}: {
  notice: JotUndoNoticeState | null;
  onDismiss: () => void;
}) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, JOT_UNDO_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice || typeof document === "undefined") return null;

  const isError = notice.tone === "error";
  return createPortal(
    <div
      key={notice.id}
      className={cn(
        "fixed bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+4.5rem))] left-1/2 z-[120] inline-flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium shadow-lg sm:max-w-xl lg:bottom-[max(1.25rem,env(safe-area-inset-bottom))]",
        isError ? "bg-rose-600 text-rose-50" : "bg-slate-900 text-slate-50",
      )}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <span className="min-w-0 truncate">{notice.message}</span>
      {notice.onUndo ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold text-emerald-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          onClick={() => {
            const undo = notice.onUndo;
            onDismiss();
            undo?.();
          }}
        >
          {t("jot.undo")}
        </button>
      ) : null}
    </div>,
    document.body,
  );
};
