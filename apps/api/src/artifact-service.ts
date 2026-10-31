import {
  ARTIFACT_MAX_HTML_BYTES,
  ARTIFACT_MAX_LOCAL_ASSET_LENGTH,
  ARTIFACT_MAX_MISSING_LOCAL_ASSETS,
  createExcerpt,
  hasArtifactDocumentMarker,
  markdownToDoc,
  parseArtifactDocument,
  serializeArtifactDocument,
  type ArtifactDocument,
  type MemoDetail,
} from "@edgeever/shared";
import type { AppContext, AuditActor } from "./api-context";
import { AppError } from "./app-error";
import { auditStatement } from "./audit";
import { createId, isoNow } from "./entity-utils";
import { sha256, sha256Bytes } from "./hash-utils";
import { createMemoRevisionStatement } from "./memo-revision-service";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import { createMemoRecord, getMemoDetail, getMemoDetailRow } from "./memo-service";
import { ensureArtifactLibrary, findArtifactLibrary, findArtifactLibraryAncestorId, MEMO_LOCATION_INVALID } from "./notebook-service";
import { deleteStoredObjects } from "./object-storage";
import { createAttachmentResource, createImageResource, normalizeFilename } from "./resource-service";
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

const CSS_REFERENCES = /@import\s+["']([^"']+)["']|url\(\s*["']?([^"')]*?)["']?\s*\)/gi;
const TAGS = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const ATTRIBUTES = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
// Links between pages (`<a>`, `<area>`) and `<base>` are not resources the page needs to render.
const NAVIGATION_TAGS: Record<string, true> = { a: true, area: true, base: true };

const cssReferences = (css: string) => Array.from(css.matchAll(CSS_REFERENCES), (match) => match[1] ?? match[2] ?? "");

/**
 * Local relative resources (`./img.png`, `style.css`, `/media/clip.mp4`) the
 * page references from tags, srcset and CSS. Only the HTML is imported, so the
 * sandbox cannot load them. At most 50, in order of first appearance.
 */
export const findMissingLocalAssets = (html: string) => {
  const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  const references: string[] = [];
  for (const [, css] of withoutComments.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)) references.push(...cssReferences(css));
  // Script and style bodies are code, not markup; keep their opening tags for `src`.
  const markup = withoutComments.replace(/(<(script|style|template)\b[^>]*>)[\s\S]*?(?:<\/\2\s*>|$)/gi, "$1");
  for (const [, tag, attributes] of markup.matchAll(TAGS)) {
    for (const [, rawName, double, single, bare] of attributes.matchAll(ATTRIBUTES)) {
      const name = rawName.toLowerCase();
      const value = decodeHtmlEntities(double ?? single ?? bare ?? "");
      if (name === "src" || name === "poster" || name === "data" || (name === "href" && !NAVIGATION_TAGS[tag.toLowerCase()])) {
        references.push(value);
      } else if (name === "srcset") {
        references.push(...value.split(/\s*,\s+/).map((candidate) => candidate.trim().split(/\s+/)[0] ?? ""));
      } else if (name === "style") {
        references.push(...cssReferences(value));
      }
    }
  }
  const missing = new Set<string>();
  for (const reference of references) {
    const trimmed = reference.trim();
    // A scheme (`https:`, `data:`, `blob:`, `mailto:`), a protocol-relative `//host`
    // or a fragment points somewhere the browser can still reach from the sandbox.
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) continue;
    if (trimmed.length > ARTIFACT_MAX_LOCAL_ASSET_LENGTH) continue;
    missing.add(trimmed);
    if (missing.size === ARTIFACT_MAX_MISSING_LOCAL_ASSETS) break;
  }
  return [...missing];
};
/** The memo body of an artifact: fallback text for other clients plus the envelope. */
export const artifactContentMarkdown = (document: ArtifactDocument, contentText: string) =>
  serializeArtifactDocument(document, contentText.slice(0, FALLBACK_EXCERPT_LENGTH));

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

/** Removes an artifact that was just created, with its stored files, as if it never existed. */
export const discardCreatedArtifact = async (context: AppContext, workspaceId: string, memoId: string) => {
  const db = context.env.storage.db;
  const stored = await db.prepare(`SELECT object_key, storage_config_id FROM resources WHERE memo_id = ?`)
    .bind(memoId)
    .all<{ object_key: string; storage_config_id: string }>();
  await db.prepare(`DELETE FROM resources WHERE memo_id = ?`).bind(memoId).run();
  await discardArtifactMemo(db, workspaceId, memoId);
  if (stored.results.length) await deleteStoredObjects(context.env, stored.results).catch(() => undefined);
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

export const createHtmlArtifact = async (
  context: AppContext,
  input: CreateHtmlArtifactInput,
): Promise<{ memo: MemoDetail; missingLocalAssets: string[] }> => {
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
  const missingLocalAssets = findMissingLocalAssets(html);
  const document: ArtifactDocument = {
    schemaVersion: 1,
    kind: "html",
    htmlResourceId,
    originalFilename,
    byteSize: input.bytes.byteLength,
    sha256: await sha256Bytes(input.bytes),
    ...(missingLocalAssets.length ? { missingLocalAssets } : {}),
    source: input.source,
  };
  const contentMarkdown = artifactContentMarkdown(document, contentText);
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

  return { memo: (await getMemoDetail(db, input.workspaceId, memo.id)) ?? memo, missingLocalAssets };
};

export type ReplaceHtmlArtifactContentInput = {
  workspaceId: string;
  memoId: string;
  filename: string;
  bytes: Uint8Array;
  expectedRevision?: number;
  source: ArtifactDocument["source"];
  actor: AuditActor;
  actorLabel: string;
};

/**
 * Replaces an artifact's page with a new HTML file as a new version: the HTML
 * goes into a new resource and the previous version is snapshotted. The old
 * resource stays, so restoring that revision shows its page again. The title
 * and tags are kept; the thumbnail is kept but no longer matches the new HTML,
 * so clients report it as stale and regenerate it.
 */
export const replaceHtmlArtifactContent = async (context: AppContext, input: ReplaceHtmlArtifactContentInput): Promise<MemoDetail> => {
  const db = context.env.storage.db;
  const current = await getMemoDetailRow(db, input.workspaceId, input.memoId);
  if (!current) throw new AppError("not_found", "Memo not found", 404);
  const previous = parseArtifactDocument(current.content_markdown);
  if (!previous) throw new AppError("bad_request", "Only HTML artifacts can have their content replaced.", 400);
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new AppError("revision_conflict", "Memo was updated elsewhere. Reload before saving.", 409);
  }
  const html = decodeArtifactHtml(input.filename, input.bytes);
  const originalFilename = normalizeFilename(input.filename) || previous.originalFilename;
  const contentText = extractHtmlText(html);
  const htmlResourceId = createId("res");
  const missingLocalAssets = findMissingLocalAssets(html);
  const { missingLocalAssets: _previousMissing, ...kept } = previous;
  const document: ArtifactDocument = {
    ...kept,
    htmlResourceId,
    originalFilename,
    byteSize: input.bytes.byteLength,
    sha256: await sha256Bytes(input.bytes),
    ...(missingLocalAssets.length ? { missingLocalAssets } : {}),
    source: input.source,
  };
  const contentMarkdown = artifactContentMarkdown(document, contentText);
  const contentJson = markdownToDoc(contentMarkdown);
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));

  // Store the page first: a failed upload must leave the current version as it was.
  await createAttachmentResource(context, {
    memoId: input.memoId,
    resourceId: htmlResourceId,
    filename: originalFilename,
    mimeType: "text/html",
    bytes: input.bytes,
    actor: input.actor,
    workspaceId: input.workspaceId,
  });

  const nextRevision = current.revision + 1;
  const now = isoNow();
  await db.batch([
    createMemoRevisionStatement(db, current, input.actorLabel, now),
    db.prepare(
      `UPDATE memos SET excerpt = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND is_deleted = 0`,
    ).bind(createExcerpt(contentText), input.actorLabel, now, input.memoId, input.workspaceId),
    db.prepare(
      `UPDATE memo_contents
       SET content_json = ?, content_markdown = ?, content_text = ?, content_hash = ?, revision = ?, updated_at = ?
       WHERE memo_id = ?`,
    ).bind(JSON.stringify(contentJson), contentMarkdown, contentText, contentHash, nextRevision, now, input.memoId),
    upsertMemoSearchDocumentStatement(db, input.memoId, current.title, contentText, JSON.parse(current.tags_json).join(" ")),
    auditStatement(db, input.actor.actorType, input.actor.actorId, "artifact.replace_content", "memo", input.memoId, {
      revision: nextRevision,
      htmlResourceId,
      previousHtmlResourceId: previous.htmlResourceId,
    }),
  ]);

  const memo = await getMemoDetail(db, input.workspaceId, input.memoId);
  if (!memo) throw new AppError("not_found", "Memo not found after replacing its content", 404);
  return memo;
};

/** Thumbnails are raster images only; an SVG could carry its own scripts and links. */
export const ARTIFACT_THUMBNAIL_MIME_TYPES: Record<string, true> = { "image/webp": true, "image/png": true, "image/jpeg": true };

export type SetArtifactThumbnailInput = {
  workspaceId: string;
  memoId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** The `sha256` of the HTML the image was rendered from. */
  sourceSha256: string;
  actor: AuditActor;
  actorLabel: string;
};

/**
 * Stores a first-screen image of an artifact's page and points the envelope at
 * it. An image rendered from another version of the HTML is refused, so a
 * client that finished late never covers a newer page with an old picture.
 * This is not a content change: no version is snapshotted and the memo keeps
 * its place in "recently updated" lists. The previous thumbnail is removed.
 */
export const setArtifactThumbnail = async (context: AppContext, input: SetArtifactThumbnailInput): Promise<MemoDetail> => {
  const db = context.env.storage.db;
  const current = await getMemoDetailRow(db, input.workspaceId, input.memoId);
  if (!current) throw new AppError("not_found", "Memo not found", 404);
  const previous = parseArtifactDocument(current.content_markdown);
  if (!previous) throw new AppError("bad_request", "Only HTML artifacts have thumbnails.", 400);
  const stale = () => new AppError("artifact_thumbnail_stale", "The thumbnail was rendered from another version of this page.", 409);
  if (input.sourceSha256 !== previous.sha256) throw stale();
  if (!ARTIFACT_THUMBNAIL_MIME_TYPES[input.mimeType]) {
    throw new AppError("unsupported_media_type", "Thumbnails must be WebP, PNG or JPEG images.", 415);
  }

  const thumbnail = await createImageResource(context, {
    memoId: input.memoId,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    actor: input.actor,
    workspaceId: input.workspaceId,
    source: "upload",
  });
  const document: ArtifactDocument = { ...previous, thumbnailResourceId: thumbnail.id, thumbnailSha256: input.sourceSha256 };
  const contentMarkdown = artifactContentMarkdown(document, current.content_text);
  const contentJson = markdownToDoc(contentMarkdown);
  const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
  const now = isoNow();
  const storedObject = (resourceId: string) =>
    db.prepare(`SELECT object_key, storage_config_id FROM resources WHERE id = ? AND memo_id = ?`)
      .bind(resourceId, input.memoId)
      .first<{ object_key: string; storage_config_id: string }>();
  const previousThumbnail = previous.thumbnailResourceId ? await storedObject(previous.thumbnailResourceId) : null;

  // Only the version the image was checked against may be updated; anything
  // that changed the memo in between wins and the new image is dropped.
  const [updated] = await db.batch([
    db.prepare(
      `UPDATE memo_contents
       SET content_json = ?, content_markdown = ?, content_hash = ?, revision = revision + 1, updated_at = ?
       WHERE memo_id = ? AND revision = ?`,
    ).bind(JSON.stringify(contentJson), contentMarkdown, contentHash, now, input.memoId, current.revision),
    // Touching the row records a sync change; updated_at stays, so lists keep their order.
    db.prepare(
      `UPDATE memos SET updated_at = updated_at
       WHERE id = ? AND workspace_id = ? AND EXISTS (SELECT 1 FROM memo_contents WHERE memo_id = ? AND content_hash = ?)`,
    ).bind(input.memoId, input.workspaceId, input.memoId, contentHash),
    ...(previous.thumbnailResourceId
      ? [db.prepare(
          `DELETE FROM resources
           WHERE id = ? AND memo_id = ? AND EXISTS (SELECT 1 FROM memo_contents WHERE memo_id = ? AND content_hash = ?)`,
        ).bind(previous.thumbnailResourceId, input.memoId, input.memoId, contentHash)]
      : []),
    auditStatement(db, input.actor.actorType, input.actor.actorId, "artifact.thumbnail", "memo", input.memoId, {
      thumbnailResourceId: thumbnail.id,
      sourceSha256: input.sourceSha256,
    }),
  ]);
  // Adapter UPDATE metadata may include sync-trigger writes, so only zero means the guard failed.
  if (!(Number(updated?.meta.changes) > 0)) {
    const orphan = await storedObject(thumbnail.id);
    await db.prepare(`DELETE FROM resources WHERE id = ?`).bind(thumbnail.id).run();
    if (orphan) await deleteStoredObjects(context.env, [orphan]).catch(() => undefined);
    throw stale();
  }
  if (previousThumbnail) await deleteStoredObjects(context.env, [previousThumbnail]).catch(() => undefined);

  const memo = await getMemoDetail(db, input.workspaceId, input.memoId);
  if (!memo) throw new AppError("not_found", "Memo not found after storing its thumbnail", 404);
  return memo;
};

/**
 * The body a revision restore writes for an artifact. An artifact stays an
 * artifact: a revision without a valid envelope, or whose HTML is gone, is
 * refused. A thumbnail that has since been removed is dropped from the
 * envelope, so clients regenerate it instead of showing a broken image.
 */
export const resolveArtifactRevisionContent = async (
  db: DatabaseAdapter,
  memoId: string,
  currentMarkdown: string,
  revisionMarkdown: string,
  contentText: string,
): Promise<string> => {
  const isArtifact = hasArtifactDocumentMarker(currentMarkdown);
  if (!isArtifact && !hasArtifactDocumentMarker(revisionMarkdown)) return revisionMarkdown;
  const document = parseArtifactDocument(revisionMarkdown);
  const refused = (message: string) => new AppError("artifact_update_required", message, 409);
  if (!isArtifact || !document) throw refused("A note and an HTML artifact cannot be restored into each other.");
  const activeResourceIds = new Set((await db.prepare(
    `SELECT id FROM resources WHERE memo_id = ? AND is_deleted = 0 AND id IN (?, ?)`,
  ).bind(memoId, document.htmlResourceId, document.thumbnailResourceId ?? document.htmlResourceId).all<{ id: string }>()).results.map((row) => row.id));
  if (!activeResourceIds.has(document.htmlResourceId)) throw refused("The HTML of this revision is no longer available.");
  if (!document.thumbnailResourceId || activeResourceIds.has(document.thumbnailResourceId)) return revisionMarkdown;
  const { thumbnailResourceId: _thumbnail, thumbnailSha256: _thumbnailSha256, ...withoutThumbnail } = document;
  return artifactContentMarkdown(withoutThumbnail, contentText);
};
