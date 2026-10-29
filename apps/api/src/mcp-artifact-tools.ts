import { parseArtifactDocument, type ArtifactDocument, type MemoDetail, type MemoSummary, type Notebook } from "@edgeever/shared";
import type { AppContext, AuthContext } from "./api-context";
import { AppError } from "./app-error";
import {
  ARTIFACT_THUMBNAIL_MIME_TYPES,
  createHtmlArtifact,
  decodeArtifactHtml,
  discardCreatedArtifact,
  replaceHtmlArtifactContent,
  setArtifactThumbnail,
} from "./artifact-service";
import { clampNumber, isoNow } from "./entity-utils";
import { sha256Bytes } from "./hash-utils";
import { decodeBase64Data, getOptionalString, getRequiredString } from "./mcp-json-rpc";
import { listMemos } from "./memo-list-service";
import { getMemoDetail, normalizeImportSource, updateMemoRecord } from "./memo-service";
import { createNotebookRecord, ensureArtifactLibrary, listNotebooks, normalizeNotebookLookupName } from "./notebook-service";
import { resolveObjectStorage } from "./object-storage";
import { assertScope, getActorLabel, getAuditActor } from "./request-auth";
import { getResourceRow, normalizeFilename } from "./resource-service";

const MAX_TITLE_LENGTH = 160;
const MAX_FOLDER_NAME_LENGTH = 80;
const MAX_TAGS = 100;
const MAX_EXTERNAL_ID_LENGTH = 512;

type ThumbnailInput = { bytes: Uint8Array; mimeType: string };

type CreateArguments = {
  title: string;
  tags: string[] | undefined;
  filename: string;
  bytes: Uint8Array;
  importKey: { source: string; externalId: string } | null;
  source: ArtifactDocument["source"];
  folderPath: string[] | null;
  thumbnail: ThumbnailInput | null;
};

/** What agents see of an artifact in lists. */
type ArtifactSummaryView = {
  id: string;
  title: string | null;
  folderId: string;
  /** Relative to the Artifact Library root; "" for the root itself. */
  folderPath: string;
  tags: string[];
  /** No thumbnail of the current HTML yet; a client renders one when the card is shown. */
  thumbnailPending: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

type ArtifactView = ArtifactSummaryView & { missingLocalAssets: string[] };

type ImportResult = { status: "created" | "replaced" | "unchanged"; artifact: ArtifactView };

const invalidParams = (message: string) => new AppError("invalid_params", message, 400);

/** `Projects/AgentEnv` → ["Projects", "AgentEnv"]; null when omitted. */
const parseFolderPath = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidParams("folderPath must be a string");
  const segments = value.split("/").map((segment) => segment.trim());
  for (const segment of segments) {
    if (!segment) throw invalidParams("folderPath must not contain empty segments");
    if (segment === "." || segment === "..") throw invalidParams("folderPath must not contain . or .. segments");
    if (segment.length > MAX_FOLDER_NAME_LENGTH) throw invalidParams(`folderPath segments can be at most ${MAX_FOLDER_NAME_LENGTH} characters`);
  }
  return segments;
};

const findChildFolder = (notebooks: Notebook[], parentId: string, segment: string) => {
  const name = normalizeNotebookLookupName(segment);
  const matches = notebooks.filter((notebook) => notebook.parentId === parentId && normalizeNotebookLookupName(notebook.name) === name);
  if (matches.length > 1) throw invalidParams(`folderPath segment "${segment}" matches more than one folder`);
  return matches[0] ?? null;
};

/** Each folder's path relative to the Artifact Library; the library itself is "". */
const artifactFolderPaths = (notebooks: Notebook[]) => {
  const paths = new Map<string, string>();
  const library = notebooks.find((notebook) => notebook.systemKind === "artifact_library");
  if (!library) return paths;
  const visit = (parentId: string, parentPath: string) => {
    for (const notebook of notebooks) {
      if (notebook.parentId !== parentId) continue;
      const path = parentPath ? `${parentPath}/${notebook.name}` : notebook.name;
      paths.set(notebook.id, path);
      visit(notebook.id, path);
    }
  };
  paths.set(library.id, "");
  visit(library.id, "");
  return paths;
};

/** The folder at `segments` under the library, creating the library and any missing folders. */
const ensureArtifactFolder = async (context: AppContext, auth: AuthContext, segments: string[] | null) => {
  const db = context.env.storage.db;
  const actor = getAuditActor(context);
  let notebooks = await listNotebooks(db, auth.workspaceId);
  let library = notebooks.find((notebook) => notebook.systemKind === "artifact_library");
  if (!library) {
    assertScope(auth, "write:notebooks");
    library = await ensureArtifactLibrary(db, auth.workspaceId, null, actor);
    notebooks = [...notebooks, library];
  }
  let folderId = library.id;
  for (const segment of segments ?? []) {
    const existing = findChildFolder(notebooks, folderId, segment);
    if (existing) {
      folderId = existing.id;
      continue;
    }
    assertScope(auth, "write:notebooks");
    const created = await createNotebookRecord(db, auth.workspaceId, { name: segment, parentId: folderId }, actor);
    notebooks = [...notebooks, created];
    folderId = created.id;
  }
  return folderId;
};

const parseThumbnail = async (args: Record<string, unknown>): Promise<ThumbnailInput | null> => {
  const data = getOptionalString(args.thumbnailBase64);
  const mimeType = getOptionalString(args.thumbnailMimeType);
  if (!data && !mimeType) return null;
  if (!data || !mimeType) throw invalidParams("thumbnailBase64 and thumbnailMimeType must be provided together");
  if (!ARTIFACT_THUMBNAIL_MIME_TYPES[mimeType]) {
    throw new AppError("unsupported_media_type", "Thumbnails must be WebP, PNG or JPEG images.", 415);
  }
  return { bytes: await decodeBase64Data(data), mimeType };
};

const parseCreateArguments = async (args: Record<string, unknown>, auth: AuthContext): Promise<CreateArguments> => {
  const title = getRequiredString(args.title, "title");
  if (title.length > MAX_TITLE_LENGTH) throw invalidParams(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  if (typeof args.html !== "string") throw invalidParams("html is required");
  if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== "string"))) {
    throw invalidParams("tags must be an array of strings");
  }
  const tags = args.tags as string[] | undefined;
  if (tags && tags.length > MAX_TAGS) throw invalidParams(`tags must contain at most ${MAX_TAGS} items`);
  const source = getOptionalString(args.source);
  const externalId = getOptionalString(args.externalId);
  if (Boolean(source) !== Boolean(externalId)) throw invalidParams("source and externalId must be provided together");
  if (externalId && externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    throw invalidParams(`externalId must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`);
  }
  const importKey = source && externalId ? { source: normalizeImportSource(source), externalId } : null;
  const filename = `${normalizeFilename(title).slice(0, MAX_TITLE_LENGTH - 5) || "artifact"}.html`;
  const bytes = new TextEncoder().encode(args.html);
  // Same size, encoding and emptiness checks as an uploaded file, before anything is written.
  decodeArtifactHtml(filename, bytes);
  return {
    title,
    tags,
    filename,
    bytes,
    importKey,
    source: { type: "mcp", agent: (importKey?.source ?? auth.username).slice(0, 80) },
    folderPath: parseFolderPath(args.folderPath),
    thumbnail: await parseThumbnail(args),
  };
};

/**
 * Stores the thumbnail the agent rendered from this HTML. The page is already
 * saved, so a thumbnail that cannot be stored only leaves the card for a client
 * to regenerate, as with uploads.
 */
const attachThumbnail = (context: AppContext, auth: AuthContext, memo: MemoDetail, thumbnail: ThumbnailInput | null) => {
  if (!thumbnail || !memo.artifact) return memo;
  return setArtifactThumbnail(context, {
    workspaceId: auth.workspaceId,
    memoId: memo.id,
    bytes: thumbnail.bytes,
    mimeType: thumbnail.mimeType,
    filename: `thumbnail.${thumbnail.mimeType.slice("image/".length)}`,
    sourceSha256: memo.artifact.sha256,
    actor: getAuditActor(context),
    actorLabel: getActorLabel(context),
  }).catch(() => memo);
};

const summarizeArtifact = (memo: MemoSummary, folderPaths: Map<string, string>): ArtifactSummaryView => ({
  id: memo.id,
  title: memo.title,
  folderId: memo.notebookId,
  folderPath: folderPaths.get(memo.notebookId) ?? "",
  tags: memo.tags,
  thumbnailPending: memo.artifact?.thumbnailStale ?? true,
  isPinned: memo.isPinned,
  createdAt: memo.createdAt,
  updatedAt: memo.updatedAt,
});

const describeArtifact = (memo: MemoDetail, document: ArtifactDocument | null, folderPaths: Map<string, string>): ArtifactView => ({
  ...summarizeArtifact(memo, folderPaths),
  missingLocalAssets: document?.missingLocalAssets ?? [],
});

const importResult = async (context: AppContext, auth: AuthContext, status: ImportResult["status"], memo: MemoDetail): Promise<ImportResult> => ({
  status,
  artifact: describeArtifact(
    memo,
    parseArtifactDocument(memo.contentMarkdown),
    artifactFolderPaths(await listNotebooks(context.env.storage.db, auth.workspaceId)),
  ),
});

/** A page imported earlier under the same key: same HTML is left alone, other HTML replaces it as a new version. */
const updateImportedArtifact = async (context: AppContext, auth: AuthContext, input: CreateArguments, current: MemoDetail, currentSha256: string) => {
  if (await sha256Bytes(input.bytes) === currentSha256) {
    const memo = current.artifact?.thumbnailStale ? await attachThumbnail(context, auth, current, input.thumbnail) : current;
    return importResult(context, auth, "unchanged", memo);
  }
  const notebookId = input.folderPath ? await ensureArtifactFolder(context, auth, input.folderPath) : current.notebookId;
  const actor = getAuditActor(context);
  const actorLabel = getActorLabel(context);
  await replaceHtmlArtifactContent(context, {
    workspaceId: auth.workspaceId,
    memoId: current.id,
    filename: input.filename,
    bytes: input.bytes,
    source: input.source,
    actor,
    actorLabel,
  });
  const updated = await updateMemoRecord(
    context.env.storage.db, auth.workspaceId, current.id, { title: input.title, tags: input.tags, notebookId }, actor, actorLabel,
  );
  if (updated.error !== undefined) throw new AppError(updated.error, updated.message, updated.status ?? 409);
  return importResult(context, auth, "replaced", await attachThumbnail(context, auth, updated.memo, input.thumbnail));
};

const importHtmlArtifact = async (
  context: AppContext,
  auth: AuthContext,
  input: CreateArguments,
  retryAfterLostRace: boolean,
): Promise<ImportResult> => {
  const db = context.env.storage.db;
  const key = input.importKey;
  // Reuses import_memos' mapping: workspace + source + externalId → memo.
  const mapping = key
    ? await db.prepare(`SELECT memo_id FROM memo_import_sources WHERE workspace_id = ? AND source = ? AND external_id = ?`)
      .bind(auth.workspaceId, key.source, key.externalId)
      .first<{ memo_id: string }>()
    : null;
  const current = mapping ? await getMemoDetail(db, auth.workspaceId, mapping.memo_id) : null;
  if (current) {
    const document = parseArtifactDocument(current.contentMarkdown);
    if (!document) {
      throw new AppError("import_source_conflict", "source and externalId already identify a memo that is not an HTML artifact.", 409);
    }
    return updateImportedArtifact(context, auth, input, current, document.sha256);
  }

  // Nothing mapped, or the mapped artifact is in the trash or gone: create a new one.
  const folderId = await ensureArtifactFolder(context, auth, input.folderPath);
  const { memo } = await createHtmlArtifact(context, {
    workspaceId: auth.workspaceId,
    filename: input.filename,
    bytes: input.bytes,
    folderId,
    title: input.title,
    tags: input.tags,
    source: input.source,
    actor: getAuditActor(context),
    actorLabel: getActorLabel(context),
    canCreateLibrary: false,
  });
  if (key) {
    const now = isoNow();
    const claim = mapping
      ? db.prepare(
        `UPDATE memo_import_sources SET memo_id = ?, content_hash = ?, updated_at = ?
         WHERE workspace_id = ? AND source = ? AND external_id = ? AND memo_id = ?`,
      ).bind(memo.id, memo.contentHash, now, auth.workspaceId, key.source, key.externalId, mapping.memo_id)
      : db.prepare(
        `INSERT INTO memo_import_sources (workspace_id, source, external_id, memo_id, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(auth.workspaceId, key.source, key.externalId, memo.id, memo.contentHash, now, now);
    if (Number((await claim.run()).meta.changes) !== 1) {
      // A concurrent call with the same key won: drop this copy and import onto the winner.
      await discardCreatedArtifact(context, auth.workspaceId, memo.id);
      if (!retryAfterLostRace) {
        throw new AppError("import_source_conflict", "Another import with the same source and externalId is in progress.", 409);
      }
      return importHtmlArtifact(context, auth, input, false);
    }
  }
  return importResult(context, auth, "created", await attachThumbnail(context, auth, memo, input.thumbnail));
};

export const createHtmlArtifactTool = async (context: AppContext, auth: AuthContext, args: Record<string, unknown>) => {
  assertScope(auth, "write:memos");
  assertScope(auth, "write:resources");
  return importHtmlArtifact(context, auth, await parseCreateArguments(args, auth), true);
};

export const listArtifactsTool = async (context: AppContext, auth: AuthContext, args: Record<string, unknown>) => {
  assertScope(auth, "read:memos");
  assertScope(auth, "read:resources");
  const segments = parseFolderPath(args.folderPath);
  const db = context.env.storage.db;
  const notebooks = await listNotebooks(db, auth.workspaceId);
  const library = notebooks.find((notebook) => notebook.systemKind === "artifact_library");
  let folderId = library?.id ?? null;
  for (const segment of segments ?? []) {
    folderId = folderId ? findChildFolder(notebooks, folderId, segment)?.id ?? null : null;
  }
  if (!folderId) {
    if (segments) throw new AppError("not_found", `Artifact folder not found: ${segments.join("/")}`, 404);
    return { artifacts: [], hasMore: false };
  }
  // A folder lists everything below it, subfolders included.
  const result = await listMemos(db, {
    workspaceId: auth.workspaceId,
    notebookId: folderId,
    includeNotebookDescendants: true,
    query: getOptionalString(args.q) ?? undefined,
    tag: getOptionalString(args.tag) ?? undefined,
    limit: clampNumber(Number(args.limit ?? 50), 1, 100),
  });
  const folderPaths = artifactFolderPaths(notebooks);
  return { artifacts: result.memos.map((memo) => summarizeArtifact(memo, folderPaths)), hasMore: result.nextCursor !== null };
};

export const getArtifactTool = async (context: AppContext, auth: AuthContext, args: Record<string, unknown>) => {
  assertScope(auth, "read:memos");
  assertScope(auth, "read:resources");
  const db = context.env.storage.db;
  const memo = await getMemoDetail(db, auth.workspaceId, getRequiredString(args.id, "id"));
  if (!memo) throw new AppError("not_found", "Artifact not found", 404);
  const document = parseArtifactDocument(memo.contentMarkdown);
  if (!document) throw new AppError("bad_request", "Only HTML artifacts can be read with get_artifact; use get_memo for notes.", 400);
  const artifact = {
    ...describeArtifact(memo, document, artifactFolderPaths(await listNotebooks(db, auth.workspaceId))),
    revision: memo.revision,
    originalFilename: document.originalFilename,
    byteSize: document.byteSize,
    sha256: document.sha256,
    source: document.source,
  };
  if (args.includeHtml !== true) return { artifact };

  const resource = await getResourceRow(db, auth.workspaceId, document.htmlResourceId);
  const object = resource
    ? await (await resolveObjectStorage(context.env, resource.storage_config_id)).store.get(resource.object_key)
    : null;
  if (!object) throw new AppError("not_found", "The HTML file of this artifact is missing.", 404);
  return { artifact, html: await new Response(object.body).text() };
};
