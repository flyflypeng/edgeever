import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callMcpTool, fetchEdgeEverApp } from "./index.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

// An HTML Artifact is a memo in the Artifact Library. Its HTML is stored as a
// text/html resource; the memo body carries only the envelope and fallback text.
const MiB = 1024 * 1024;
const cleanups = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

const installation = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(file, "utf8"));
  const resourcesDirectory = mkdtempSync(join(tmpdir(), "edgeever-html-artifacts-"));
  cleanups.push(() => {
    sqlite.close();
    rmSync(resourcesDirectory, { recursive: true, force: true });
  });
  const storage = createSelfHostedStorageAdapter(sqlite, resourcesDirectory);
  const environment = { storage, EDGE_EVER_ALLOW_UNAUTHENTICATED: "true", EDGE_EVER_RUNTIME: "self-hosted-bun" };
  const send = async (method, path, init = {}) => {
    const response = await fetchEdgeEverApp(
      new Request(`http://edgeever.test${path}`, { method, ...init }),
      environment,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );
    const type = response.headers.get("Content-Type") ?? "";
    return { status: response.status, headers: response.headers, body: type.includes("json") ? await response.json() : await response.text() };
  };
  const request = (method, path, body) => send(method, path, body === undefined
    ? {}
    : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const importArtifact = (file, fields = {}) => {
    const form = new FormData();
    if (file) form.append("file", file);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return send("POST", "/api/v1/artifacts", { body: form });
  };
  const ensureLibrary = async () => (await request("POST", "/api/v1/artifact-library", { locale: "en-US" })).body.notebook;
  const inboxId = async () => (await request("GET", "/api/v1/notebooks")).body.notebooks.find((notebook) => notebook.slug === "inbox").id;
  const saveBody = async (memoId, payload) => {
    const { body } = await request("POST", `/api/v1/memos/${memoId}/edit-sessions`);
    return request("PATCH", `/api/v1/memos/${memoId}`, {
      ...payload,
      editSessionId: body.editSession.id,
      expectedRevision: body.editSession.baseRevision,
      expectedContentHash: body.editSession.baseContentHash,
    });
  };
  const agentAuth = {
    kind: "agent", actorType: "agent", actorId: "tok_agent", username: "agent", displayName: null,
    scopes: ["read:memos", "write:memos"], workspaceId: "ws_default", role: "owner",
  };
  const callTool = (name, args) => callMcpTool(
    { env: environment, get: (key) => (key === "auth" ? agentAuth : undefined) },
    agentAuth,
    name,
    args,
  );
  const resourcesOf = async (memoId) =>
    (await request("GET", "/api/v1/resources")).body.resources.filter((resource) => resource.memoId === memoId);
  const storedFiles = () => readdirSync(resourcesDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
  return { sqlite, request, send, importArtifact, ensureLibrary, inboxId, saveBody, callTool, resourcesOf, storedFiles };
};

const htmlFile = (html, name = "report.html", type = "text/html") => new File([html], name, { type });

describe("import an HTML artifact", () => {
  test("stores the HTML as a text/html resource and keeps only the envelope and fallback text in the body", async () => {
    const env = installation();
    const html = `<!doctype html><html><head><title>Q3 &amp; Q4 dashboard</title><style>.secret-style{}</style></head>
      <body><h1>Revenue overview</h1><script>const secretScript = 1;</script><p>Visible&nbsp;paragraph</p></body></html>`;

    const created = await env.importArtifact(htmlFile(html, "dashboard.html"));

    expect(created.status).toBe(201);
    const memo = created.body.memo;
    const library = await env.ensureLibrary();
    expect(memo).toMatchObject({ title: "Q3 & Q4 dashboard", notebookId: library.id, artifact: { kind: "html", thumbnailStale: true } });
    expect(memo.contentMarkdown).toContain("<!-- edgeever-artifact-v1:");
    expect(memo.contentMarkdown).not.toContain("<h1>");
    expect(memo.contentMarkdown).not.toContain("secretScript");

    const resources = await env.resourcesOf(memo.id);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ kind: "attachment", mimeType: "text/html", filename: "dashboard.html" });
    const blob = await env.send("GET", `/api/v1/resources/${resources[0].id}/blob`);
    expect(blob.status).toBe(200);
    expect(blob.body).toBe(html);
    expect(blob.headers.get("Content-Disposition")).toStartWith("attachment");

    const listed = (await env.request("GET", `/api/v1/memos?notebookId=${library.id}`)).body.memos;
    expect(listed.map((item) => [item.id, item.artifact?.kind])).toEqual([[memo.id, "html"]]);
  });

  test("uses the file name when the page has no title and imports into a chosen artifact folder", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Project", parentId: library.id })).body.notebook;

    const created = await env.importArtifact(htmlFile("<p>No title here</p>", "architecture-notes.htm"), {
      folderId: folder.id,
      tags: JSON.stringify(["agent", "arch"]),
    });

    expect(created.status).toBe(201);
    expect(created.body.memo).toMatchObject({ title: "architecture-notes", notebookId: folder.id, tags: ["agent", "arch"] });
  });

  test("rejects files that are not non-empty UTF-8 .html/.htm pages and folders outside the library", async () => {
    const env = installation();
    const rejected = async (file, fields) => {
      const response = await env.importArtifact(file, fields);
      return [response.status, response.body.error?.code];
    };

    expect(await rejected(htmlFile("<p>x</p>", "notes.txt", "text/plain"))).toEqual([400, "artifact_invalid_html"]);
    expect(await rejected(htmlFile("   \n", "empty.html"))).toEqual([400, "artifact_invalid_html"]);
    expect(await rejected(htmlFile(new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c]), "latin1.html"))).toEqual([400, "artifact_invalid_html"]);
    expect(await rejected(htmlFile("<p>x</p>"), { folderId: await env.inboxId() })).toEqual([400, "artifact_location_invalid"]);
    expect(await rejected(undefined)).toEqual([400, "bad_request"]);
  });

  test("accepts exactly 20 MB and rejects anything larger with 413", async () => {
    const env = installation();
    const page = (bytes) => {
      const head = "<html><body>";
      const tail = "</body></html>";
      return htmlFile(head + "a".repeat(bytes - head.length - tail.length) + tail, "big.html");
    };

    expect((await env.importArtifact(page(20 * MiB))).status).toBe(201);
    const tooLarge = await env.importArtifact(page(20 * MiB + 1));
    expect(tooLarge).toMatchObject({ status: 413, body: { error: { code: "artifact_too_large" } } });
  });

  test("lists local relative resources the page references, ignoring absolute URLs, data URIs and anchors", async () => {
    const env = installation();
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="./style.css">
      <link rel="icon" href="https://cdn.example.com/favicon.ico">
      <link rel="preconnect" href="//fonts.example.com">
      <style>@import "theme/base.css"; body { background: url('img/bg.png'); } .x { background: url(data:image/png;base64,AAAA) }</style>
      <script src="js/app.js"></script>
      <script>const notAnAsset = "<img src='from-script.png'>";</script>
    </head><body>
      <!-- <img src="commented-out.png"> -->
      <img src="./img.png" srcset="img@2x.png 2x, https://cdn.example.com/img@3x.png 3x">
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <img src="./img.png">
      <div style="background-image: url(&quot;../shared/hero.jpg&quot;)"></div>
      <video poster="media/poster.jpg"><source src="/media/clip.mp4"></video>
      <a href="#section">anchor</a> <a href="other-page.html">link</a>
      <img src="blob:https://example.com/123">
    </body></html>`;

    const created = await env.importArtifact(htmlFile(html, "page.html"));

    expect(created.status).toBe(201);
    const expected = ["./style.css", "theme/base.css", "img/bg.png", "js/app.js", "./img.png", "img@2x.png", "../shared/hero.jpg", "media/poster.jpg", "/media/clip.mp4"];
    expect([...created.body.missingLocalAssets].sort()).toEqual([...expected].sort());
    // The list lives in the envelope, so it survives a reload.
    const detail = (await env.request("GET", `/api/v1/memos/${created.body.memo.id}`)).body.memo;
    const encoded = detail.contentMarkdown.match(/edgeever-artifact-v1:([A-Za-z0-9_-]+)/)[1];
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).missingLocalAssets.sort()).toEqual([...expected].sort());

    const clean = await env.importArtifact(htmlFile(`<img src="https://example.com/a.png"><a href="#top">top</a>`, "clean.html"));
    expect(clean.body.missingLocalAssets).toEqual([]);
  });

  test("keeps at most 50 missing local resources", async () => {
    const env = installation();
    const html = Array.from({ length: 80 }, (_, index) => `<img src="images/${index}.png">`).join("");

    const created = await env.importArtifact(htmlFile(html, "gallery.html"));

    expect(created.status).toBe(201);
    expect(created.body.missingLocalAssets).toHaveLength(50);
    expect(created.body.missingLocalAssets[0]).toBe("images/0.png");
  });

  test("importing the same file twice creates two independent artifacts", async () => {
    const env = installation();
    const file = htmlFile("<title>Same page</title><p>Body</p>", "same.html");

    const first = (await env.importArtifact(file)).body.memo;
    const second = (await env.importArtifact(file)).body.memo;

    expect(second.id).not.toBe(first.id);
    expect([first.title, second.title]).toEqual(["Same page", "Same page"]);
    const [firstHtml] = await env.resourcesOf(first.id);
    const [secondHtml] = await env.resourcesOf(second.id);
    expect(secondHtml.id).not.toBe(firstHtml.id);
    const library = await env.ensureLibrary();
    const listed = (await env.request("GET", `/api/v1/memos?notebookId=${library.id}`)).body.memos.map((memo) => memo.id);
    expect(listed.sort()).toEqual([first.id, second.id].sort());
  });

  test("search finds visible page text, never script or style text, and indexes at most 200 KB", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const filler = "filler ".repeat(40 * 1024);
    const html = `<html><head><style>.zebrastyle{}</style><script>var quokkascript = 1;</script></head>
      <body><p>pangolin visible</p><!-- narwhalcomment --><noscript>wombatnoscript</noscript><p>${filler}</p><p>axolotltail</p></body></html>`;
    const memoId = (await env.importArtifact(htmlFile(html))).body.memo.id;
    const search = async (q) => (await env.request("GET", `/api/v1/memos?notebookId=${library.id}&q=${q}`)).body.memos.map((memo) => memo.id);

    expect(await search("pangolin")).toEqual([memoId]);
    for (const hidden of ["quokkascript", "zebrastyle", "narwhalcomment", "wombatnoscript"]) expect(await search(hidden)).toEqual([]);
    // The text after the first 200 KB is cut from the index, not from the page.
    expect(await search("axolotltail")).toEqual([]);
    const detail = (await env.request("GET", `/api/v1/memos/${memoId}`)).body.memo;
    expect(new TextEncoder().encode(detail.contentText).byteLength).toBeLessThanOrEqual(200 * 1024);
    expect(detail.contentText.startsWith("pangolin visible filler")).toBe(true);
  });
});

describe("artifact content and location rules", () => {
  test("ordinary saves and MCP update_memo cannot change the body; title, tags, pin and moves in the library still save", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Folder", parentId: library.id })).body.notebook;
    const memo = (await env.importArtifact(htmlFile("<title>Page</title><p>Body</p>"))).body.memo;

    // Even resending the stored body unchanged counts as a body update.
    for (const payload of [{ contentMarkdown: "plain text from an old client" }, { contentMarkdown: memo.contentMarkdown }, { contentJson: memo.contentJson }]) {
      expect(await env.saveBody(memo.id, payload)).toMatchObject({ status: 409, body: { error: { code: "artifact_update_required" } } });
    }
    await expect(env.callTool("update_memo", { memoId: memo.id, contentMarkdown: "agent text" }))
      .rejects.toMatchObject({ code: "artifact_update_required", status: 409 });

    const renamed = await env.request("PATCH", `/api/v1/memos/${memo.id}`, { title: "Renamed page", tags: ["kept"], isPinned: true, notebookId: folder.id });
    expect(renamed.status).toBe(200);
    expect(renamed.body.memo).toMatchObject({ title: "Renamed page", tags: ["kept"], isPinned: true, notebookId: folder.id, contentMarkdown: memo.contentMarkdown });
    expect((await env.request("POST", "/api/v1/memos/batch/move", { memoIds: [memo.id], notebookId: library.id })).status).toBe(200);
    expect((await env.request("GET", `/api/v1/memos/${memo.id}`)).body.memo.contentText).toBe("Page Body");
  });

  test("notes cannot enter the Artifact Library and artifacts cannot leave it", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const inboxId = await env.inboxId();
    const artifact = (await env.importArtifact(htmlFile("<p>page</p>"))).body.memo;
    const note = (await env.request("POST", "/api/v1/memos", { notebookId: inboxId, title: "Note", contentMarkdown: "hello" })).body.memo;
    const invalid = { status: 400, body: { error: { code: "artifact_location_invalid" } } };

    expect(await env.request("POST", "/api/v1/memos", { notebookId: library.id, title: "Note", contentMarkdown: "x" })).toMatchObject(invalid);
    expect(await env.request("PATCH", `/api/v1/memos/${note.id}`, { notebookId: library.id })).toMatchObject(invalid);
    expect(await env.request("POST", "/api/v1/memos/batch/move", { memoIds: [note.id], notebookId: library.id })).toMatchObject(invalid);
    expect(await env.request("PATCH", `/api/v1/memos/${artifact.id}`, { notebookId: inboxId })).toMatchObject(invalid);
    expect(await env.request("POST", "/api/v1/memos/batch/move", { memoIds: [artifact.id], notebookId: inboxId })).toMatchObject(invalid);

    expect((await env.request("GET", `/api/v1/memos/${note.id}`)).body.memo.notebookId).toBe(inboxId);
    expect((await env.request("GET", `/api/v1/memos/${artifact.id}`)).body.memo.notebookId).toBe(library.id);
  });
});

describe("artifacts are never shared publicly", () => {
  const unsupported = { status: 400, body: { error: { code: "artifact_share_unsupported" } } };

  test("an artifact, the Artifact Library and its folders cannot be shared", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Reports", parentId: library.id })).body.notebook;
    const artifact = (await env.importArtifact(htmlFile("<p>page</p>"))).body.memo;

    expect(await env.request("POST", `/api/v1/memos/${artifact.id}/share`)).toMatchObject(unsupported);
    expect(await env.request("POST", `/api/v1/notebooks/${library.id}/share`)).toMatchObject(unsupported);
    expect(await env.request("POST", `/api/v1/notebooks/${folder.id}/share`)).toMatchObject(unsupported);
    expect((await env.request("GET", "/api/v1/memo-shares")).body.shares).toEqual([]);
    expect((await env.request("GET", "/api/v1/notebook-shares")).body.shares).toEqual([]);
  });

  test("notebook shares and public sites never list, search or tag-filter artifacts", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const inboxId = await env.inboxId();
    await env.request("POST", "/api/v1/memos", { notebookId: inboxId, title: "Shared note", contentMarkdown: "quarterly revenue", tags: ["report"] });
    const artifact = (await env.importArtifact(htmlFile("<title>Quarterly revenue</title><p>quarterly revenue</p>"), { tags: JSON.stringify(["report"]) })).body.memo;
    // Neither the API nor sync lets these states arise, so plant them directly:
    // an artifact outside the library and a share rooted at the library.
    env.sqlite.prepare("UPDATE memos SET notebook_id = ? WHERE id = ?").run(inboxId, artifact.id);
    const share = (await env.request("POST", `/api/v1/notebooks/${inboxId}/share`)).body.share;
    env.sqlite.prepare("INSERT INTO notebook_shares (id, notebook_id, workspace_id, token, created_by, created_at, updated_at) SELECT 'nbshare_lib', id, workspace_id, ?, 'test', 'now', 'now' FROM notebooks WHERE id = ?")
      .run("L".repeat(43), library.id);
    const pub = (path, token = share.token) => env.request("GET", `/api/public/notebook-shares/${token}${path}`);
    const titles = (memos) => memos.map((memo) => memo.title).filter((title) => title !== "欢迎来到 EdgeEver");

    expect(titles((await pub("")).body.share.memos)).toEqual(["Shared note"]);
    expect(titles((await pub("/search?q=quarterly")).body.memos)).toEqual(["Shared note"]);
    expect(titles((await pub("/search?tag=report")).body.memos)).toEqual(["Shared note"]);
    expect((await pub(`/memos/${artifact.id}`)).status).toBe(404);
    expect((await pub(`/memos/${artifact.id}/preview`)).status).toBe(404);
    expect(titles((await env.request("GET", `/api/v1/notebooks/${inboxId}/share/memos`)).body.memos)).toEqual(["Shared note"]);
    expect(titles((await env.request("GET", `/api/v1/notebooks/${inboxId}/share/memos?q=quarterly`)).body.memos)).toEqual(["Shared note"]);
    expect((await env.request("GET", `/api/v1/memos/${artifact.id}/notebook-sites`)).body).toMatchObject({ sites: [] });
    expect((await pub("", "L".repeat(43))).status).toBe(404);
  });
});

describe("artifact list visibility", () => {
  test("workspace-wide lists and activity leave artifacts out; query, tag, trash and library lists include them", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Folder", parentId: library.id })).body.notebook;
    const artifact = (await env.importArtifact(htmlFile("<title>Pangolin page</title><p>pangolin</p>"), {
      folderId: folder.id,
      tags: JSON.stringify(["shared"]),
    })).body.memo;
    const note = (await env.request("POST", "/api/v1/memos", { notebookId: await env.inboxId(), title: "Pangolin note", contentMarkdown: "pangolin", tags: ["shared"] })).body.memo;
    const ids = async (path) => (await env.request("GET", path)).body.memos.map((memo) => memo.id).sort();

    const workspace = await ids("/api/v1/memos");
    expect(workspace).toContain(note.id);
    expect(workspace).not.toContain(artifact.id);
    expect((await env.request("GET", "/api/v1/memos")).body.totalCount).toBe(workspace.length);
    const activity = await ids("/api/v1/memos/activity");
    expect(activity).toContain(note.id);
    expect(activity).not.toContain(artifact.id);
    expect(await ids("/api/v1/memos?q=pangolin")).toEqual([artifact.id, note.id].sort());
    expect(await ids("/api/v1/memos?tag=shared")).toEqual([artifact.id, note.id].sort());
    expect(await ids(`/api/v1/memos?notebookId=${folder.id}`)).toEqual([artifact.id]);
    expect(await ids(`/api/v1/memos?notebookId=${library.id}&includeDescendants=1`)).toEqual([artifact.id]);
    expect(await ids(`/api/v1/memos/activity?notebookId=${folder.id}`)).toEqual([artifact.id]);

    expect((await env.request("DELETE", `/api/v1/memos/${artifact.id}`)).status).toBe(200);
    expect(await ids("/api/v1/memos?trash=1")).toEqual([artifact.id]);
  });
});

describe("artifacts in the trash", () => {
  test("trashed artifacts are listed in the trash and restore into their folder", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Folder", parentId: library.id })).body.notebook;
    const memo = (await env.importArtifact(htmlFile("<title>Kept</title>"), { folderId: folder.id })).body.memo;

    expect((await env.request("DELETE", `/api/v1/memos/${memo.id}`)).status).toBe(200);
    const trash = (await env.request("GET", "/api/v1/memos?trash=1")).body.memos;
    expect(trash.map((item) => [item.id, item.artifact?.kind])).toEqual([[memo.id, "html"]]);

    const restored = await env.request("POST", `/api/v1/memos/${memo.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.memo).toMatchObject({ notebookId: folder.id, isDeleted: false });
  });

  test("an artifact whose folder is gone restores to the library root; a note still restores to the inbox", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const inboxId = await env.inboxId();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Folder", parentId: library.id })).body.notebook;
    const notebook = (await env.request("POST", "/api/v1/notebooks", { name: "Notes" })).body.notebook;
    const artifact = (await env.importArtifact(htmlFile("<title>Orphan</title>"), { folderId: folder.id })).body.memo;
    const note = (await env.request("POST", "/api/v1/memos", { notebookId: notebook.id, title: "Note", contentMarkdown: "hi" })).body.memo;
    for (const id of [artifact.id, note.id]) await env.request("DELETE", `/api/v1/memos/${id}`);
    for (const id of [folder.id, notebook.id]) expect((await env.request("DELETE", `/api/v1/notebooks/${id}`)).status).toBe(200);

    expect((await env.request("POST", `/api/v1/memos/${artifact.id}/restore`)).body.memo.notebookId).toBe(library.id);
    expect((await env.request("POST", `/api/v1/memos/${note.id}/restore`)).body.memo.notebookId).toBe(inboxId);
  });

  test("batch restore recreates a missing library for artifacts", async () => {
    const env = installation();
    const artifact = (await env.importArtifact(htmlFile("<title>Lonely</title>"))).body.memo;
    await env.request("DELETE", `/api/v1/memos/${artifact.id}`);
    // The library itself can never be deleted through the API; simulate lost data.
    env.sqlite.query("UPDATE notebooks SET is_deleted = 1 WHERE system_kind = 'artifact_library'").run();

    await expect(env.callTool("restore_memos", { memoIds: [artifact.id] })).resolves.toMatchObject({ restored: 1 });
    const library = await env.ensureLibrary();
    expect(library.id).not.toBe(artifact.notebookId);
    expect((await env.request("GET", `/api/v1/memos/${artifact.id}`)).body.memo.notebookId).toBe(library.id);
  });

  test("purging an artifact removes every HTML version and thumbnail object; so does emptying the trash", async () => {
    for (const purge of ["single", "empty"]) {
      const env = installation();
      const memo = (await env.importArtifact(htmlFile("<p>v1</p>"))).body.memo;
      for (const file of [htmlFile("<p>v2</p>", "v2.html"), new File([new Uint8Array([1, 2, 3])], "thumb.webp", { type: "image/webp" })]) {
        const form = new FormData();
        form.append("file", file);
        expect((await env.send("POST", `/api/v1/memos/${memo.id}/resources`, { body: form })).status).toBe(201);
      }
      expect(await env.resourcesOf(memo.id)).toHaveLength(3);
      expect(env.storedFiles().length).toBe(3);

      await env.request("DELETE", `/api/v1/memos/${memo.id}`);
      const response = purge === "single"
        ? await env.request("DELETE", `/api/v1/memos/${memo.id}?permanent=1`)
        : await env.request("DELETE", "/api/v1/memos/trash/empty");
      expect(response.status).toBe(200);
      expect(env.sqlite.query("SELECT COUNT(*) AS count FROM resources WHERE memo_id = ?").get(memo.id).count).toBe(0);
      expect(env.storedFiles()).toEqual([]);
    }
  });

  test("a folder with an artifact anywhere in its subtree cannot be deleted", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const folder = (await env.request("POST", "/api/v1/notebooks", { name: "Folder", parentId: library.id })).body.notebook;
    const child = (await env.request("POST", "/api/v1/notebooks", { name: "Child", parentId: folder.id })).body.notebook;
    await env.importArtifact(htmlFile("<p>x</p>"), { folderId: child.id });

    expect(await env.request("DELETE", `/api/v1/notebooks/${folder.id}`))
      .toMatchObject({ status: 409, body: { error: { code: "notebook_not_empty" } } });
  });
});

describe("replace artifact content and restore revisions", () => {
  const replace = (env, memoId, file, fields = {}) => {
    const form = new FormData();
    if (file) form.append("file", file);
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    return env.send("PUT", `/api/v1/artifacts/${memoId}/content`, { body: form });
  };
  const htmlResourceIdOf = (memo) => {
    const encoded = /<!--\s*edgeever-artifact-v1:([A-Za-z0-9_-]+)\s*-->/.exec(memo.contentMarkdown)[1];
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")).htmlResourceId;
  };

  test("replacing stores a new HTML resource, keeps the old one readable and snapshots the previous version", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const search = async (q) => (await env.request("GET", `/api/v1/memos?notebookId=${library.id}&q=${q}`)).body.memos.map((memo) => memo.id);
    const firstHtml = "<title>Report</title><p>okapi first edition</p>";
    const original = (await env.importArtifact(htmlFile(firstHtml, "report.html"))).body.memo;
    const secondHtml = "<title>Ignored new title</title><p>gecko second edition</p>";

    const replaced = await replace(env, original.id, htmlFile(secondHtml, "report-v2.html"), { expectedRevision: original.revision });

    expect(replaced.status).toBe(200);
    const memo = replaced.body.memo;
    expect(memo).toMatchObject({ id: original.id, title: "Report", revision: original.revision + 1, contentText: "Ignored new title gecko second edition", artifact: { kind: "html", thumbnailStale: true } });
    expect(htmlResourceIdOf(memo)).not.toBe(htmlResourceIdOf(original));
    expect((await env.send("GET", `/api/v1/resources/${htmlResourceIdOf(memo)}/blob`)).body).toBe(secondHtml);
    expect((await env.send("GET", `/api/v1/resources/${htmlResourceIdOf(original)}/blob`)).body).toBe(firstHtml);
    expect(await search("gecko")).toEqual([original.id]);
    expect(await search("okapi")).toEqual([]);

    const revisions = (await env.request("GET", `/api/v1/memos/${original.id}/revisions`)).body.revisions;
    expect(revisions.map((revision) => [revision.revision, htmlResourceIdOf(revision), revision.contentText]))
      .toEqual([[original.revision, htmlResourceIdOf(original), "Report okapi first edition"]]);
  });

  test("restoring an earlier revision points the artifact back at its HTML and its search text", async () => {
    const env = installation();
    const library = await env.ensureLibrary();
    const search = async (q) => (await env.request("GET", `/api/v1/memos?notebookId=${library.id}&q=${q}`)).body.memos.map((memo) => memo.id);
    const firstHtml = "<p>okapi first edition</p>";
    const original = (await env.importArtifact(htmlFile(firstHtml, "report.html"))).body.memo;
    const replaced = (await replace(env, original.id, htmlFile("<p>gecko second edition</p>", "report.html"))).body.memo;
    const [revision] = (await env.request("GET", `/api/v1/memos/${original.id}/revisions`)).body.revisions;

    const restored = await env.request("POST", `/api/v1/memos/${original.id}/revisions/${revision.id}/restore`);

    expect(restored.status).toBe(200);
    expect(restored.body.memo).toMatchObject({ revision: replaced.revision + 1, contentText: "okapi first edition", artifact: { kind: "html" } });
    expect(htmlResourceIdOf(restored.body.memo)).toBe(htmlResourceIdOf(original));
    expect((await env.send("GET", `/api/v1/resources/${htmlResourceIdOf(restored.body.memo)}/blob`)).body).toBe(firstHtml);
    expect(await search("okapi")).toEqual([original.id]);
    expect(await search("gecko")).toEqual([]);
    // The replaced version is kept in history, so it can be restored in turn.
    const latest = (await env.request("GET", `/api/v1/memos/${original.id}/revisions`)).body.revisions[0];
    expect(htmlResourceIdOf(latest)).toBe(htmlResourceIdOf(replaced));
  });

  test("replacing checks the revision, size, encoding and target like creating does", async () => {
    const env = installation();
    const original = (await env.importArtifact(htmlFile("<p>page</p>"))).body.memo;
    const inboxId = await env.inboxId();
    const note = (await env.request("POST", "/api/v1/memos", { notebookId: inboxId, title: "Note", contentMarkdown: "hello" })).body.memo;
    const rejected = async (memoId, file, fields) => {
      const response = await replace(env, memoId, file, fields);
      return [response.status, response.body.error?.code];
    };
    const page = (bytes) => htmlFile("<p>" + "a".repeat(bytes - 7) + "</p>", "big.html");

    expect(await rejected(original.id, htmlFile("<p>new</p>"), { expectedRevision: original.revision + 1 })).toEqual([409, "revision_conflict"]);
    expect(await rejected(original.id, page(20 * MiB + 1))).toEqual([413, "artifact_too_large"]);
    expect(await rejected(original.id, htmlFile(new Uint8Array([0x3c, 0x70, 0x3e, 0xff]), "latin1.html"))).toEqual([400, "artifact_invalid_html"]);
    expect(await rejected(original.id, htmlFile("<p>x</p>", "notes.txt", "text/plain"))).toEqual([400, "artifact_invalid_html"]);
    expect(await rejected(original.id, undefined)).toEqual([400, "bad_request"]);
    expect(await rejected(note.id, htmlFile("<p>x</p>"))).toEqual([400, "bad_request"]);
    expect(await rejected("memo_missing", htmlFile("<p>x</p>"))).toEqual([404, "not_found"]);

    const unchanged = (await env.request("GET", `/api/v1/memos/${original.id}`)).body.memo;
    expect(unchanged).toMatchObject({ revision: original.revision, contentMarkdown: original.contentMarkdown });
    expect(await env.resourcesOf(original.id)).toHaveLength(1);
    expect((await replace(env, original.id, page(20 * MiB))).status).toBe(200);
  });
});
