import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Maximize, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { parseArtifactDocument, type MemoDetail } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "./editor/EditorPaneChrome";
import { EditorTagPicker } from "./EditorTagPicker";
import { MemoTitleInput } from "./MemoTitleInput";
import { MEMO_EDITOR_TOP_ROW_CLASS_NAME } from "./MemoEditorChromeDensity";
import { downloadBlob } from "@/lib/infographic-image-export";
import type { EdgeEverRepository } from "@/lib/repository";
import { parseTagsText } from "@/lib/utils";

/**
 * The page runs as an opaque origin: scripts, forms, dialogs, popups and
 * downloads work, but it can never reach EdgeEver's cookies, storage or DOM,
 * and it cannot navigate the app. Do not add allow-same-origin or
 * allow-top-navigation*: either one breaks that isolation.
 */
export const HTML_ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

type LoadState = { status: "loading" } | { status: "ready"; html: string } | { status: "error" };

export default function HtmlArtifactReader({
  memo,
  repository,
  readOnly,
  onBackToList,
  onUpdated,
  onDelete,
  onRestore,
  onPermanentDelete,
}: {
  memo: MemoDetail;
  repository: EdgeEverRepository;
  readOnly: boolean;
  onBackToList: () => void;
  onUpdated: (memo: MemoDetail) => Promise<void>;
  onDelete: (memoId: string) => void;
  onRestore: (memoId: string) => void;
  onPermanentDelete: (memoId: string) => void;
}) {
  const { t } = useTranslation();
  const artifact = parseArtifactDocument(memo.contentMarkdown);
  const htmlResourceId = artifact?.htmlResourceId ?? null;
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [title, setTitle] = useState(memo.title ?? "");
  const [updateError, setUpdateError] = useState(false);
  const [tagsText, setTagsText] = useState(memo.tags.join(", "));
  const viewerRef = useRef<HTMLDivElement>(null);
  const savedTitleRef = useRef(memo.title ?? "");

  useEffect(() => {
    setTitle(memo.title ?? "");
    savedTitleRef.current = memo.title ?? "";
  }, [memo.title]);

  useEffect(() => {
    setTagsText(memo.tags.join(", "));
  }, [memo.tags]);

  useEffect(() => {
    if (!htmlResourceId) {
      setLoadState({ status: "error" });
      return;
    }
    let cancelled = false;
    setLoadState({ status: "loading" });
    repository.readResource(htmlResourceId)
      .then((blob) => blob.text())
      .then((html) => {
        if (!cancelled) setLoadState({ status: "ready", html });
      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [htmlResourceId, repository]);

  const commitTitle = () => {
    const next = title.trim();
    if (readOnly || !next || next === savedTitleRef.current) {
      setTitle(savedTitleRef.current);
      return;
    }
    setUpdateError(false);
    savedTitleRef.current = next;
    void repository.updateArtifactMetadata(memo, { title: next })
      .then((result) => onUpdated(result.memo))
      .catch(() => {
        savedTitleRef.current = memo.title ?? "";
        setTitle(memo.title ?? "");
        setUpdateError(true);
      });
  };

  const commitTags = (value: string) => {
    setTagsText(value);
    setUpdateError(false);
    void repository.updateArtifactMetadata(memo, { tags: parseTagsText(value) })
      .then((result) => onUpdated(result.memo))
      .catch(() => {
        setTagsText(memo.tags.join(", "));
        setUpdateError(true);
      });
  };

  const downloadHtml = () => {
    if (loadState.status !== "ready" || !artifact) return;
    downloadBlob(new Blob([loadState.html], { type: "text/html;charset=utf-8" }), artifact.originalFilename);
  };

  const enterFullscreen = () => {
    void viewerRef.current?.requestFullscreen().catch(() => undefined);
  };

  // Browsers leave fullscreen on Esc themselves, but embedded runtimes such as
  // Electron do not always do so. Keys pressed inside the page never reach this
  // document, so the browser's own Esc handling still covers that case.
  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.fullscreenElement === viewerRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
    document.addEventListener("keydown", exitOnEscape);
    return () => document.removeEventListener("keydown", exitOnEscape);
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col bg-card" data-html-artifact-reader>
      <div className={MEMO_EDITOR_TOP_ROW_CLASS_NAME}>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          <IconTooltip label={t("htmlArtifact.back")}>
            <Button className="lg:hidden" variant="ghost" size="icon" aria-label={t("htmlArtifact.back")} onClick={onBackToList}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <MemoTitleInput
            value={title}
            onValueChange={setTitle}
            readOnly={readOnly}
            placeholder={t("htmlArtifact.name")}
            ariaLabel={t("htmlArtifact.title")}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTitle(savedTitleRef.current);
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <div className="flex min-w-0 shrink items-center gap-1 pr-2">
          <EditorTagPicker
            contentMarkdown={memo.contentText}
            disabled={readOnly}
            loadTags={() => repository.listTags()}
            title={title}
            value={tagsText}
            onChange={commitTags}
          />
          {updateError && <span role="alert" className="shrink-0 text-xs text-rose-600">{t("htmlArtifact.updateFailed")}</span>}
          <IconTooltip label={t("htmlArtifact.reload")}>
            <Button variant="ghost" size="icon" aria-label={t("htmlArtifact.reload")} disabled={loadState.status !== "ready"} onClick={() => setReloadKey((key) => key + 1)}>
              <RotateCw className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("htmlArtifact.fullscreen")}>
            <Button variant="ghost" size="icon" aria-label={t("htmlArtifact.fullscreen")} disabled={loadState.status !== "ready"} onClick={enterFullscreen}>
              <Maximize className="h-4 w-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label={t("htmlArtifact.download")}>
            <Button variant="ghost" size="icon" aria-label={t("htmlArtifact.download")} disabled={loadState.status !== "ready"} onClick={downloadHtml}>
              <Download className="h-4 w-4" />
            </Button>
          </IconTooltip>
          {readOnly ? (
            <>
              <IconTooltip label={t("htmlArtifact.restore")}>
                <Button variant="ghost" size="icon" aria-label={t("htmlArtifact.restore")} onClick={() => onRestore(memo.id)}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </IconTooltip>
              <IconTooltip label={t("htmlArtifact.deleteForever")}>
                <Button variant="ghost" size="icon" className="text-rose-700" aria-label={t("htmlArtifact.deleteForever")} onClick={() => onPermanentDelete(memo.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </IconTooltip>
            </>
          ) : (
            <IconTooltip label={t("htmlArtifact.moveToTrash")}>
              <Button variant="ghost" size="icon" aria-label={t("htmlArtifact.moveToTrash")} onClick={() => onDelete(memo.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </IconTooltip>
          )}
        </div>
      </div>
      <div ref={viewerRef} className="relative min-h-0 flex-1 bg-white" data-html-artifact-viewer>
        {loadState.status === "ready" ? (
          <iframe
            key={reloadKey}
            className="h-full w-full border-0 bg-white"
            title={title || t("htmlArtifact.name")}
            sandbox={HTML_ARTIFACT_SANDBOX}
            allow="fullscreen"
            referrerPolicy="no-referrer"
            srcDoc={loadState.html}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500" role={loadState.status === "error" ? "alert" : "status"}>
            {t(loadState.status === "error" ? "htmlArtifact.loadFailed" : "htmlArtifact.loading")}
          </div>
        )}
      </div>
    </section>
  );
}
