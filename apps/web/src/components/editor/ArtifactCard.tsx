import { createContext, useContext, useEffect } from "react";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactRenderer } from "@tiptap/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FileX2 } from "lucide-react";
import { createMemoLinkHref, getArtifactSummary, parseMemoLinkHref, type MemoDetail } from "@edgeever/shared";
import { ArtifactThumbnail } from "@/components/MemoCard";

/**
 * An artifact card is stored as an ordinary paragraph holding one `#memo=` link
 * whose class carries this display marker. Clients without card support keep
 * and show a plain link; Markdown serializes it as `[title](#memo=id)`.
 */
export const ARTIFACT_CARD_LINK_CLASS = "edgeever-artifact-card";

export const artifactCardLinkAttrs = (memoId: string) => ({
  href: createMemoLinkHref(memoId),
  class: `edgeever-note-link ${ARTIFACT_CARD_LINK_CLASS}`,
});

/** The card's target when the paragraph contains nothing but one card link. */
export const getArtifactCardMemoId = (node: ProseMirrorNode): string | null => {
  if (node.type.name !== "paragraph" || node.childCount === 0) return null;
  let memoId: string | null = null;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
    if (!link || !String(link.attrs.class ?? "").split(/\s+/).includes(ARTIFACT_CARD_LINK_CLASS)) return null;
    const linkedMemoId = parseMemoLinkHref(link.attrs.href);
    if (!linkedMemoId || (memoId && memoId !== linkedMemoId)) return null;
    memoId = linkedMemoId;
  }
  return memoId;
};

export type ArtifactCardContextValue = {
  loadMemo: (memoId: string) => Promise<MemoDetail>;
  openMemo: (memoId: string) => void;
};

export const ArtifactCardContext = createContext<ArtifactCardContextValue | null>(null);

const ArtifactCardPreview = ({ memoId }: { memoId: string }) => {
  const { t } = useTranslation();
  const context = useContext(ArtifactCardContext);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["artifact-card", memoId],
    queryFn: () => {
      if (!context) throw new Error("Artifact card preview requires ArtifactCardContext");
      return context.loadMemo(memoId);
    },
    enabled: Boolean(context),
    retry: false,
  });
  // The repository answers from the local mirror first; take the server's copy when it lands.
  useEffect(() => {
    const onRefreshed = (event: Event) => {
      const memo = (event as CustomEvent<MemoDetail>).detail;
      if (memo?.id === memoId) queryClient.setQueryData(["artifact-card", memoId], memo);
    };
    window.addEventListener("edgeever:memo-detail-refreshed", onRefreshed);
    return () => window.removeEventListener("edgeever:memo-detail-refreshed", onRefreshed);
  }, [memoId, queryClient]);
  // A trashed or purged target, or one that is no longer an artifact, cannot be opened.
  const artifact = query.data && !query.data.isDeleted
    ? getArtifactSummary(query.data.contentMarkdown).artifact
    : undefined;
  const state = query.isPending ? "loading" : artifact ? "ready" : "unavailable";

  if (state === "unavailable") {
    return (
      <span className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-400" data-artifact-card-state={state}>
        <FileX2 className="h-5 w-5" aria-hidden="true" />
        {t("htmlArtifact.cardUnavailable")}
      </span>
    );
  }
  return (
    <span
      className="block cursor-pointer"
      role="link"
      tabIndex={-1}
      aria-label={t("htmlArtifact.cardOpen")}
      data-artifact-card-state={state}
      onClick={(event) => {
        if (event.button !== 0 || state !== "ready") return;
        event.preventDefault();
        context?.openMemo(memoId);
      }}
    >
      <ArtifactThumbnail resourceId={artifact?.thumbnailResourceId} />
    </span>
  );
};

const artifactCardPluginKey = new PluginKey<DecorationSet>("edgeever-artifact-card");

/** Renders card paragraphs as a bordered block with the target's thumbnail above the link title. */
export const ArtifactCardExtension = Extension.create({
  name: "edgeeverArtifactCard",
  addProseMirrorPlugins() {
    const { editor } = this;
    const renderers = new WeakMap<Node, ReactRenderer>();
    const build = (doc: ProseMirrorNode) => {
      const decorations: Decoration[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== "paragraph") return !node.isTextblock;
        const memoId = getArtifactCardMemoId(node);
        if (!memoId) return false;
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "edgeever-artifact-card-block", "data-artifact-card": memoId }),
          Decoration.widget(pos + 1, () => {
            const renderer = new ReactRenderer(ArtifactCardPreview, {
              editor,
              props: { memoId },
              as: "span",
              className: "edgeever-artifact-card-preview",
            });
            renderer.element.contentEditable = "false";
            renderers.set(renderer.element, renderer);
            return renderer.element;
          }, {
            side: -1,
            key: `artifact-card:${memoId}`,
            ignoreSelection: true,
            stopEvent: () => true,
            destroy: (dom) => {
              renderers.get(dom)?.destroy();
              renderers.delete(dom);
            },
          }),
        );
        return false;
      });
      return DecorationSet.create(doc, decorations);
    };

    return [new Plugin<DecorationSet>({
      key: artifactCardPluginKey,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, decorations) => (tr.docChanged ? build(tr.doc) : decorations),
      },
      props: {
        decorations: (state) => artifactCardPluginKey.getState(state),
      },
    })];
  },
});
