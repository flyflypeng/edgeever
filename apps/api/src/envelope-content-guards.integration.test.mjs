import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVELOPE_CONTENT_GUARDS } from "./envelope-content-guards.ts";
import { callMcpTool, fetchEdgeEverApp } from "./index.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

// A made-up envelope type that exists only in this test. Registering it must
// be enough for both the ordinary save path and MCP update_memo to protect it.
const MARKER = "<!-- edgeever-test-envelope-v1:";
const VALID_BODY = `Preview\n\n${MARKER}ok -->`;
const hasTestMarker = (markdown) => Boolean(markdown?.includes(MARKER));
const isValidTestEnvelope = (markdown) => Boolean(markdown?.includes(`${MARKER}ok -->`));
const TEST_ENVELOPE = {
  save: {
    protects: hasTestMarker,
    accepts: isValidTestEnvelope,
    rejected: { error: "test_envelope_update_required", message: "Test envelope must stay intact.", status: 409 },
    invalid: { hasMarker: hasTestMarker, error: "invalid_test_envelope", message: "Invalid test envelope.", status: 400 },
  },
  updateMemo: { protects: hasTestMarker, code: "test_envelope_update_required", message: "Use the test envelope tool." },
};

const cleanups = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

const installation = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(file, "utf8"));
  const resourcesDirectory = mkdtempSync(join(tmpdir(), "edgeever-envelope-guards-"));
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
    return { status: response.status, body: await response.json() };
  };
  // Saving body content needs a bound edit session, the way the editor saves.
  const saveBody = async (memoId, contentMarkdown) => {
    const { body } = await request("POST", `/api/v1/memos/${memoId}/edit-sessions`);
    return request("PATCH", `/api/v1/memos/${memoId}`, {
      contentMarkdown,
      editSessionId: body.editSession.id,
      expectedRevision: body.editSession.baseRevision,
      expectedContentHash: body.editSession.baseContentHash,
    });
  };
  const agentAuth = {
    kind: "agent", actorType: "agent", actorId: "tok_agent", username: "agent", displayName: null,
    scopes: ["read:memos", "write:memos"], workspaceId: "ws_default", role: "owner",
  };
  const updateMemoThroughMcp = (memoId, contentMarkdown) => callMcpTool(
    { env: environment, get: (key) => (key === "auth" ? agentAuth : undefined) },
    agentAuth,
    "update_memo",
    { memoId, contentMarkdown },
  );
  return { request, saveBody, updateMemoThroughMcp };
};

const registerTestEnvelope = () => {
  ENVELOPE_CONTENT_GUARDS.push(TEST_ENVELOPE);
  cleanups.push(() => ENVELOPE_CONTENT_GUARDS.splice(ENVELOPE_CONTENT_GUARDS.indexOf(TEST_ENVELOPE), 1));
};

describe("envelope content guards", () => {
  test("a registered envelope type is protected on ordinary saves and MCP update_memo", async () => {
    const env = installation();
    const { body: inbox } = await env.request("GET", "/api/v1/notebooks");
    const notebookId = inbox.notebooks.find((notebook) => notebook.slug === "inbox").id;
    const create = async (contentMarkdown) => {
      const created = await env.request("POST", "/api/v1/memos", { notebookId, title: "Envelope", contentMarkdown });
      expect(created.status).toBe(201);
      return created.body.memo.id;
    };
    const memoId = await create(VALID_BODY);
    const plainMemoId = await create("plain text");
    // Before registration nothing protects the made-up type.
    expect((await env.saveBody(await create("plain text"), `Preview\n\n${MARKER}broken -->`)).status).toBe(200);
    registerTestEnvelope();

    const replaced = await env.saveBody(memoId, "plain text from an old client");
    expect(replaced).toMatchObject({ status: 409, body: { error: { code: "test_envelope_update_required" } } });
    await expect(env.updateMemoThroughMcp(memoId, "plain text from an agent"))
      .rejects.toMatchObject({ code: "test_envelope_update_required", status: 400 });
    expect((await env.request("GET", `/api/v1/memos/${memoId}`)).body.memo.contentMarkdown).toBe(VALID_BODY);
    const broken = await env.saveBody(plainMemoId, `Again\n\n${MARKER}broken -->`);
    expect(broken).toMatchObject({ status: 400, body: { error: { code: "invalid_test_envelope" } } });

    expect((await env.request("PATCH", `/api/v1/memos/${memoId}`, { title: "Renamed envelope" })).status).toBe(200);
    expect((await env.saveBody(memoId, `Updated preview\n\n${MARKER}ok -->`)).status).toBe(200);
  });
});
