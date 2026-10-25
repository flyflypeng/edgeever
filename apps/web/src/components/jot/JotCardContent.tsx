import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import Lightbox, { type Slide } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { parseMemoLinkHref } from "@edgeever/shared";
import { JOT_CONTENT_CLASS, renderJotMarkdownHtml } from "@/lib/jot-markdown";
import { cn } from "@/lib/utils";

// Cards whose text is taller than this fold behind "Show all". Image galleries do not count, so a
// short note with photos stays fully visible (memos folds text, not attachments).
const JOT_FOLD_HEIGHT_PX = 260;

export type JotCardContentProps = {
  markdown: string;
  /** Long content folds with an expand toggle; review cards may opt out. */
  collapsible?: boolean;
  /** Enables clickable task checkboxes; receives the task index in document order. */
  onToggleTask?: (index: number) => void;
  /** Called for `#memo=` note links inside the content. */
  onOpenMemo?: (memoId: string) => void;
  className?: string;
};

export const JotCardContent = ({ markdown, collapsible = true, onToggleTask, onOpenMemo, className }: JotCardContentProps) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{ index: number; slides: Slide[] } | null>(null);
  const interactiveTasks = Boolean(onToggleTask);

  const html = useMemo(() => renderJotMarkdownHtml(markdown, {
    interactiveTasks,
    toggleTaskLabel: t("jot.card.toggleTask"),
    viewImageLabel: (name) => t("jot.card.viewImage", { name }),
  }), [interactiveTasks, markdown, t]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !collapsible) {
      setOverflowing(false);
      return;
    }
    const measure = () => {
      const galleryHeight = Array.from(element.querySelectorAll<HTMLElement>("[data-jot-gallery]"))
        .reduce((sum, gallery) => sum + gallery.offsetHeight, 0);
      setOverflowing(element.scrollHeight - galleryHeight > JOT_FOLD_HEIGHT_PX + 8);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Images change the height after they load.
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [collapsible, html]);

  useEffect(() => {
    if (!overflowing) setExpanded(false);
  }, [overflowing]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const taskButton = target.closest<HTMLElement>("[data-jot-task-index]");
    if (taskButton && onToggleTask) {
      event.preventDefault();
      event.stopPropagation();
      onToggleTask(Number(taskButton.dataset.jotTaskIndex));
      return;
    }

    const imageButton = target.closest<HTMLElement>("[data-jot-image-index]");
    if (imageButton && contentRef.current) {
      event.preventDefault();
      const slides = Array.from(contentRef.current.querySelectorAll<HTMLImageElement>("[data-jot-image-index] img"))
        .map((image) => ({ src: image.currentSrc || image.src, alt: image.alt }));
      setLightbox({ index: Number(imageButton.dataset.jotImageIndex) || 0, slides });
      return;
    }

    const memoLink = target.closest<HTMLAnchorElement>("a[data-jot-memo-link]");
    if (memoLink) {
      event.preventDefault();
      const memoId = parseMemoLinkHref(memoLink.getAttribute("href"));
      if (memoId) onOpenMemo?.(memoId);
    }
  };

  const folded = overflowing && !expanded;

  return (
    <div className={className}>
      <div
        ref={contentRef}
        className={cn(JOT_CONTENT_CLASS, "relative", folded && "max-h-[232px] overflow-hidden")}
        onClick={handleClick}
        // Sanitized by renderJotMarkdownHtml (DOMPurify).
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {folded ? (
        <div className="pointer-events-none relative -mt-16 h-16 bg-gradient-to-b from-transparent to-card" aria-hidden="true" />
      ) : null}
      {overflowing ? (
        <button
          type="button"
          className="mt-1.5 inline-flex items-center gap-0.5 rounded-md py-0.5 pr-1.5 text-[12.5px] text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("jot.card.collapse") : t("jot.card.expand")}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      ) : null}
      {lightbox ? (
        <Lightbox
          open
          index={lightbox.index}
          slides={lightbox.slides}
          close={() => setLightbox(null)}
          plugins={[Zoom]}
          carousel={{ finite: lightbox.slides.length <= 1, padding: 24, imageFit: "contain" }}
          controller={{ closeOnBackdropClick: true }}
          render={lightbox.slides.length <= 1 ? { buttonPrev: () => null, buttonNext: () => null } : undefined}
          labels={{
            Close: t("common.close"),
            "Photo gallery": t("editor.imageViewer"),
            "Zoom in": t("editor.imageZoomIn"),
            "Zoom out": t("editor.imageZoomOut"),
          }}
        />
      ) : null}
    </div>
  );
};
