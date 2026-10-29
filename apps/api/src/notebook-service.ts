import type { Notebook, NotebookCreateInput, NotebookSystemKind, NotebookUpdateInput } from "@edgeever/shared";
import { localizeArtifactLibraryName } from "@edgeever/shared/default-workspace-seeds";
import type { AuditActor } from "./api-context";
import { AppError } from "./app-error";
import { auditStatement } from "./audit";
import { createId, isoNow, slugify } from "./entity-utils";
import type { DatabaseAdapter } from "./storage-contract";
import { isInboxNotebook, workspaceInboxId } from "./workspace-provisioning";

export { isInboxNotebook, workspaceInboxId } from "./workspace-provisioning";

/** SQL identity for the workspace inbox: stable id first, slug as a fallback. */
export const inboxNotebookIdentitySql = (alias: string) =>
  `(${alias}.id = ${alias}.workspace_id || '_inbox' OR ${alias}.id = 'nb_inbox' OR ${alias}.slug = 'inbox')`;

export const ARTIFACT_LIBRARY_SYSTEM_KIND: NotebookSystemKind = "artifact_library";

export type NotebookRow = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string | null;
  icon: string | null;
  color: string | null;
  text_color?: string | null;
  color_target?: Notebook["colorTarget"];
  is_bold?: number;
  icon_inverted?: number;
  row_inverted?: number;
  sort_order: number;
  memo_count: number | null;
  last_memo_updated_at: string | null;
  created_at: string;
  updated_at: string;
  system_kind?: string | null;
};

export const mapNotebook = (row: NotebookRow): Notebook => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  slug: row.slug,
  icon: row.icon,
  color: row.color,
  textColor: row.text_color ?? null,
  colorTarget: row.color_target ?? "icon",
  isBold: row.is_bold === 1,
  iconInverted: row.icon_inverted === 1,
  rowInverted: row.row_inverted === 1,
  sortOrder: row.sort_order,
  memoCount: row.memo_count ?? 0,
  lastMemoUpdatedAt: row.last_memo_updated_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  systemKind: row.system_kind === ARTIFACT_LIBRARY_SYSTEM_KIND ? ARTIFACT_LIBRARY_SYSTEM_KIND : null,
});

export const notebookSelectSql = (tail: string) => `
  SELECT n.id,
         n.parent_id,
         n.name,
         n.slug,
         n.icon,
         n.color,
         n.text_color,
         n.color_target,
         n.is_bold,
         n.icon_inverted,
         n.row_inverted,
         n.sort_order,
         COUNT(m.id) AS memo_count,
         MAX(m.updated_at) AS last_memo_updated_at,
         n.created_at,
         n.updated_at,
         n.system_kind
  FROM notebooks n
  LEFT JOIN memos m ON m.notebook_id = n.id AND m.is_deleted = 0
  ${tail}
`;

export const listNotebooks = async (db: DatabaseAdapter, workspaceId: string): Promise<Notebook[]> => {
  const rows = await db
    .prepare(
      notebookSelectSql(
        `WHERE n.workspace_id = ? AND n.is_deleted = 0
         GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.text_color, n.color_target, n.is_bold, n.icon_inverted, n.row_inverted, n.sort_order, n.created_at, n.updated_at, n.system_kind
         ORDER BY n.parent_id IS NOT NULL, n.sort_order ASC, n.name ASC`
      )
    )
    .bind(workspaceId).all<NotebookRow>();

  return rows.results.map(mapNotebook);
};

export const normalizeNotebookLookupName = (value: string) => value.trim().toLocaleLowerCase("en-US");

export const findNotebooks = async (
  db: DatabaseAdapter,
  workspaceId: string,
  options: { name: string; parentId?: string | null; exact: boolean; limit: number },
) => {
  const query = normalizeNotebookLookupName(options.name);
  const notebooks = await listNotebooks(db, workspaceId);
  return notebooks
    .filter((notebook) => {
      if (options.parentId !== undefined && notebook.parentId !== options.parentId) {
        return false;
      }
      const name = normalizeNotebookLookupName(notebook.name);
      return options.exact ? name === query : name.includes(query);
    })
    .slice(0, options.limit);
};

export const resolveNotebookPath = async (db: DatabaseAdapter, workspaceId: string, path: string) => {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new AppError("invalid_params", "path must contain at least one notebook name", 400);
  }

  const notebooks = await listNotebooks(db, workspaceId);
  const matched: Notebook[] = [];
  let parentId: string | null = null;

  for (const [index, segment] of segments.entries()) {
    const normalizedSegment = normalizeNotebookLookupName(segment);
    const candidates = notebooks.filter(
      (notebook) => notebook.parentId === parentId && normalizeNotebookLookupName(notebook.name) === normalizedSegment,
    );

    if (candidates.length !== 1) {
      return {
        resolved: false,
        path,
        segments,
        matched,
        failedAt: index,
        failedSegment: segment,
        reason: candidates.length === 0 ? "not_found" : "ambiguous",
        candidates,
      };
    }

    matched.push(candidates[0]);
    parentId = candidates[0].id;
  }

  return {
    resolved: true,
    path,
    segments,
    notebook: matched.at(-1),
    matched,
  };
};

export const getNotebook = async (db: DatabaseAdapter, workspaceId: string, id: string): Promise<Notebook | null> => {
  const row = await db
    .prepare(
      notebookSelectSql(
        `WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0
         GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.text_color, n.color_target, n.is_bold, n.icon_inverted, n.row_inverted, n.sort_order, n.created_at, n.updated_at, n.system_kind`
      )
    )
    .bind(id, workspaceId)
    .first<NotebookRow>();

  return row ? mapNotebook(row) : null;
};

export const createNotebookRecord = async (
  db: DatabaseAdapter,
  workspaceId: string,
  input: NotebookCreateInput & { sortOrder?: number },
  actor: AuditActor
) => {
  const parentId = input.parentId ?? null;

  if (parentId && !(await getNotebook(db, workspaceId, parentId))) {
    throw new AppError("not_found", "Parent notebook not found", 404);
  }

  const id = createId("nb");
  const now = isoNow();
  const sortOrder = input.sortOrder ?? Date.now();

  await db.batch([
    db
      .prepare(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, workspaceId, parentId, input.name, slugify(input.name), sortOrder, now, now),
    auditStatement(db, actor.actorType, actor.actorId, "notebook.create", "notebook", id, {
      name: input.name,
      parentId,
      sortOrder,
    }),
  ]);

  const notebook = await getNotebook(db, workspaceId, id);

  if (!notebook) {
    throw new AppError("not_found", "Notebook not found after create", 404);
  }

  return notebook;
};

export const updateNotebookRecord = async (
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
  input: NotebookUpdateInput,
  actor: AuditActor
) => {
  const current = await getNotebook(db, workspaceId, id);

  if (!current) {
    throw new AppError("not_found", "Notebook not found", 404);
  }

  if (current.systemKind === ARTIFACT_LIBRARY_SYSTEM_KIND && input.parentId) {
    throw new AppError("artifact_library_protected", "The Artifact Library cannot be moved.", 400);
  }

  const nextName = input.name ?? current.name;
  const nextParentId = input.parentId === undefined ? current.parentId : input.parentId;
  const nextSortOrder = input.sortOrder ?? current.sortOrder;
  const nextSlug = isInboxNotebook(current, workspaceId) ? "inbox" : slugify(nextName);
  const now = isoNow();

  if (nextParentId === id) {
    throw new AppError("bad_request", "Notebook cannot be its own parent", 400);
  }

  if (nextParentId) {
    const parent = await getNotebook(db, workspaceId, nextParentId);

    if (!parent) {
      throw new AppError("not_found", "Parent notebook not found", 404);
    }

    if (await isNotebookDescendant(db, workspaceId, nextParentId, id)) {
      throw new AppError("notebook_cycle", "Notebook cannot be moved into its own descendant.", 409);
    }
  }

  if (nextParentId !== current.parentId) {
    const [currentLibraryId, targetLibraryId] = await Promise.all([
      findArtifactLibraryAncestorId(db, workspaceId, id),
      nextParentId ? findArtifactLibraryAncestorId(db, workspaceId, nextParentId) : null,
    ]);
    if (currentLibraryId !== targetLibraryId) {
      throw new AppError(
        "artifact_location_invalid",
        "Artifact Folders stay inside the Artifact Library and notebooks stay outside it.",
        400,
      );
    }
  }

  await db.batch([
    db
      .prepare(
        `UPDATE notebooks
         SET name = ?, slug = ?, parent_id = ?, sort_order = ?, icon = ?, color = ?, text_color = ?, color_target = ?, is_bold = ?, icon_inverted = ?, row_inverted = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND is_deleted = 0`
      )
      .bind(nextName, nextSlug, nextParentId ?? null, nextSortOrder,
        input.icon === undefined ? current.icon : input.icon,
        input.color === undefined ? current.color : input.color,
        input.textColor === undefined ? current.textColor : input.textColor,
        input.colorTarget ?? current.colorTarget ?? "icon", Number(input.isBold ?? current.isBold ?? false), Number(input.iconInverted ?? current.iconInverted ?? false), Number(input.rowInverted ?? current.rowInverted ?? false), now, id, workspaceId),
    auditStatement(db, actor.actorType, actor.actorId, "notebook.update", "notebook", id, input),
  ]);

  const notebook = await getNotebook(db, workspaceId, id);

  if (!notebook) {
    throw new AppError("not_found", "Notebook not found after update", 404);
  }

  return notebook;
};

const NOTEBOOK_DELETE_ID_CHUNK = 80;

const chunkValues = <T>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

// Active notebooks in this subtree. The anchor may already be deleted so a
// retried parent delete can still remove descendants that were left behind.
const listActiveNotebookTree = async (db: DatabaseAdapter, workspaceId: string, id: string) => {
  const rows = await db.prepare(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM notebooks WHERE workspace_id = ? AND id = ?
       UNION ALL
       SELECT n.id
       FROM notebooks n
       INNER JOIN tree t ON n.parent_id = t.id
       WHERE n.workspace_id = ?
     )
     SELECT n.id, n.slug, n.parent_id, n.system_kind
     FROM notebooks n
     INNER JOIN tree t ON t.id = n.id
     WHERE n.workspace_id = ? AND n.is_deleted = 0`
  ).bind(workspaceId, id, workspaceId, workspaceId).all<{ id: string; slug: string | null; parent_id: string | null; system_kind: string | null }>();

  return rows.results;
};

const countActiveMemosInNotebooks = async (db: DatabaseAdapter, workspaceId: string, notebookIds: string[]) => {
  let total = 0;
  for (const chunk of chunkValues(notebookIds, NOTEBOOK_DELETE_ID_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const row = await db.prepare(
      `SELECT COUNT(*) AS count FROM memos WHERE workspace_id = ? AND is_deleted = 0 AND notebook_id IN (${placeholders})`
    ).bind(workspaceId, ...chunk).first<{ count: number }>();
    total += Number(row?.count ?? 0);
  }
  return total;
};

export const deleteNotebookTree = async (
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
  actor: AuditActor,
  options: { dryRun?: boolean; guardConcurrentChanges?: boolean } = {},
) => {
  const result = (notebookIds: string[]) => ({
    notebookId: id, notebookIds, notebookCount: notebookIds.length,
    dryRun: options.dryRun === true, deleted: options.dryRun !== true,
  });
  const current = await db.prepare(
    `SELECT id, slug, is_deleted FROM notebooks WHERE id = ? AND workspace_id = ?`
  ).bind(id, workspaceId).first<{ id: string; slug: string | null; is_deleted: number }>();
  if (!current) throw new AppError("not_found", "Notebook not found", 404);
  if (isInboxNotebook(current, workspaceId)) {
    if (current.is_deleted) return result([]);
    throw new AppError("bad_request", "等待分类不能删除。", 400);
  }

  const tree = await listActiveNotebookTree(db, workspaceId, id);
  if (tree.length === 0) return result([]);
  if (tree.some((notebook) => isInboxNotebook(notebook, workspaceId))) {
    throw new AppError("bad_request", "等待分类不能删除。", 400);
  }
  if (tree.some((notebook) => notebook.system_kind === ARTIFACT_LIBRARY_SYSTEM_KIND)) {
    throw new AppError("artifact_library_protected", "The Artifact Library cannot be deleted.", 400);
  }

  const notebookIds = tree.map((notebook) => notebook.id);
  // Empty child notebooks are removed with the parent. Notes anywhere in the
  // subtree block the whole delete so a parent click cannot orphan them.
  if (await countActiveMemosInNotebooks(db, workspaceId, notebookIds) > 0) {
    throw new AppError(
      "notebook_not_empty",
      "Move or delete notes in this notebook and its child notebooks before deleting it.",
      409
    );
  }

  if (options.dryRun) return result(notebookIds);

  const now = isoNow();
  const inboxId = workspaceInboxId(workspaceId);
  if (options.guardConcurrentChanges) {
    // One guarded UPDATE prevents a note inserted after the emptiness check
    // from being hidden. Require the same active subtree, including parent
    // links, so concurrent moves/creates/deletes require a fresh attempt.
    const serializedSnapshot = JSON.stringify(tree.map(({ id, parent_id }) => ({ id, parent_id })));
    const update = db.prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM notebooks WHERE workspace_id = ? AND id = ?
        UNION
        SELECT n.id FROM notebooks n JOIN tree t ON n.parent_id = t.id WHERE n.workspace_id = ?
      ), active_tree AS MATERIALIZED (
        SELECT n.* FROM notebooks n JOIN tree t ON n.id = t.id
        WHERE n.workspace_id = ? AND n.is_deleted = 0
      ), expected AS (
        SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.parent_id') AS parent_id
        FROM json_each(?)
      )
      UPDATE notebooks SET is_deleted = 1, deleted_at = ?, updated_at = ?
      WHERE workspace_id = ? AND is_deleted = 0 AND id IN (SELECT id FROM active_tree)
        AND (SELECT COUNT(*) FROM active_tree) = ?
        AND NOT EXISTS (
          SELECT 1 FROM active_tree n LEFT JOIN expected e ON e.id = n.id
          WHERE e.id IS NULL OR n.parent_id IS NOT e.parent_id
        )
        AND NOT EXISTS (SELECT 1 FROM active_tree WHERE slug = 'inbox' OR id = 'nb_inbox' OR id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM memos WHERE workspace_id = ? AND is_deleted = 0
          AND notebook_id IN (SELECT id FROM active_tree)
        )
    `).bind(workspaceId, id, workspaceId, workspaceId, serializedSnapshot,
      now, now, workspaceId, notebookIds.length, inboxId, workspaceId);
    const auditDelete = db.prepare(`
      INSERT INTO audit_events (id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at)
      SELECT ?, ?, ?, 'notebook.delete', 'notebook', ?, ?, ? WHERE changes() = ?
    `).bind(createId("audit"), actor.actorType, actor.actorId, id, JSON.stringify({ notebookIds }), now, notebookIds.length);
    const [, audited] = await db.batch([update, auditDelete]);
    // Adapter UPDATE metadata may include sync-trigger writes. The conditional
    // audit uses SQLite changes(), which counts only the notebook rows.
    if (!(Number(audited?.meta.changes) > 0)) {
      throw new AppError("notebook_changed", "Notebook contents or hierarchy changed. Preview again before retrying deletion.", 409);
    }
    return result(notebookIds);
  }
  const statements = chunkValues(notebookIds, NOTEBOOK_DELETE_ID_CHUNK).map((chunk) => {
    const placeholders = chunk.map(() => "?").join(", ");
    return db.prepare(
      `UPDATE notebooks
       SET is_deleted = 1, deleted_at = ?, updated_at = ?
       WHERE workspace_id = ? AND is_deleted = 0 AND id IN (${placeholders})
         AND (slug IS NULL OR slug <> 'inbox') AND id <> 'nb_inbox' AND id <> ?`
    ).bind(now, now, workspaceId, ...chunk, inboxId);
  });
  statements.push(auditStatement(db, actor.actorType, actor.actorId, "notebook.delete", "notebook", id, {
    notebookIds,
  }));
  await db.batch(statements);
  return result(notebookIds);
};

// Preserve the existing REST deletion contract and mechanism.
export const deleteNotebookRecord = async (
  db: DatabaseAdapter, workspaceId: string, id: string, actor: AuditActor,
) => {
  await deleteNotebookTree(db, workspaceId, id, actor);
};

export const restoreNotebookRecord = async (
  db: DatabaseAdapter,
  workspaceId: string,
  id: string,
  actor: AuditActor
) => {
  const current = await db.prepare(
    `SELECT id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 1`
  ).bind(id, workspaceId).first<{ id: string }>();
  if (!current) throw new AppError("not_found", "Deleted notebook not found", 404);

  const now = isoNow();
  await db.batch([
    db.prepare(
      `UPDATE notebooks SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`
    ).bind(now, id, workspaceId),
    auditStatement(db, actor.actorType, actor.actorId, "notebook.restore", "notebook", id, {}),
  ]);

  const notebook = await getNotebook(db, workspaceId, id);
  if (!notebook) throw new AppError("not_found", "Notebook not found after restore", 404);
  return notebook;
};

export const isNotebookDescendant = async (
  db: DatabaseAdapter,
  workspaceId: string,
  candidateId: string,
  ancestorId: string
) => {
  const row = await db
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id
         FROM notebooks
         WHERE workspace_id = ? AND parent_id = ? AND is_deleted = 0

         UNION ALL

         SELECT n.id
         FROM notebooks n
         INNER JOIN descendants d ON n.parent_id = d.id
         WHERE n.workspace_id = ? AND n.is_deleted = 0
       )
       SELECT id
       FROM descendants
       WHERE id = ?
       LIMIT 1`
    )
    .bind(workspaceId, ancestorId, workspaceId, candidateId)
    .first<{ id: string }>();

  return Boolean(row);
};

/** The Artifact Library that contains this notebook (itself included), or null. */
export const findArtifactLibraryAncestorId = async (db: DatabaseAdapter, workspaceId: string, notebookId: string) => {
  const row = await db.prepare(
    `WITH RECURSIVE ancestors(id, parent_id, system_kind, depth) AS (
       SELECT id, parent_id, system_kind, 0 FROM notebooks WHERE workspace_id = ? AND id = ?
       UNION ALL
       SELECT n.id, n.parent_id, n.system_kind, a.depth + 1
       FROM notebooks n
       INNER JOIN ancestors a ON n.id = a.parent_id
       WHERE n.workspace_id = ? AND a.depth < 256
     )
     SELECT id FROM ancestors WHERE system_kind = ? LIMIT 1`
  ).bind(workspaceId, notebookId, workspaceId, ARTIFACT_LIBRARY_SYSTEM_KIND).first<{ id: string }>();
  return row?.id ?? null;
};

/**
 * Artifacts live only inside the Artifact Library and ordinary memos only
 * outside it. Throws `artifact_location_invalid` when a memo would cross over.
 */
export const MEMO_LOCATION_INVALID = {
  error: "artifact_location_invalid",
  message: "Artifacts stay inside the Artifact Library and notes stay outside it.",
  status: 400,
} as const;

export const isMemoLocationAllowed = async (db: DatabaseAdapter, workspaceId: string, notebookId: string, isArtifact: boolean) =>
  Boolean(await findArtifactLibraryAncestorId(db, workspaceId, notebookId)) === isArtifact;

export const assertMemoLocation = async (db: DatabaseAdapter, workspaceId: string, notebookId: string, isArtifact: boolean) => {
  if (!(await isMemoLocationAllowed(db, workspaceId, notebookId, isArtifact))) {
    throw new AppError(MEMO_LOCATION_INVALID.error, MEMO_LOCATION_INVALID.message, MEMO_LOCATION_INVALID.status);
  }
};

export const findArtifactLibrary = async (db: DatabaseAdapter, workspaceId: string) => {
  const row = await db.prepare(
    `SELECT id FROM notebooks WHERE workspace_id = ? AND system_kind = ? AND is_deleted = 0`
  ).bind(workspaceId, ARTIFACT_LIBRARY_SYSTEM_KIND).first<{ id: string }>();
  return row ? getNotebook(db, workspaceId, row.id) : null;
};

/**
 * Returns the workspace's Artifact Library, creating it on first use. The
 * partial unique index settles concurrent creators; a loser re-reads.
 */
export const ensureArtifactLibrary = async (
  db: DatabaseAdapter,
  workspaceId: string,
  locale: string | null | undefined,
  actor: AuditActor,
) => {
  const existing = await findArtifactLibrary(db, workspaceId);
  if (existing) return existing;

  const id = createId("nb");
  const now = isoNow();
  const name = localizeArtifactLibraryName(locale);
  const sortOrder = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order, system_kind, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).bind(id, workspaceId, name, slugify(name), sortOrder, ARTIFACT_LIBRARY_SYSTEM_KIND, now, now),
    db.prepare(
      `INSERT INTO audit_events (id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, created_at)
       SELECT ?, ?, ?, 'notebook.create', 'notebook', ?, ?, ? WHERE changes() = 1`
    ).bind(createId("audit"), actor.actorType, actor.actorId, id,
      JSON.stringify({ name, parentId: null, sortOrder, systemKind: ARTIFACT_LIBRARY_SYSTEM_KIND }), now),
  ]);

  const library = await findArtifactLibrary(db, workspaceId);
  if (!library) throw new AppError("not_found", "Artifact Library not found after create", 404);
  return library;
};
