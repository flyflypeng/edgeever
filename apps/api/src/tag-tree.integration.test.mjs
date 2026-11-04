import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callMcpTool, fetchEdgeEverApp } from "./index.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

// Hierarchical tags live in the tag text (ADR-0003): `/` marks levels and the
// server only tidies paths on write. Lookups keep matching stored text so
// legacy spellings stay renamable.
const cleanups = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

const installation = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(file, "utf8"));
  const resourcesDirectory = mkdtempSync(join(tmpdir(), "edgeever-tag-tree-"));
  cleanups.push(() => {
    sqlite.close();
    rmSync(resourcesDirectory, { recursive: true, force: true });
  });
  const storage = createSelfHostedStorageAdapter(sqlite, resourcesDirectory);
  const environment = { storage, EDGE_EVER_ALLOW_UNAUTHENTICATED: "true", EDGE_EVER_RUNTIME: "self-hosted-bun" };
  const request = async (method, path, body) => {
    const response = await fetchEdgeEverApp(
      new Request(`http://edgeever.test${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      environment,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const agentAuth = {
    kind: "agent", actorType: "agent", actorId: "tok_agent", username: "agent", displayName: null,
    scopes: ["read:memos", "write:memos", "write:tags", "read:tags"], workspaceId: "ws_default", role: "owner",
  };
  const mcp = (name, args) => callMcpTool(
    { env: environment, get: (key) => (key === "auth" ? agentAuth : undefined) },
    agentAuth,
    name,
    args,
  );
  const inboxId = sqlite.query("SELECT id FROM notebooks WHERE slug = 'inbox'").get().id;
  const createMemo = async (tags, options = {}) => {
    const notebookId = options.notebookId ?? inboxId;
    const response = await request("POST", "/api/v1/memos", {
      notebookId,
      contentMarkdown: options.contentMarkdown ?? `# note ${Math.random()}`,
      tags,
    });
    expect(response.status).toBe(201);
    return response.body.memo;
  };
  const listMemoIds = async (query) => (await request("GET", `/api/v1/memos?${query}`)).body.memos.map((memo) => memo.id);
  const artifactLibraryId = async () => {
    const response = await request("POST", "/api/v1/artifact-library", { locale: "en-US" });
    expect(response.status).toBe(200);
    return response.body.notebook.id;
  };
  const createArtifact = async (tags) => {
    const libraryId = await artifactLibraryId();
    const form = new FormData();
    form.append("file", new File(["<!doctype html><title>Kernel notes</title><p>kernel</p>"], "kernel.html", { type: "text/html" }));
    form.append("folderId", libraryId);
    form.append("tags", JSON.stringify(tags));
    const response = await fetchEdgeEverApp(
      new Request("http://edgeever.test/api/v1/artifacts", { method: "POST", body: form }),
      environment,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    expect(response.status).toBe(201);
    return (await response.json()).memo;
  };
  return { sqlite, request, mcp, createMemo, listMemoIds, createArtifact, inboxId, artifactLibraryId };
};

describe("tag writes", () => {
  test("normalizes tag paths on create, update and MCP add", async () => {
    const { request, mcp, createMemo } = installation();

    const created = await createMemo(["a / b", "a//b", "  ", "📚读书 / 小说"]);
    expect(created.tags).toEqual(["a/b", "📚读书/小说"]);

    const updated = await request("PATCH", `/api/v1/memos/${created.id}`, { tags: ["/x/", "y / z"] });
    expect(updated.status).toBe(200);
    expect(updated.body.memo.tags).toEqual(["x", "y/z"]);

    const added = await mcp("add_tags_to_memos", { memoIds: [created.id], tags: ["p / q"] });
    expect(added.updated).toBe(1);
    const reread = await request("GET", `/api/v1/memos/${created.id}`);
    expect(reread.body.memo.tags).toContain("p/q");
  });

  test("replays an old client that still writes unnormalized tags", async () => {
    const { sqlite, request, createMemo, listMemoIds } = installation();

    const memo = await createMemo(["legacy"]);
    // Simulate rows written by a client that predates path normalization.
    sqlite.query("UPDATE memos SET tags_json = ? WHERE id = ?").run(JSON.stringify(["a / b", "keep"]), memo.id);
    sqlite.query("DELETE FROM memo_tags WHERE memo_id = ?").run(memo.id);
    sqlite.query("INSERT INTO memo_tags (memo_id, workspace_id, name, normalized_name) VALUES (?, 'ws_default', ?, ?)")
      .run(memo.id, "a / b", "a / b");
    sqlite.query("INSERT INTO memo_tags (memo_id, workspace_id, name, normalized_name) VALUES (?, 'ws_default', ?, ?)")
      .run(memo.id, "keep", "keep");

    expect(await listMemoIds("tag=" + encodeURIComponent("a / b"))).toEqual([memo.id]);

    const renamed = await request("PATCH", `/api/v1/tags/${encodeURIComponent("a / b")}`, { name: "a/b" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.updated).toBe(1);
    const afterRename = await request("GET", `/api/v1/memos/${memo.id}`);
    expect(afterRename.body.memo.tags).toEqual(["a/b", "keep"]);
  });

  test("deletes and removes a legacy tag whose text was never normalized", async () => {
    const { sqlite, request, mcp, createMemo } = installation();

    const keepLegacy = async (memoId) => {
      sqlite.query("UPDATE memos SET tags_json = ? WHERE id = ?").run(JSON.stringify(["a / b", "keep"]), memoId);
      sqlite.query("DELETE FROM memo_tags WHERE memo_id = ?").run(memoId);
      for (const name of ["a / b", "keep"]) {
        sqlite.query("INSERT INTO memo_tags (memo_id, workspace_id, name, normalized_name) VALUES (?, 'ws_default', ?, ?)")
          .run(memoId, name, name);
      }
    };

    const removed = await createMemo(["placeholder"]);
    await keepLegacy(removed.id);
    const removal = await mcp("remove_tags_from_memos", { memoIds: [removed.id], tags: ["a / b"] });
    expect(removal.updated).toBe(1);
    expect((await request("GET", `/api/v1/memos/${removed.id}`)).body.memo.tags).toEqual(["keep"]);

    const deleted = await createMemo(["placeholder"]);
    await keepLegacy(deleted.id);
    const deletion = await request("DELETE", `/api/v1/tags/${encodeURIComponent("a / b")}`);
    expect(deletion.status).toBe(200);
    expect(deletion.body.updated).toBe(1);
    expect((await request("GET", `/api/v1/memos/${deleted.id}`)).body.memo.tags).toEqual(["keep"]);
  });

  test("renames, deletes and removes tags whose names contain a slash", async () => {
    const { request, mcp, createMemo } = installation();

    const first = await createMemo(["topic/kernel"]);
    const second = await createMemo(["topic/kernel", "other"]);

    const renamed = await request("PATCH", `/api/v1/tags/${encodeURIComponent("topic/kernel")}`, { name: "topic/core" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.updated).toBe(2);

    const removed = await mcp("remove_tags_from_memos", { memoIds: [first.id, second.id], tags: ["topic/core"] });
    expect(removed.updated).toBe(2);
    expect((await request("GET", `/api/v1/memos/${first.id}`)).body.memo.tags).toEqual([]);

    const third = await createMemo(["topic/core"]);
    const deleted = await request("DELETE", `/api/v1/tags/${encodeURIComponent("topic/core")}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.updated).toBe(1);
    expect((await request("GET", `/api/v1/memos/${third.id}`)).body.memo.tags).toEqual([]);
  });
});

describe("tagAny filter", () => {
  test("matches any of the given tags and keeps artifacts in the result", async () => {
    const { createMemo, createArtifact, listMemoIds } = installation();

    const parent = await createMemo(["a"]);
    const child = await createMemo(["a/b"]);
    const grandchild = await createMemo(["a/b/c"]);
    const unrelated = await createMemo(["z"]);
    const artifact = await createArtifact(["a/b"]);

    const query = ["a", "a/b", "a/b/c"].map((tag) => `tagAny=${encodeURIComponent(tag)}`).join("&");
    const ids = await listMemoIds(query);
    expect(ids.sort()).toEqual([parent.id, child.id, grandchild.id, artifact.id].sort());
    expect(ids).not.toContain(unrelated.id);
  });

  test("accepts more tag names than the D1 bound parameter limit", async () => {
    const { request, createMemo } = installation();

    const wanted = Array.from({ length: 150 }, (_, index) => `bulk/${index}`);
    for (const tag of wanted) await createMemo([tag]);

    const query = wanted.map((tag) => `tagAny=${encodeURIComponent(tag)}`).join("&");
    const response = await request("GET", `/api/v1/memos?${query}&limit=100`);
    expect(response.status).toBe(200);
    expect(response.body.totalCount).toBe(150);
    expect(response.body.memos).toHaveLength(100);
  });

  test("rejects tagAny combined with tag and leaves the tag filter unchanged", async () => {
    const { request, createMemo, listMemoIds } = installation();

    const memo = await createMemo(["solo"]);
    const conflict = await request("GET", "/api/v1/memos?tag=solo&tagAny=solo");
    expect(conflict.status).toBe(400);
    expect(conflict.body.error.code).toBe("invalid_params");
    expect(await listMemoIds("tag=solo")).toEqual([memo.id]);
    expect(await listMemoIds("tag=SOLO")).toEqual([memo.id]);
    expect(await listMemoIds("tag=sol")).toEqual([]);
  });
});

describe("activity includeArtifacts", () => {
  test("keeps artifacts out by default and includes them on request", async () => {
    const { request, createMemo, createArtifact } = installation();

    const note = await createMemo(["a/b"]);
    const artifact = await createArtifact(["a/b"]);

    const withoutFlag = await request("GET", "/api/v1/memos/activity");
    expect(withoutFlag.body.memos.map((memo) => memo.id)).toContain(note.id);
    expect(withoutFlag.body.memos.map((memo) => memo.id)).not.toContain(artifact.id);

    const withFlag = await request("GET", "/api/v1/memos/activity?includeArtifacts=1");
    const ids = withFlag.body.memos.map((memo) => memo.id);
    expect(ids).toContain(note.id);
    expect(ids).toContain(artifact.id);
    expect(withFlag.body.memos.find((memo) => memo.id === artifact.id).tags).toEqual(["a/b"]);
  });
});
