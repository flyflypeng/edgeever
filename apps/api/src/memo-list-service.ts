import {
  createExcerpt,
  DEFAULT_MEMO_TITLE,
  docToText,
  markdownToDoc,
  getDiagramSummary,
  getInfographicSummary,
  getPosterSummary,
  getTableSummary,
  getArtifactSummary,
  type MemoActivityItem,
  type MemoSummary,
} from "@edgeever/shared";
import { clampNumber, parseJsonArray } from "./entity-utils";
import type { DatabaseAdapter } from "./storage-contract";

export type MemoSummaryRow = {
  id: string;
  notebook_id: string;
  title: string | null;
  excerpt: string;
  content_text?: string | null;
  is_poster?: number;
  content_markdown?: string | null;
  tags_json: string;
  is_pinned: number;
  is_archived: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  revision: number;
};

type MemoListSortMode = "updated-desc" | "created-desc" | "title-asc" | "title-desc";
type MemoListFilterMode = "all" | "tagged" | "untagged" | "pinned";

type MemoListCursor = {
  sort: MemoListSortMode;
  id: string;
  // Only written when pinned memos are not ordered first, so cursors from the
  // two orderings never mix and default cursors keep their original shape.
  pinnedFirst?: false;
  pinned?: number;
  updatedAt?: string;
  createdAt?: string;
  deletedAt?: string | null;
  title?: string;
};

export type ListMemosInput = {
  workspaceId: string;
  notebookId?: string;
  includeNotebookDescendants?: boolean;
  query?: string;
  tag?: string;
  includeTrash?: boolean;
  sort?: string;
  filter?: string;
  limit?: number;
  cursor?: string;
  /** Inclusive ISO lower bound for created_at. */
  createdFrom?: string;
  /** Exclusive ISO upper bound for created_at. */
  createdTo?: string;
  /** Defaults to true; false drops is_pinned from ordering and cursors. */
  pinnedFirst?: boolean;
  /** Include contentMarkdown on every summary. */
  withContent?: boolean;
};

export type ListMemosResult = {
  memos: MemoSummary[];
  totalCount: number;
  nextCursor: string | null;
};

export type ListMemoActivityInput = {
  workspaceId: string;
  notebookId?: string | null;
};

export type ListMemoActivityResult = {
  memos: MemoActivityItem[];
};

const DEFAULT_MEMO_LIST_LIMIT = 100;
const MAX_MEMO_LIST_LIMIT = 200;
const MAX_MEMO_ACTIVITY_ROWS = 20000;

export const mapMemoSummary = (row: MemoSummaryRow): MemoSummary => ({
  id: row.id,
  notebookId: row.notebook_id,
  title: row.title,
  excerpt:
    row.excerpt ||
    createExcerpt(row.content_text ?? "") ||
    createExcerpt(docToText(markdownToDoc(row.content_markdown ?? ""))),
  ...getDiagramSummary(row.content_markdown),
  ...getInfographicSummary(row.content_markdown),
  ...getPosterSummary(row.content_markdown),
  ...(row.is_poster !== undefined ? { poster: Boolean(row.is_poster) } : {}),
  ...getTableSummary(row.content_markdown),
  ...getArtifactSummary(row.content_markdown),
  tags: parseJsonArray(row.tags_json),
  isPinned: Boolean(row.is_pinned),
  isArchived: Boolean(row.is_archived),
  isDeleted: Boolean(row.is_deleted),
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const normalizeMemoTitle = (value: string | null | undefined) => {
  const title = value?.trim();
  return title || DEFAULT_MEMO_TITLE;
};

const normalizeMemoListSort = (value: string | undefined): MemoListSortMode =>
  value === "created-desc" || value === "title-asc" || value === "title-desc" ? value : "updated-desc";

const isTitleSort = (sort: MemoListSortMode): sort is "title-asc" | "title-desc" =>
  sort === "title-asc" || sort === "title-desc";

const normalizeMemoListFilter = (value: string | undefined): MemoListFilterMode =>
  value === "tagged" || value === "untagged" || value === "pinned" ? value : "all";


const encodeMemoListCursor = (
  memo: MemoSummaryRow,
  sort: MemoListSortMode,
  includeTrash: boolean,
  pinnedFirst: boolean,
) => {
  const cursor: MemoListCursor = { sort, id: memo.id };
  if (!pinnedFirst) cursor.pinnedFirst = false;
  if (includeTrash) cursor.deletedAt = memo.deleted_at;
  else if (pinnedFirst) cursor.pinned = memo.is_pinned;

  if (sort === "created-desc") cursor.createdAt = memo.created_at;
  else if (isTitleSort(sort)) {
    cursor.title = normalizeMemoTitle(memo.title).toLocaleLowerCase();
    cursor.updatedAt = memo.updated_at;
  } else cursor.updatedAt = memo.updated_at;

  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const decodeMemoListCursor = (
  value: string | undefined,
  sort: MemoListSortMode,
  pinnedFirst: boolean,
): MemoListCursor | null => {
  if (!value) return null;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const cursor = JSON.parse(new TextDecoder().decode(bytes)) as Partial<MemoListCursor>;
    return cursor.sort === sort && typeof cursor.id === "string" && (cursor.pinnedFirst !== false) === pinnedFirst
      ? cursor as MemoListCursor
      : null;
  } catch {
    return null;
  }
};

export const toFtsQuery = (value: string) => {
  const tokens = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens
    .slice(0, 8)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
};

export const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

export const listMemos = async (
  database: DatabaseAdapter,
  input: ListMemosInput,
): Promise<ListMemosResult> => {
  const notebookId = input.notebookId;
  const query = input.query?.trim();
  const tag = input.tag?.trim();
  const includeTrash = input.includeTrash === true;
  const pinnedFirst = input.pinnedFirst !== false;
  const withContent = input.withContent === true;
  const sort = normalizeMemoListSort(input.sort);
  const filter = normalizeMemoListFilter(input.filter);
  const limit = clampNumber(input.limit ?? DEFAULT_MEMO_LIST_LIMIT, 1, MAX_MEMO_LIST_LIMIT);
  const cursor = decodeMemoListCursor(input.cursor, sort, pinnedFirst);
  const deletedClause = includeTrash ? "m.is_deleted = 1" : "m.is_deleted = 0";
  const titleSortExpression = `LOWER(COALESCE(NULLIF(m.title, ''), '${DEFAULT_MEMO_TITLE}'))`;
  const pinnedOrder = pinnedFirst ? "m.is_pinned DESC, " : "";
  const baseConditions = ["m.workspace_id = ?", deletedClause];
  const baseBinds: unknown[] = [input.workspaceId];

  if (notebookId) {
    if (input.includeNotebookDescendants) {
      baseConditions.push(
        `m.notebook_id IN (
           WITH RECURSIVE descendants(id) AS (
             SELECT id
             FROM notebooks
             WHERE workspace_id = ? AND id = ? AND is_deleted = 0

             UNION

             SELECT n.id
             FROM notebooks n
             INNER JOIN descendants d ON n.parent_id = d.id
             WHERE n.workspace_id = ? AND n.is_deleted = 0
           )
           SELECT id FROM descendants
         )`,
      );
      baseBinds.push(input.workspaceId, notebookId, input.workspaceId);
    } else {
      baseConditions.push("m.notebook_id = ?");
      baseBinds.push(notebookId);
    }
  }

  if (tag) {
    baseConditions.push(
      "EXISTS (SELECT 1 FROM memo_tags mt WHERE mt.memo_id = m.id AND mt.workspace_id = ? AND mt.normalized_name = LOWER(?))",
    );
    baseBinds.push(input.workspaceId, tag);
  }

  if (filter === "tagged") baseConditions.push("m.tags_json <> '[]'");
  else if (filter === "untagged") baseConditions.push("m.tags_json = '[]'");
  else if (filter === "pinned") baseConditions.push("m.is_pinned = 1");

  if (input.createdFrom) {
    baseConditions.push("m.created_at >= ?");
    baseBinds.push(input.createdFrom);
  }
  if (input.createdTo) {
    baseConditions.push("m.created_at < ?");
    baseBinds.push(input.createdTo);
  }

  const getOrderBy = () => {
    if (includeTrash) return "m.deleted_at DESC, m.id DESC";
    if (sort === "created-desc") return `${pinnedOrder}m.created_at DESC, m.id DESC`;
    if (isTitleSort(sort)) {
      const direction = sort === "title-desc" ? "DESC" : "ASC";
      return `${pinnedOrder}${titleSortExpression} ${direction}, m.updated_at DESC, m.id DESC`;
    }
    return `${pinnedOrder}m.updated_at DESC, m.id DESC`;
  };

  const cursorConditions = [...baseConditions];
  const cursorBinds = [...baseBinds];
  if (cursor) {
    if (includeTrash) {
      cursorConditions.push("(m.deleted_at < ? OR (m.deleted_at = ? AND m.id < ?))");
      cursorBinds.push(cursor.deletedAt ?? "", cursor.deletedAt ?? "", cursor.id);
    } else {
      let positionCondition: string;
      let positionBinds: unknown[];
      if (sort === "created-desc") {
        positionCondition = "(m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
        positionBinds = [cursor.createdAt ?? "", cursor.createdAt ?? "", cursor.id];
      } else if (isTitleSort(sort)) {
        const titleOperator = sort === "title-desc" ? "<" : ">";
        positionCondition = `(${titleSortExpression} ${titleOperator} ? OR (${titleSortExpression} = ? AND (m.updated_at < ? OR (m.updated_at = ? AND m.id < ?))))`;
        positionBinds = [cursor.title ?? "", cursor.title ?? "", cursor.updatedAt ?? "", cursor.updatedAt ?? "", cursor.id];
      } else {
        positionCondition = "(m.updated_at < ? OR (m.updated_at = ? AND m.id < ?))";
        positionBinds = [cursor.updatedAt ?? "", cursor.updatedAt ?? "", cursor.id];
      }
      if (pinnedFirst) {
        cursorConditions.push(`(m.is_pinned < ? OR (m.is_pinned = ? AND ${positionCondition}))`);
        cursorBinds.push(cursor.pinned ?? 0, cursor.pinned ?? 0, ...positionBinds);
      } else {
        cursorConditions.push(positionCondition);
        cursorBinds.push(...positionBinds);
      }
    }
  }

  const pageLimit = limit + 1;
  const finish = (rows: MemoSummaryRow[], totalCount: number | undefined): ListMemosResult => {
    const page = rows.slice(0, limit);
    return {
      memos: page.map((row) => withContent
        ? { ...mapMemoSummary(row), contentMarkdown: row.content_markdown ?? "" }
        : mapMemoSummary(row)),
      totalCount: totalCount ?? page.length,
      nextCursor: rows.length > limit
        ? encodeMemoListCursor(page[page.length - 1], sort, includeTrash, pinnedFirst)
        : null,
    };
  };

  if (query) {
    const ftsQuery = toFtsQuery(query);
    const likeQuery = `%${escapeLike(query)}%`;
    if (ftsQuery) {
      const searchPrefix = [ftsQuery, likeQuery, likeQuery, likeQuery];
      const [rows, totalRow] = await Promise.all([
        database.prepare(
          `WITH raw_matches(memo_id, rank) AS (
             SELECT memo_id, bm25(memos_fts)
             FROM memos_fts
             WHERE memos_fts MATCH ?

             UNION ALL

             SELECT m.id, 100.0
             FROM memos m
             INNER JOIN memo_contents c ON c.memo_id = m.id
             WHERE m.title LIKE ? ESCAPE '\\'
                OR c.content_text LIKE ? ESCAPE '\\'
                OR m.tags_json LIKE ? ESCAPE '\\'
           ),
           search_matches AS (
             SELECT memo_id, MIN(rank) AS rank
             FROM raw_matches
             GROUP BY memo_id
           )
           SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
                  m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, mc.revision,
                  mc.content_text, mc.content_markdown
           FROM search_matches s
           INNER JOIN memos m ON m.id = s.memo_id
           INNER JOIN memo_contents mc ON mc.memo_id = m.id
           WHERE ${cursorConditions.join(" AND ")}
           ORDER BY ${getOrderBy()}
           LIMIT ?`,
        ).bind(...searchPrefix, ...cursorBinds, pageLimit).all<MemoSummaryRow>(),
        database.prepare(
          `WITH raw_matches(memo_id) AS (
             SELECT memo_id
             FROM memos_fts
             WHERE memos_fts MATCH ?

             UNION ALL

             SELECT m.id
             FROM memos m
             INNER JOIN memo_contents c ON c.memo_id = m.id
             WHERE m.title LIKE ? ESCAPE '\\'
                OR c.content_text LIKE ? ESCAPE '\\'
                OR m.tags_json LIKE ? ESCAPE '\\'
           ),
           search_matches AS (
             SELECT memo_id
             FROM raw_matches
             GROUP BY memo_id
           )
           SELECT COUNT(*) AS count
           FROM search_matches s
           INNER JOIN memos m ON m.id = s.memo_id
           WHERE ${baseConditions.join(" AND ")}`,
        ).bind(...searchPrefix, ...baseBinds).first<{ count: number }>(),
      ]);
      return finish(rows.results, totalRow?.count);
    }

    const searchClause = "(m.title LIKE ? ESCAPE '\\' OR mc.content_text LIKE ? ESCAPE '\\' OR m.tags_json LIKE ? ESCAPE '\\')";
    const searchConditions = [...baseConditions, searchClause];
    const searchBinds = [...baseBinds, likeQuery, likeQuery, likeQuery];
    const searchCursorConditions = [...cursorConditions, searchClause];
    const searchCursorBinds = [...cursorBinds, likeQuery, likeQuery, likeQuery];
    const [rows, totalRow] = await Promise.all([
      database.prepare(
        `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
                m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, mc.revision,
                mc.content_text, mc.content_markdown
         FROM memos m
         INNER JOIN memo_contents mc ON mc.memo_id = m.id
         WHERE ${searchCursorConditions.join(" AND ")}
         ORDER BY ${getOrderBy()}
         LIMIT ?`,
      ).bind(...searchCursorBinds, pageLimit).all<MemoSummaryRow>(),
      database.prepare(
        `SELECT COUNT(*) AS count
         FROM memos m
         INNER JOIN memo_contents mc ON mc.memo_id = m.id
         WHERE ${searchConditions.join(" AND ")}`,
      ).bind(...searchBinds).first<{ count: number }>(),
    ]);
    return finish(rows.results, totalRow?.count);
  }

  const [rows, totalRow] = await Promise.all([
    database.prepare(
      `SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
              m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, mc.revision,
              mc.content_text, mc.content_markdown
       FROM memos m
       INNER JOIN memo_contents mc ON mc.memo_id = m.id
       WHERE ${cursorConditions.join(" AND ")}
       ORDER BY ${getOrderBy()}
       LIMIT ?`,
    ).bind(...cursorBinds, pageLimit).all<MemoSummaryRow>(),
    database.prepare(
      `SELECT COUNT(*) AS count
       FROM memos m
       WHERE ${baseConditions.join(" AND ")}`,
    ).bind(...baseBinds).first<{ count: number }>(),
  ]);
  return finish(rows.results, totalRow?.count);
};

/** Created-at and tags for every live memo directly in one notebook (or the workspace), newest first. */
export const listMemoActivity = async (
  database: DatabaseAdapter,
  input: ListMemoActivityInput,
): Promise<ListMemoActivityResult> => {
  const conditions = ["workspace_id = ?", "is_deleted = 0"];
  const binds: unknown[] = [input.workspaceId];
  if (input.notebookId) {
    conditions.push("notebook_id = ?");
    binds.push(input.notebookId);
  }
  const rows = await database.prepare(
    `SELECT id, created_at, tags_json
     FROM memos
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).bind(...binds, MAX_MEMO_ACTIVITY_ROWS).all<{ id: string; created_at: string; tags_json: string }>();
  return {
    memos: rows.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      tags: parseJsonArray(row.tags_json),
    })),
  };
};
