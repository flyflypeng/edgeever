import { Base64 } from "js-base64";
import { z } from "zod";

const MARKER = "edgeever-artifact-v1";
const ENVELOPE = /<!--\s*edgeever-artifact-v1:([A-Za-z0-9_-]+)\s*-->/;

/** Largest HTML an artifact may hold, in UTF-8 bytes. */
export const ARTIFACT_MAX_HTML_BYTES = 20 * 1024 * 1024;
/** How many missing local resources an import reports at most. */
export const ARTIFACT_MAX_MISSING_LOCAL_ASSETS = 50;
/** Longest resource reference kept in the list; the envelope must stay small. */
export const ARTIFACT_MAX_LOCAL_ASSET_LENGTH = 500;

export const ArtifactDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("html"),
  htmlResourceId: z.string().min(1).max(160),
  originalFilename: z.string().min(1).max(255),
  byteSize: z.number().int().min(1).max(ARTIFACT_MAX_HTML_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  thumbnailResourceId: z.string().min(1).max(160).optional(),
  thumbnailSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Local relative paths the page references (`./img.png`), which an import cannot bring along. */
  missingLocalAssets: z.array(z.string().min(1).max(ARTIFACT_MAX_LOCAL_ASSET_LENGTH)).max(ARTIFACT_MAX_MISSING_LOCAL_ASSETS).optional(),
  source: z.object({ type: z.enum(["upload", "mcp"]), agent: z.string().max(80).optional() }),
});
export type ArtifactDocument = z.infer<typeof ArtifactDocumentSchema>;

/**
 * What lists need to show an artifact card. `htmlResourceId` and `sha256`
 * identify the current HTML, so clients can tell a replaced page from the one
 * they already rendered a thumbnail for.
 */
export type ArtifactSummary = {
  kind: "html";
  htmlResourceId: string;
  sha256: string;
  thumbnailResourceId?: string;
  thumbnailStale: boolean;
};

export const hasArtifactDocumentMarker = (markdown: string | null | undefined) =>
  Boolean(markdown?.includes(`<!-- ${MARKER}:`));

export const parseArtifactDocument = (markdown: string | null | undefined): ArtifactDocument | null => {
  const encoded = markdown?.match(ENVELOPE)?.[1];
  if (!encoded || encoded.length > 100_000) return null;
  try {
    return ArtifactDocumentSchema.parse(JSON.parse(Base64.decode(encoded)));
  } catch {
    return null;
  }
};

const escapeMarkdownText = (text: string) => text.replace(/([\\`*_{}[\]<>#!|])/g, "\\$1");

/**
 * What older clients and mobile apps show: the thumbnail when there is one, a
 * pointer to the clients that can render the page, and a short excerpt of its
 * visible text. The HTML itself never goes into the body.
 */
export const artifactFallbackMarkdown = (document: ArtifactDocument, excerpt: string) =>
  [
    document.thumbnailResourceId ? `![HTML artifact](/api/v1/resources/${encodeURIComponent(document.thumbnailResourceId)}/blob)` : "",
    "This is an HTML artifact. Open it in EdgeEver on the web or desktop to view it.",
    excerpt ? `> ${escapeMarkdownText(excerpt.replace(/\s+/g, " ").trim())}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export const serializeArtifactDocument = (document: ArtifactDocument, excerpt: string) => {
  const safe = ArtifactDocumentSchema.parse(document);
  return `${artifactFallbackMarkdown(safe, excerpt)}\n\n<!-- ${MARKER}:${Base64.encodeURI(JSON.stringify(safe))} -->`;
};

export const getArtifactSummary = (markdown: string | null | undefined): { artifact?: ArtifactSummary } => {
  const document = hasArtifactDocumentMarker(markdown) ? parseArtifactDocument(markdown) : null;
  if (!document) return {};
  return {
    artifact: {
      kind: document.kind,
      htmlResourceId: document.htmlResourceId,
      sha256: document.sha256,
      ...(document.thumbnailResourceId ? { thumbnailResourceId: document.thumbnailResourceId } : {}),
      thumbnailStale: !document.thumbnailResourceId || document.thumbnailSha256 !== document.sha256,
    },
  };
};
