import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";

const migrationPaths = globSync("migrations/*.sql").sort();
const artifactLibraryMigration = migrationPaths.find((path) => path.endsWith("_artifact_library.sql"));

// prepare() instead of the cached query(): a cached `SELECT *` keeps the
// pre-migration column list.
const snapshot = (sqlite) => ({
  notebooks: sqlite.prepare("SELECT * FROM notebooks ORDER BY id").all(),
  memos: sqlite.prepare("SELECT * FROM memos ORDER BY id").all(),
  memoContents: sqlite.prepare("SELECT * FROM memo_contents ORDER BY memo_id").all(),
});

const insertLibrary = (sqlite, id, workspaceId, isDeleted = 0) => sqlite.query(
  `INSERT INTO notebooks (id, workspace_id, name, slug, system_kind, is_deleted)
   VALUES (?, ?, 'Agent 制品', 'agent-制品', 'artifact_library', ?)`,
).run(id, workspaceId, isDeleted);

describe("artifact library migration", () => {
  test("adds an empty system kind without touching existing data and allows one library per workspace", () => {
    expect(artifactLibraryMigration).toBeDefined();
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const path of migrationPaths.filter((path) => path < artifactLibraryMigration)) {
      sqlite.exec(readFileSync(path, "utf8"));
    }

    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES ('ws_other', 'Other', 1)").run();
    sqlite.query(
      `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug) VALUES
         ('ws_other_inbox', 'ws_other', NULL, '等待分类', 'inbox'),
         ('nb_parent', 'ws_default', NULL, 'Parent', 'parent'),
         ('nb_child', 'ws_default', 'nb_parent', 'Child', 'child')`,
    ).run();
    sqlite.query(
      `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt)
       VALUES ('memo_child', 'ws_default', 'nb_child', 'Child memo', 'excerpt')`,
    ).run();
    sqlite.query(
      `INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_text, content_hash)
       VALUES ('memo_child', '{"type":"doc","content":[]}', 'body', 'body', 'hash')`,
    ).run();
    const before = snapshot(sqlite);
    expect(before.notebooks.some((notebook) => notebook.slug === "inbox" && notebook.workspace_id === "ws_default")).toBe(true);

    sqlite.exec(readFileSync(artifactLibraryMigration, "utf8"));

    const after = snapshot(sqlite);
    expect(after.notebooks).toEqual(before.notebooks.map((notebook) => ({ ...notebook, system_kind: null })));
    expect(after.memos).toEqual(before.memos);
    expect(after.memoContents).toEqual(before.memoContents);

    insertLibrary(sqlite, "nb_library_default", "ws_default");
    expect(() => insertLibrary(sqlite, "nb_library_duplicate", "ws_default")).toThrow(/UNIQUE/);
    insertLibrary(sqlite, "nb_library_other", "ws_other");
    // Only an active library counts; a soft-deleted row does not block it.
    insertLibrary(sqlite, "nb_library_deleted", "ws_other", 1);
    expect(sqlite.query(
      "SELECT workspace_id FROM notebooks WHERE system_kind = 'artifact_library' AND is_deleted = 0 ORDER BY workspace_id",
    ).all()).toEqual([{ workspace_id: "ws_default" }, { workspace_id: "ws_other" }]);
    sqlite.close();
  });
});
