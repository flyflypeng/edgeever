import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { AppError } from "./app-error.ts";
import { apiError } from "./http-errors.ts";
import { registerNotebookRoutes } from "./notebook-routes.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { registerSyncRoutes } from "./sync-routes.ts";

// The Artifact Library is one system root notebook per workspace. Its
// descendants are Artifact Folders, kept apart from the ordinary notebook tree.
const WORKSPACE_ID = "ws_default";
const OTHER_WORKSPACE_ID = "ws_other";
const ownerAuth = {
  kind: "user", actorType: "user", actorId: "usr_owner", username: "admin", displayName: "Admin",
  scopes: [], workspaceId: WORKSPACE_ID, role: "owner",
};
const cleanups = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const installation = () => {
  const sqlite = new Database(":memory:");
  for (const file of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(file, "utf8"));
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, 'Other', 1)").run(OTHER_WORKSPACE_ID);
  cleanups.push(() => sqlite.close());
  const storage = createSelfHostedStorageAdapter(sqlite, "/tmp/edgeever-artifact-library-unused");
  const app = new Hono();
  let auth = ownerAuth;
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
    throw error;
  });
  registerNotebookRoutes(app, async () => {});
  registerSyncRoutes(app, {
    clampNumber: (value, min, max) => Math.min(Math.max(value, min), max),
    mapMemoDetail: (row) => ({ id: row.id }),
  });
  const request = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await app.request(path, init, { storage });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const ensureLibrary = async (body) => {
    const response = await request("POST", "/api/v1/artifact-library", body);
    expect(response.status).toBe(200);
    return response.body.notebook;
  };
  const createNotebook = async (name, parentId = null) => {
    const response = await request("POST", "/api/v1/notebooks", { name, parentId });
    expect(response.status).toBe(201);
    return response.body.notebook;
  };
  const moveNotebook = (id, parentId) => request("PATCH", `/api/v1/notebooks/${id}`, { parentId });
  const listNotebooks = async () => (await request("GET", "/api/v1/notebooks")).body.notebooks;
  return {
    sqlite, request, ensureLibrary, createNotebook, moveNotebook, listNotebooks,
    setAuth: (next) => { auth = next; },
  };
};

describe("ensure artifact library", () => {
  test("creates the library once and returns the same notebook afterwards", async () => {
    const { ensureLibrary, listNotebooks } = installation();

    const created = await ensureLibrary({ locale: "en-US" });
    expect(created).toMatchObject({ parentId: null, name: "Agent Artifacts", systemKind: "artifact_library" });

    const again = await ensureLibrary({ locale: "zh-CN" });
    expect(again.id).toBe(created.id);
    expect(again.name).toBe("Agent Artifacts");

    const notebooks = await listNotebooks();
    expect(notebooks.filter((notebook) => notebook.systemKind === "artifact_library").map((notebook) => notebook.id))
      .toEqual([created.id]);
    expect(notebooks.find((notebook) => notebook.slug === "inbox")?.systemKind).toBeNull();
  });

  test("names the library from the request language when no locale is sent", async () => {
    const { request } = installation();
    const response = await request("POST", "/api/v1/artifact-library", undefined, { "Accept-Language": "zh-CN,zh;q=0.9" });
    expect(response.status).toBe(200);
    expect(response.body.notebook.name).toBe("Agent 制品");
  });

  test("concurrent calls converge on a single library", async () => {
    const { ensureLibrary, sqlite } = installation();

    const results = await Promise.all(Array.from({ length: 5 }, () => ensureLibrary()));

    expect(new Set(results.map((notebook) => notebook.id)).size).toBe(1);
    expect(sqlite.query(
      "SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = ? AND system_kind = 'artifact_library'",
    ).get(WORKSPACE_ID).count).toBe(1);
  });

  test("keeps libraries separate per workspace", async () => {
    const { ensureLibrary, setAuth } = installation();
    const first = await ensureLibrary();
    setAuth({ ...ownerAuth, workspaceId: OTHER_WORKSPACE_ID, actorId: "usr_other" });
    const second = await ensureLibrary();
    expect(second.id).not.toBe(first.id);
  });

  test("requires the write:notebooks scope", async () => {
    const { request, setAuth, sqlite } = installation();
    setAuth({ ...ownerAuth, kind: "agent", actorType: "agent", actorId: "tok_read", scopes: ["read:notebooks"] });
    const response = await request("POST", "/api/v1/artifact-library");
    expect(response.status).toBe(403);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM notebooks WHERE system_kind IS NOT NULL").get().count).toBe(0);
  });

  test("synced notebook changes carry the system kind", async () => {
    const { ensureLibrary, request } = installation();
    const library = await ensureLibrary();
    const response = await request("GET", "/api/v1/sync/changes?cursor=0&limit=200");
    expect(response.status).toBe(200);
    const change = response.body.changes.find((item) => item.entityId === library.id);
    expect(change.notebook.systemKind).toBe("artifact_library");
    const bootstrap = await request("GET", "/api/v1/sync/bootstrap?limit=200");
    expect(bootstrap.body.notebooks.find((notebook) => notebook.id === library.id)?.systemKind).toBe("artifact_library");
  });
});

describe("artifact library protection", () => {
  test("cannot be deleted or moved, but can be renamed", async () => {
    const { ensureLibrary, createNotebook, request, moveNotebook } = installation();
    const library = await ensureLibrary();
    const ordinary = await createNotebook("Projects");

    const deleted = await request("DELETE", `/api/v1/notebooks/${library.id}`);
    expect(deleted.status).toBe(400);
    expect(deleted.body.error.code).toBe("artifact_library_protected");

    const moved = await moveNotebook(library.id, ordinary.id);
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe("artifact_library_protected");

    const renamed = await request("PATCH", `/api/v1/notebooks/${library.id}`, { name: "AI 作品集" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.notebook).toMatchObject({ id: library.id, name: "AI 作品集", parentId: null, systemKind: "artifact_library" });
    expect((await ensureLibrary()).id).toBe(library.id);
  });
});

describe("artifact folder location", () => {
  test("folders move only inside the library and notebooks never move into it", async () => {
    const { ensureLibrary, createNotebook, moveNotebook } = installation();
    const library = await ensureLibrary();
    const folder = await createNotebook("Project A", library.id);
    const otherFolder = await createNotebook("Project B", library.id);
    const ordinary = await createNotebook("Projects");
    const ordinaryChild = await createNotebook("Child", ordinary.id);
    expect(folder.systemKind).toBeNull();

    expect((await moveNotebook(folder.id, otherFolder.id)).status).toBe(200);
    expect((await moveNotebook(folder.id, library.id)).status).toBe(200);

    for (const parentId of [ordinary.id, ordinaryChild.id, null]) {
      const response = await moveNotebook(folder.id, parentId);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("artifact_location_invalid");
    }
    for (const [id, parentId] of [[ordinary.id, library.id], [ordinaryChild.id, otherFolder.id]]) {
      const response = await moveNotebook(id, parentId);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("artifact_location_invalid");
    }
  });

  test("deleting a folder follows notebook rules: refuse when it holds notes, cascade empty children", async () => {
    const { ensureLibrary, createNotebook, request, sqlite, listNotebooks } = installation();
    const library = await ensureLibrary();
    const full = await createNotebook("Full", library.id);
    const fullChild = await createNotebook("Full child", full.id);
    sqlite.query(
      `INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt) VALUES ('memo_in_folder', ?, ?, 'Page', '')`,
    ).run(WORKSPACE_ID, fullChild.id);
    const empty = await createNotebook("Empty", library.id);
    const emptyChild = await createNotebook("Empty child", empty.id);

    const refused = await request("DELETE", `/api/v1/notebooks/${full.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("notebook_not_empty");

    expect((await request("DELETE", `/api/v1/notebooks/${empty.id}`)).status).toBe(200);
    const remaining = new Set((await listNotebooks()).map((notebook) => notebook.id));
    expect(remaining.has(empty.id) || remaining.has(emptyChild.id)).toBe(false);
    expect(remaining.has(full.id) && remaining.has(fullChild.id) && remaining.has(library.id)).toBe(true);
  });
});
