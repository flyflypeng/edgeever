import type { ArtifactSummary, MemoDetail } from "@edgeever/shared";
import { HTML_ARTIFACT_SANDBOX } from "@/lib/html-artifact-sandbox";
import { ArtifactCaptureError, connectArtifactBridge, createArtifactBridge } from "@/lib/html-artifact-bridge";

/** Thumbnails are this wide; the height follows the 16:10 first screen. */
export const ARTIFACT_THUMBNAIL_WIDTH = 480;
// The page is laid out at a common laptop width so the first screen looks like a browser's.
const RENDER_WIDTH = 1280;
const RENDER_HEIGHT = 800;
const MAX_CONCURRENT_RENDERS = 2;
// Pages often draw their first screen after `load` (fonts, charts, animations).
const SETTLE_DELAY_MS = 800;

type ThumbnailTarget = { memoId: string; artifact: Pick<ArtifactSummary, "htmlResourceId" | "sha256"> };

export type ArtifactThumbnailDeps = {
  readResource: (resourceId: string) => Promise<Blob>;
  uploadThumbnail: (memoId: string, image: Blob, sourceSha256: string) => Promise<{ memo: MemoDetail }>;
  onUploaded: (memo: MemoDetail) => void;
};

let webpEncoding: boolean | undefined;
const canEncodeWebp = () => {
  if (webpEncoding === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    webpEncoding = canvas.toDataURL("image/webp").startsWith("data:image/webp");
  }
  return webpEncoding;
};

/**
 * Renders the first screen of a page in a hidden frame with the reader's
 * sandbox and returns a 480 px wide image, WebP when the browser can encode it.
 * Rejects with an {@link ArtifactCaptureError}; `tainted` means the picture
 * would be missing cross-origin content and must not be used.
 */
export const renderArtifactThumbnail = async (html: string) => {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-artifact-thumbnail-renderer", "");
  // Off screen but laid out and painted at full size: hidden or zero-sized
  // frames skip layout, and some pages wait for visibility before drawing.
  Object.assign(host.style, {
    position: "fixed",
    left: "-20000px",
    top: "0",
    width: `${RENDER_WIDTH}px`,
    height: `${RENDER_HEIGHT}px`,
    overflow: "hidden",
    pointerEvents: "none",
  });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", HTML_ARTIFACT_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("tabindex", "-1");
  Object.assign(frame.style, { width: `${RENDER_WIDTH}px`, height: `${RENDER_HEIGHT}px`, border: "0" });
  const { channel, srcDoc } = createArtifactBridge(html);
  host.appendChild(frame);
  document.body.appendChild(host);
  const bridge = connectArtifactBridge(frame, channel);
  try {
    frame.srcdoc = srcDoc;
    await bridge.ready;
    await new Promise<void>((resolve) => window.setTimeout(resolve, SETTLE_DELAY_MS));
    const webp = canEncodeWebp();
    return await bridge.capture({
      area: "viewport",
      mimeType: webp ? "image/webp" : "image/png",
      quality: webp ? 0.82 : undefined,
      outputWidth: ARTIFACT_THUMBNAIL_WIDTH,
    });
  } finally {
    bridge.dispose();
    host.remove();
  }
};

export type ArtifactThumbnailQueue = {
  /** Queues the artifact unless this version was already tried in this session. */
  request(target: ThumbnailTarget): void;
};

/**
 * Generates missing or stale thumbnails for artifacts a list shows. Within
 * one session each version of a page (memo id + HTML hash) is tried once, at
 * most two at a time; a failed or tainted capture keeps the placeholder until
 * the next session or a new version of the page.
 */
export const createArtifactThumbnailQueue = (deps: ArtifactThumbnailDeps): ArtifactThumbnailQueue => {
  const attempted = new Set<string>();
  const waiting: ThumbnailTarget[] = [];
  let running = 0;

  const run = async ({ memoId, artifact }: ThumbnailTarget) => {
    const blob = await deps.readResource(artifact.htmlResourceId);
    const image = await renderArtifactThumbnail(await blob.text());
    const { memo } = await deps.uploadThumbnail(memoId, image, artifact.sha256);
    deps.onUploaded(memo);
  };

  const pump = () => {
    while (running < MAX_CONCURRENT_RENDERS && waiting.length) {
      const target = waiting.shift()!;
      running += 1;
      void run(target)
        .catch((error: unknown) => {
          if (!(error instanceof ArtifactCaptureError)) console.warn("HTML artifact thumbnail failed", error);
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };

  return {
    request(target) {
      const key = `${target.memoId}:${target.artifact.sha256}`;
      if (attempted.has(key)) return;
      attempted.add(key);
      waiting.push(target);
      pump();
    },
  };
};
