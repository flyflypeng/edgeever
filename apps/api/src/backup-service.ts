import {
  createExcerpt,
  DEFAULT_MEMO_TITLE,
  docToMarkdown,
  docToText,
  emptyDoc,
  hasArtifactDocumentMarker,
  normalizeTags,
  type JsonBackupMemo,
  type JsonBackupNotebook,
  type TiptapDoc,
} from "@edgeever/shared";
import type { AuditActor } from "./api-context";
import { AppError } from "./app-error";
import { audit } from "./audit";
import { createId } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import {
  ARTIFACT_LIBRARY_SYSTEM_KIND,
  ensureArtifactLibrary,
  findArtifactLibrary,
  findArtifactLibraryAncestorId,
  inboxNotebookIdentitySql,
  workspaceInboxId,
} from "./notebook-service";
import type { DatabaseAdapter } from "./storage-contract";

const RESTORE_ACTOR: AuditActor = { actorType: "user", actorId: null };

const parseBackupDoc = (value: unknown): TiptapDoc => {
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === "object" ? parsed as TiptapDoc : emptyDoc();
  } catch {
    return emptyDoc();
  }
};

const normalizeMemoTitle = (value: string | null | undefined) => {
  const title = value?.trim();
  return title || DEFAULT_MEMO_TITLE;
};

const assertIdsAvailableInWorkspace = async (
  db: DatabaseAdapter,
  table: "notebooks" | "memos",
  workspaceId: string,
  ids: string[],
) => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const collision = await db.prepare(
    `SELECT id FROM ${table} WHERE workspace_id <> ? AND id IN (${placeholders}) LIMIT 1`,
  ).bind(workspaceId, ...ids).first<{ id: string }>();
  if (collision) {
    throw new AppError("cross_workspace_id_conflict", "Backup contains an ID already used by another user.", 409);
  }
};

const assertNotebookIdsInWorkspace = async (
  db: DatabaseAdapter,
  workspaceId: string,
  ids: string[],
) => {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return;
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT id FROM notebooks WHERE workspace_id = ? AND id IN (${placeholders})`,
  ).bind(workspaceId, ...uniqueIds).all<{ id: string }>();
  if (rows.results.length !== uniqueIds.length) {
    throw new AppError("invalid_backup_workspace", "Backup references a notebook outside the current workspace.", 400);
  }
};

export const restoreJsonNotebooks = async (
  db: DatabaseAdapter,
  workspaceId: string,
  notebooks: JsonBackupNotebook[],
) => {
  await assertIdsAvailableInWorkspace(db, "notebooks", workspaceId, notebooks.map((notebook) => notebook.id));
  const importedIds = new Set(notebooks.map((notebook) => notebook.id));
  const externalParentIds = notebooks
    .map((notebook) => notebook.parentId)
    .filter((id): id is string => Boolean(id) && !importedIds.has(id as string));
  await assertNotebookIdsInWorkspace(db, workspaceId, externalParentIds);

  // A workspace has one Artifact Library. A backup's library becomes a folder
  // of the library the workspace already has, so its artifacts stay inside it.
  let libraryId = (await findArtifactLibrary(db, workspaceId))?.id ?? null;
  const rows = notebooks.map((notebook) => {
    if (notebook.systemKind !== ARTIFACT_LIBRARY_SYSTEM_KIND) return notebook;
    if (!libraryId || libraryId === notebook.id) {
      libraryId = notebook.id;
      return { ...notebook, parentId: null };
    }
    return { ...notebook, parentId: libraryId, systemKind: null };
  });

  await db.batch(rows.map((notebook) => db.prepare(
    `INSERT INTO notebooks (
      id, workspace_id, parent_id, name, slug, icon, color, sort_order, is_deleted, created_at, updated_at, deleted_at, system_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      name = excluded.name,
      slug = excluded.slug,
      icon = excluded.icon,
      color = excluded.color,
      sort_order = excluded.sort_order,
      is_deleted = 0,
      updated_at = excluded.updated_at,
      deleted_at = NULL,
      system_kind = CASE WHEN ? THEN notebooks.system_kind ELSE excluded.system_kind END`,
  ).bind(
    notebook.id,
    workspaceId,
    notebook.parentId,
    notebook.name,
    notebook.slug,
    notebook.icon,
    notebook.color,
    notebook.sortOrder,
    notebook.createdAt,
    notebook.updatedAt,
    notebook.systemKind ?? null,
    // Backups written before notebooks carried systemKind keep the identity
    // the notebook already has here.
    notebook.systemKind === undefined ? 1 : 0,
  )));
};

/**
 * Where a restored memo goes: its own notebook when that is on the memo's side
 * of the library boundary, otherwise the library root for an artifact and the
 * inbox for an ordinary note (the same rule as restoring from the trash).
 */
const createRestoreLocator = (db: DatabaseAdapter, workspaceId: string) => {
  const inLibrary = new Map<string, boolean>();
  return async (notebookId: string, isArtifact: boolean) => {
    if (!inLibrary.has(notebookId)) {
      inLibrary.set(notebookId, Boolean(await findArtifactLibraryAncestorId(db, workspaceId, notebookId)));
    }
    if (inLibrary.get(notebookId) === isArtifact) return notebookId;
    if (isArtifact) return (await ensureArtifactLibrary(db, workspaceId, null, RESTORE_ACTOR)).id;
    const inbox = await db.prepare(
      `SELECT n.id FROM notebooks n
       WHERE n.workspace_id = ? AND n.is_deleted = 0 AND ${inboxNotebookIdentitySql("n")}
       ORDER BY CASE WHEN n.id = ? THEN 0 WHEN n.id = 'nb_inbox' THEN 1 ELSE 2 END
       LIMIT 1`,
    ).bind(workspaceId, workspaceInboxId(workspaceId)).first<{ id: string }>();
    if (!inbox) {
      throw new AppError("restore_notebook_missing", "A note in the backup belongs outside the Artifact Library and the default inbox is unavailable.", 409);
    }
    return inbox.id;
  };
};

export const restoreJsonMemos = async (
  db: DatabaseAdapter,
  workspaceId: string,
  backups: JsonBackupMemo[],
) => {
  await assertIdsAvailableInWorkspace(db, "memos", workspaceId, backups.map((backup) => backup.memo.id));
  await assertNotebookIdsInWorkspace(db, workspaceId, backups.map((backup) => backup.memo.notebookId));
  // Validate the whole page before writing, so an invalid note never leaves
  // the notes before it restored.
  if (backups.some((backup) => backup.revisions.some((revision) => revision.memoId !== backup.memo.id))) {
    throw new AppError("invalid_backup", "A backup revision belongs to a different memo.", 400);
  }

  const locate = createRestoreLocator(db, workspaceId);
  for (const backup of backups) {
    const memo = backup.memo;
    const contentJson = parseBackupDoc(memo.contentJson);
    const contentMarkdown = memo.contentMarkdown || docToMarkdown(contentJson);
    const isArtifact = hasArtifactDocumentMarker(contentMarkdown);
    const notebookId = await locate(memo.notebookId, isArtifact);
    // An artifact's body is only its fallback text; search uses the page text.
    const contentText = isArtifact ? memo.contentText : docToText(contentJson);
    const contentHash = await sha256(contentMarkdown + JSON.stringify(contentJson));
    const title = normalizeMemoTitle(memo.title);
    const tags = normalizeTags(memo.tags);

    await db.batch([
      db.prepare(
        `INSERT INTO memos (
          id, workspace_id, notebook_id, title, excerpt, tags_json, is_pinned, is_archived, is_deleted,
          source_memo_ids, merge_source_count, merged_into_memo_id,
          created_by, updated_by, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 'restore', 'restore', ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          notebook_id = excluded.notebook_id,
          title = excluded.title,
          excerpt = excluded.excerpt,
          tags_json = excluded.tags_json,
          is_pinned = excluded.is_pinned,
          is_archived = excluded.is_archived,
          is_deleted = 0,
          source_memo_ids = excluded.source_memo_ids,
          merge_source_count = excluded.merge_source_count,
          merged_into_memo_id = NULL,
          updated_by = 'restore',
          updated_at = excluded.updated_at,
          deleted_at = NULL`,
      ).bind(
        memo.id,
        workspaceId,
        notebookId,
        title,
        createExcerpt(contentText),
        JSON.stringify(tags),
        memo.isPinned ? 1 : 0,
        memo.isArchived ? 1 : 0,
        JSON.stringify(memo.sourceMemoIds),
        memo.mergeSourceCount,
        memo.createdAt,
        memo.updatedAt,
      ),
      db.prepare(
        `INSERT INTO memo_contents (
          memo_id, content_json, content_markdown, content_text, content_hash, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memo_id) DO UPDATE SET
          content_json = excluded.content_json,
          content_markdown = excluded.content_markdown,
          content_text = excluded.content_text,
          content_hash = excluded.content_hash,
          revision = excluded.revision,
          updated_at = excluded.updated_at`,
      ).bind(
        memo.id,
        JSON.stringify(contentJson),
        contentMarkdown,
        contentText,
        contentHash,
        memo.revision,
        memo.createdAt,
        memo.updatedAt,
      ),
      upsertMemoSearchDocumentStatement(db, memo.id, title, contentText, tags.join(" ")),
      db.prepare("DELETE FROM memo_revisions WHERE memo_id = ?").bind(memo.id),
    ]);

    for (let index = 0; index < backup.revisions.length; index += 50) {
      const statements = backup.revisions.slice(index, index + 50).map((revision) => {
        const revisionJson = parseBackupDoc(revision.contentJson);
        const revisionMarkdown = revision.contentMarkdown || docToMarkdown(revisionJson);
        const revisionText = docToText(revisionJson);
        return db.prepare(
          `INSERT INTO memo_revisions (
            id, memo_id, revision, title, content_json, content_markdown,
            content_hash, created_by, created_at, tags_json, content_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            memo_id = excluded.memo_id,
            revision = excluded.revision,
            title = excluded.title,
            content_json = excluded.content_json,
            content_markdown = excluded.content_markdown,
            content_hash = excluded.content_hash,
            created_by = excluded.created_by,
            created_at = excluded.created_at,
            tags_json = excluded.tags_json,
            content_text = excluded.content_text`,
        ).bind(
          revision.id,
          memo.id,
          revision.revision,
          normalizeMemoTitle(revision.title),
          JSON.stringify(revisionJson),
          revisionMarkdown,
          revision.contentHash || "",
          revision.createdBy,
          revision.createdAt,
          JSON.stringify(normalizeTags(revision.tags)),
          revisionText,
        );
      });
      await db.batch(statements);
    }
  }

  await audit(db, "user", null, "backup.restore", "backup", createId("restore"), {
    memoCount: backups.length,
  });
};
