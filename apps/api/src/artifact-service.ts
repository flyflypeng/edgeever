import {
  ARTIFACT_MAX_HTML_BYTES,
  markdownToDoc,
  serializeArtifactDocument,
  type ArtifactDocument,
  type MemoDetail,
} from "@edgeever/shared";
import type { AppContext, AuditActor } from "./api-context";
import { AppError } from "./app-error";
import { createId } from "./entity-utils";
import { sha256Bytes } from "./hash-utils";
import { createMemoRecord, getMemoDetail } from "./memo-service";
import { ensureArtifactLibrary, findArtifactLibrary, findArtifactLibraryAncestorId, MEMO_LOCATION_INVALID } from "./notebook-service";
import { createAttachmentResource, normalizeFilename } from "./resource-service";
import type { DatabaseAdapter } from "./storage-contract";

/** Upper bound of the visible text an artifact indexes for search, in UTF-8 bytes. */
export const ARTIFACT_MAX_CONTENT_TEXT_BYTES = 200 * 1024;
const MAX_TITLE_LENGTH = 160;
const FALLBACK_EXCERPT_LENGTH = 200;
const HTML_FILENAME = /\.html?$/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
};

const decodeHtmlEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const truncateUtf8 = (value: string, maxBytes: number) => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, "");
};

export const extractHtmlTitle = (html: string) => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match ? collapseWhitespace(decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ""))) : "";
};

/** Visible text for search: no script, style, noscript, comments or tags; capped at 200 KB. */
export const extractHtmlText = (html: string) =>
  truncateUtf8(
    collapseWhitespace(
      decodeHtmlEntities(
        html
          .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
          .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
          .replace(/<[^>]*>/g, " "),
      ),
    ),
    ARTIFACT_MAX_CONTENT_TEXT_BYTES,
  );

const invalidHtml = (message: string) => new AppError("artifact_invalid_html", message, 400);

/** Checks the file name, size and encoding of an uploaded page and returns its text. */
export const decodeArtifactHtml = (filename: string, bytes: Uint8Array) => {
  if (!HTML_FILENAME.test(filename.trim())) throw invalidHtml("Only .html and .htm files can be imported as HTML artifacts.");
  if (bytes.byteLength > ARTIFACT_MAX_HTML_BYTES) {
    throw new AppError("artifact_too_large", "HTML artifacts can be at most 20 MB.", 413);
  }
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw invalidHtml("The file is not UTF-8 text.");
  }
  if (!html.trim()) throw invalidHtml("The file is empty.");
  return html;
};

const resolveArtifactFolder = async (db: DatabaseAdapter, workspaceId: string, folderId: string | null, locale: string | null | undefined, actor: AuditActor, canCreateLibrary: boolean) => {
  if (folderId) {
    if (!(await findArtifactLibraryAncestorId(db, workspaceId, folderId))) {
      throw new AppError(MEMO_LOCATION_INVALID.error, "folderId must be the Artifact Library or one of its folders.", MEMO_LOCATION_INVALID.status);
    }
    return folderId;
  }
  const library = await findArtifactLibrary(db, workspaceId);
  if (library) return library.id;
  if (!canCreateLibrary) throw new AppError("forbidden", "Missing required scope: write:notebooks", 403);
  return (await ensureArtifactLibrary(db, workspaceId, locale, actor)).id;
};

// Removes a memo whose HTML resource could not be stored, so a failed import
// leaves nothing behind.
const discardArtifactMemo = async (db: DatabaseAdapter, workspaceId: string, memoId: string) => {
  await db.batch([
    db.prepare(`DELETE FROM memo_search_documents WHERE memo_id = ?`).bind(memoId),
    db.prepare(`DELETE FROM memo_tags WHERE memo_id = ?`).bind(memoId),
    db.prepare(`DELETE FROM memo_revisions WHERE memo_id = ?`).bind(memoId),
    db.prepare(`DELETE FROM memo_contents WHERE memo_id = ?`).bind(memoId),
    db.prepare(`DELETE FROM memos WHERE id = ? AND workspace_id = ?`).bind(memoId, workspaceId),
  ]);
};

export type CreateHtmlArtifactInput = {
  workspaceId: string;
  filename: string;
  bytes: Uint8Array;
  folderId?: string | null;
  title?: string | null;
  tags?: string[];
  source: ArtifactDocument["source"];
  locale?: string | null;
  actor: AuditActor;
  actorLabel: string;
  /** Whether the caller may create the Artifact Library when it does not exist yet. */
  canCreateLibrary: boolean;
};

export const createHtmlArtifact = async (context: AppContext, input: CreateHtmlArtifactInput): Promise<MemoDetail> => {
  const db = context.env.storage.db;
  const html = decodeArtifactHtml(input.filename, input.bytes);
  const folderId = await resolveArtifactFolder(
    db, input.workspaceId, input.folderId?.trim() || null, input.locale, input.actor, input.canCreateLibrary,
  );
  const originalFilename = normalizeFilename(input.filename) || "artifact.html";
  const title = (input.title?.trim() || extractHtmlTitle(html) || originalFilename.replace(HTML_FILENAME, "") || originalFilename)
    .slice(0, MAX_TITLE_LENGTH);
  const contentText = extractHtmlText(html);
  const htmlResourceId = createId("res");
  const document: ArtifactDocument = {
    schemaVersion: 1,
    kind: "html",
    htmlResourceId,
    originalFilename,
    byteSize: input.bytes.byteLength,
    sha256: await sha256Bytes(input.bytes),
    source: input.source,
  };
  const contentMarkdown = serializeArtifactDocument(document, contentText.slice(0, FALLBACK_EXCERPT_LENGTH));
  const memo = await createMemoRecord(db, input.workspaceId, {
    notebookId: folderId,
    title,
    contentMarkdown,
    contentJson: markdownToDoc(contentMarkdown),
    tags: input.tags,
    artifact: { contentText },
  }, input.actor, input.actorLabel);

  try {
    await createAttachmentResource(context, {
      memoId: memo.id,
      resourceId: htmlResourceId,
      filename: originalFilename,
      mimeType: "text/html",
      bytes: input.bytes,
      actor: input.actor,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    await discardArtifactMemo(db, input.workspaceId, memo.id);
    throw error;
  }

  return (await getMemoDetail(db, input.workspaceId, memo.id)) ?? memo;
};
