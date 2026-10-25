import { describe, expect, test } from "bun:test";
import { createDefaultDiagramDocument, serializeDiagramDocument } from "@edgeever/shared";
import { listMemoActivity, listMemos, mapMemoSummary, toFtsQuery } from "./memo-list-service.ts";

const memoRow = (id, overrides = {}) => ({
  id,
  notebook_id: "nb_1",
  title: `Memo ${id}`,
  excerpt: `Excerpt ${id}`,
  content_text: `Body ${id}`,
  content_markdown: `Body ${id}`,
  tags_json: "[]",
  is_pinned: 0,
  is_archived: 0,
  is_deleted: 0,
  created_at: `2026-08-0${id.slice(-1)}T00:00:00.000Z`,
  updated_at: `2026-08-0${id.slice(-1)}T01:00:00.000Z`,
  deleted_at: null,
  revision: 1,
  ...overrides,
});

const createDatabase = ({ rows = [], totalCount = rows.length } = {}) => {
  const calls = [];
  return {
    calls,
    prepare: (sql) => ({
      bind: (...parameters) => {
        const call = { sql, parameters };
        calls.push(call);
        return {
          all: async () => ({ results: rows }),
          first: async () => ({ count: totalCount }),
        };
      },
    }),
  };
};

describe("memo list service", () => {
  test("identifies diagram notes without exposing their source as the note type", () => {
    const content_markdown = serializeDiagramDocument(createDefaultDiagramDocument("architecture"));

    expect(mapMemoSummary(memoRow("memo_1", { content_markdown })).diagramKind).toBe("architecture");
    expect(mapMemoSummary(memoRow("memo_2")).diagramKind).toBeNull();
  });

  test("paginates with an opaque cursor and reuses its sort position", async () => {
    const firstDatabase = createDatabase({
      rows: [memoRow("memo_1"), memoRow("memo_2"), memoRow("memo_3")],
      totalCount: 3,
    });
    const first = await listMemos(firstDatabase, {
      workspaceId: "ws_1",
      limit: 2,
    });

    expect(first.memos.map((memo) => memo.id)).toEqual(["memo_1", "memo_2"]);
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).toBeString();

    const secondDatabase = createDatabase({ rows: [memoRow("memo_3")] });
    await listMemos(secondDatabase, {
      workspaceId: "ws_1",
      limit: 2,
      cursor: first.nextCursor,
    });
    const pageQuery = secondDatabase.calls.find((call) => call.sql.includes("SELECT m.id"));
    expect(pageQuery.sql).toContain("m.updated_at < ?");
    expect(pageQuery.parameters).toContain("memo_2");
    expect(pageQuery.parameters.at(-1)).toBe(3);
  });

  test("applies descendant, trash, and tag filters to page and count queries", async () => {
    const database = createDatabase();
    await listMemos(database, {
      workspaceId: "ws_1",
      notebookId: "nb_parent",
      includeNotebookDescendants: true,
      includeTrash: true,
      filter: "tagged",
      sort: "title-asc",
    });

    expect(database.calls).toHaveLength(2);
    for (const call of database.calls) {
      expect(call.sql).toContain("WITH RECURSIVE descendants");
      expect(call.sql).toContain("m.is_deleted = 1");
      expect(call.sql).toContain("m.tags_json <> '[]'");
      expect(call.parameters.slice(0, 4)).toEqual(["ws_1", "ws_1", "nb_parent", "ws_1"]);
    }
  });

  test("paginates title Z-A by reverse title and keeps the update-time tie break", async () => {
    const titleExpression = "LOWER(COALESCE(NULLIF(m.title, ''), '无标题笔记'))";
    const firstDatabase = createDatabase({
      rows: [memoRow("memo_1", { title: "Zulu" }), memoRow("memo_2", { title: "Alpha" })],
      totalCount: 2,
    });
    const first = await listMemos(firstDatabase, {
      workspaceId: "ws_1",
      sort: "title-desc",
      limit: 1,
    });
    const orderQuery = firstDatabase.calls.find((call) => call.sql.includes("ORDER BY"));

    expect(orderQuery.sql).toContain(`m.is_pinned DESC, ${titleExpression} DESC, m.updated_at DESC, m.id DESC`);
    expect(orderQuery.sql).not.toContain(`${titleExpression} ASC`);

    const secondDatabase = createDatabase({ rows: [] });
    await listMemos(secondDatabase, {
      workspaceId: "ws_1",
      sort: "title-desc",
      limit: 1,
      cursor: first.nextCursor,
    });
    const pageQuery = secondDatabase.calls.find((call) => call.sql.includes("SELECT m.id"));

    expect(pageQuery.sql).toContain(`${titleExpression} < ?`);
    expect(pageQuery.sql).not.toContain(`${titleExpression} > ?`);
    expect(pageQuery.sql).toContain("m.updated_at < ?");
    expect(pageQuery.parameters).toContain("zulu");
    expect(pageQuery.parameters).toContain("2026-08-01T01:00:00.000Z");
  });

  test("keeps trash ordered by deletion time when the title sort is reversed", async () => {
    const database = createDatabase();
    await listMemos(database, {
      workspaceId: "ws_1",
      includeTrash: true,
      sort: "title-desc",
    });
    const pageQuery = database.calls.find((call) => call.sql.includes("ORDER BY"));

    expect(pageQuery.sql).toContain("ORDER BY m.deleted_at DESC, m.id DESC");
    expect(pageQuery.sql).not.toContain("NULLIF(m.title, '')");
  });

  test("filters by one exact tag in page and count queries", async () => {
    const database = createDatabase();
    await listMemos(database, {
      workspaceId: "ws_1",
      tag: "Demo",
    });

    expect(database.calls).toHaveLength(2);
    for (const call of database.calls) {
      expect(call.sql).toContain("FROM memo_tags mt");
      expect(call.sql).toContain("mt.normalized_name = LOWER(?)");
      expect(call.parameters.filter((value) => value === "ws_1").length).toBeGreaterThanOrEqual(2);
      expect(call.parameters).toContain("Demo");
      expect(call.sql).not.toContain("m.tags_json LIKE");
    }
  });

  test("combines FTS and escaped LIKE search for normal text", async () => {
    const database = createDatabase();
    await listMemos(database, {
      workspaceId: "ws_1",
      query: "hello 100%",
    });

    expect(toFtsQuery("hello 100%")).toBe('"hello" "100"');
    expect(database.calls[0].sql).toContain("memos_fts MATCH ?");
    expect(database.calls[0].parameters.slice(0, 4)).toEqual([
      '"hello" "100"',
      "%hello 100\\%%",
      "%hello 100\\%%",
      "%hello 100\\%%",
    ]);
  });

  test("falls back to LIKE when a query has no FTS tokens", async () => {
    const database = createDatabase();
    await listMemos(database, {
      workspaceId: "ws_1",
      query: "---",
    });

    expect(database.calls[0].sql).not.toContain("memos_fts MATCH");
    expect(database.calls[0].sql).toContain("m.title LIKE ?");
    expect(database.calls[0].parameters).toContain("%---%");
  });

  test("bounds created_at in page and count queries for every search branch", async () => {
    for (const query of [undefined, "hello", "---"]) {
      const database = createDatabase();
      await listMemos(database, {
        workspaceId: "ws_1",
        notebookId: "nb_inbox",
        query,
        createdFrom: "2026-10-24T16:00:00.000Z",
        createdTo: "2026-10-25T16:00:00.000Z",
      });

      expect(database.calls).toHaveLength(2);
      for (const call of database.calls) {
        expect(call.sql).toContain("m.created_at >= ?");
        expect(call.sql).toContain("m.created_at < ?");
        const fromIndex = call.parameters.indexOf("2026-10-24T16:00:00.000Z");
        expect(fromIndex).toBeGreaterThan(-1);
        expect(call.parameters[fromIndex + 1]).toBe("2026-10-25T16:00:00.000Z");
      }
    }
  });

  test("keeps the default query free of jot-only conditions and content", async () => {
    const database = createDatabase({ rows: [memoRow("memo_1")] });
    const result = await listMemos(database, { workspaceId: "ws_1", sort: "created-desc" });

    expect(database.calls[0].sql).toContain("ORDER BY m.is_pinned DESC, m.created_at DESC, m.id DESC");
    expect(database.calls[0].sql).not.toContain("m.created_at >= ?");
    expect(database.calls[0].parameters).toEqual(["ws_1", 101]);
    expect(result.memos[0]).not.toHaveProperty("contentMarkdown");
  });

  test("orders and paginates without pinned priority when pinnedFirst is false", async () => {
    for (const query of [undefined, "hello", "---"]) {
      const firstDatabase = createDatabase({
        rows: [memoRow("memo_3"), memoRow("memo_2", { is_pinned: 1 }), memoRow("memo_1")],
        totalCount: 3,
      });
      const first = await listMemos(firstDatabase, {
        workspaceId: "ws_1",
        query,
        sort: "created-desc",
        pinnedFirst: false,
        limit: 2,
      });
      const orderQuery = firstDatabase.calls.find((call) => call.sql.includes("ORDER BY"));
      expect(orderQuery.sql).toContain("ORDER BY m.created_at DESC, m.id DESC");
      expect(orderQuery.sql).not.toContain("is_pinned DESC");

      const secondDatabase = createDatabase({ rows: [memoRow("memo_1")] });
      await listMemos(secondDatabase, {
        workspaceId: "ws_1",
        query,
        sort: "created-desc",
        pinnedFirst: false,
        limit: 2,
        cursor: first.nextCursor,
      });
      const pageQuery = secondDatabase.calls.find((call) => call.sql.includes("ORDER BY"));
      expect(pageQuery.sql).toContain("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      expect(pageQuery.sql).not.toContain("m.is_pinned < ?");
      expect(pageQuery.parameters).toContain("2026-08-02T00:00:00.000Z");
      expect(pageQuery.parameters).toContain("memo_2");
    }
  });

  test("ignores a cursor issued for the other pinned ordering", async () => {
    const pinnedDatabase = createDatabase({ rows: [memoRow("memo_2"), memoRow("memo_1")], totalCount: 2 });
    const pinnedCursor = (await listMemos(pinnedDatabase, { workspaceId: "ws_1", sort: "created-desc", limit: 1 })).nextCursor;
    const unpinnedDatabase = createDatabase({ rows: [memoRow("memo_2"), memoRow("memo_1")], totalCount: 2 });
    const unpinnedCursor = (await listMemos(unpinnedDatabase, {
      workspaceId: "ws_1", sort: "created-desc", pinnedFirst: false, limit: 1,
    })).nextCursor;

    const mixedUnpinned = createDatabase();
    await listMemos(mixedUnpinned, { workspaceId: "ws_1", sort: "created-desc", pinnedFirst: false, cursor: pinnedCursor });
    expect(mixedUnpinned.calls[0].sql).not.toContain("m.created_at < ?");

    const mixedPinned = createDatabase();
    await listMemos(mixedPinned, { workspaceId: "ws_1", sort: "created-desc", cursor: unpinnedCursor });
    expect(mixedPinned.calls[0].sql).not.toContain("m.created_at < ?");
  });

  test("returns markdown content only when requested", async () => {
    const database = createDatabase({ rows: [memoRow("memo_1", { content_markdown: "# Hello\n\nBody" })] });
    const result = await listMemos(database, { workspaceId: "ws_1", withContent: true });

    expect(result.memos[0].contentMarkdown).toBe("# Hello\n\nBody");
    expect(result.memos[0].excerpt).toBe("Excerpt memo_1");
  });

  test("lists activity for one notebook without descendants or trash", async () => {
    const database = createDatabase({
      rows: [{ id: "memo_2", created_at: "2026-10-25T01:00:00.000Z", tags_json: "[\"idea\"]" }],
    });
    const result = await listMemoActivity(database, { workspaceId: "ws_1", notebookId: "nb_inbox" });

    expect(result).toEqual({ memos: [{ id: "memo_2", createdAt: "2026-10-25T01:00:00.000Z", tags: ["idea"] }] });
    expect(database.calls[0].sql).toContain("workspace_id = ? AND is_deleted = 0 AND notebook_id = ?");
    expect(database.calls[0].sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(database.calls[0].sql).not.toContain("RECURSIVE");
    expect(database.calls[0].parameters).toEqual(["ws_1", "nb_inbox", 20000]);

    const workspace = createDatabase();
    await listMemoActivity(workspace, { workspaceId: "ws_1", notebookId: null });
    expect(workspace.calls[0].sql).not.toContain("notebook_id = ?");
    expect(workspace.calls[0].parameters).toEqual(["ws_1", 20000]);
  });
});
