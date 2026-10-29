import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// A 1×1 PNG used as the artifact's thumbnail.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const OPEN_MEMO_FAILED = "无法打开这条笔记。它可能已不可用或在回收站中。请检查连接后重试。";

type StoredMemo = { id: string; contentMarkdown: string; contentJson: unknown };

const readMemo = async (request: APIRequestContext, memoId: string) => {
  const response = await request.get(`/api/v1/memos/${memoId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).memo as StoredMemo;
};

const openNote = async (page: Page, notebookName: string, memoId: string) => {
  await page.goto("/");
  await page.getByRole("button", { name: notebookName }).first().click();
  await page.locator(`[data-memo-id="${memoId}"]`).locator("button").first().click();
  const editor = page.locator(".ProseMirror[contenteditable='true']");
  await expect(editor).toBeVisible();
  return editor;
};

const expectArtifactOpen = async (page: Page, title: string) => {
  await expect(page.locator("[data-html-artifact-reader]").getByLabel("制品标题")).toHaveValue(title);
  await expect(page.locator("[data-artifact-library-section] [aria-current='page']")).toBeVisible();
};

test("a note links to an artifact with @ and an artifact card; both open the artifact and degrade to plain links", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  const title = `引用制品 ${stamp}`;
  const notebookName = `制品引用 ${stamp}`;

  expect((await request.post("/api/v1/artifact-library", { data: {} })).ok()).toBe(true);
  const artifactResponse = await request.post("/api/v1/artifacts", {
    multipart: {
      file: { name: `reference-${stamp}.html`, mimeType: "text/html", buffer: Buffer.from(`<title>${title}</title><h1>${title}</h1>`) },
      thumbnail: { name: "thumbnail.png", mimeType: "image/png", buffer: PNG_1X1 },
    },
  });
  expect(artifactResponse.status()).toBe(201);
  const artifactId = (await artifactResponse.json()).memo.id as string;
  const artifactHref = `#memo=${encodeURIComponent(artifactId)}`;
  const notebookResponse = await request.post("/api/v1/notebooks", { data: { name: notebookName } });
  const notebookId = (await notebookResponse.json()).notebook.id as string;
  const noteResponse = await request.post("/api/v1/memos", { data: { notebookId, title: `引用笔记 ${stamp}`, contentMarkdown: "正文" } });
  const noteId = (await noteResponse.json()).memo.id as string;

  // Insert an artifact card from the slash menu; the picker lists artifacts only.
  const editor = await openNote(page, notebookName, noteId);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/card");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "插入制品卡片" });
  await picker.getByPlaceholder("搜索要插入的制品").fill(title);
  const pickerResult = picker.getByRole("option").filter({ hasText: title });
  await expect(pickerResult.locator("[data-artifact-result-icon]")).toBeVisible();
  await pickerResult.click();

  const card = editor.locator(`p[data-artifact-card="${artifactId}"]`);
  await expect(card).toContainText(title);
  await expect(card.locator("img[data-artifact-thumbnail]")).toBeVisible();

  // `@` offers the artifact with its own icon and inserts an ordinary note link.
  await page.keyboard.type(`@${title}`);
  const suggestion = page.getByRole("option").filter({ hasText: title });
  await expect(suggestion.locator("[data-artifact-result-icon]")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator(`a[href="${artifactHref}"]`)).toHaveCount(2);

  // Stored Markdown holds two plain links and nothing an older client would not know.
  await expect.poll(async () => (await readMemo(request, noteId)).contentMarkdown.split(`](${artifactHref})`).length - 1, { timeout: 15_000 }).toBe(2);
  const saved = await readMemo(request, noteId);
  expect(saved.contentMarkdown).toContain(`\n\n[${title}](${artifactHref})\n\n`);
  expect(saved.contentMarkdown).not.toContain("artifact-card");
  const nodeTypes = new Set<string>();
  const visit = (node: { type?: string; content?: unknown[] }) => {
    if (node.type) nodeTypes.add(node.type);
    (node.content ?? []).forEach((child) => visit(child as typeof node));
  };
  visit(saved.contentJson as { content?: unknown[] });
  expect([...nodeTypes].sort()).toEqual(["doc", "paragraph", "text"]);

  // Clicking the card opens the artifact in the Agent Artifacts view.
  await card.locator("[data-artifact-card-state='ready']").click();
  await expectArtifactOpen(page, title);

  // So does the @ link.
  const reopened = await openNote(page, notebookName, noteId);
  await reopened.locator(`p:not([data-artifact-card]) a[href="${artifactHref}"]`).click();
  await expectArtifactOpen(page, title);

  // Once the artifact is in the trash the card is unavailable and clicking it reports nothing.
  expect((await request.delete(`/api/v1/memos/${artifactId}`)).ok()).toBe(true);
  const afterDelete = await openNote(page, notebookName, noteId);
  const unavailableCard = afterDelete.locator(`p[data-artifact-card="${artifactId}"]`);
  await expect(unavailableCard.locator("[data-artifact-card-state='unavailable']")).toHaveText("制品不可用");
  await unavailableCard.locator("a").click();
  await page.waitForTimeout(500);
  await expect(page.getByText(OPEN_MEMO_FAILED)).toHaveCount(0);
  await expect(page.locator("[data-html-artifact-reader]")).toHaveCount(0);
  expect((await request.post(`/api/v1/memos/${artifactId}/restore`)).ok()).toBe(true);

  // A client without card support saves the note from its Markdown; the link survives and still opens.
  const session = (await (await request.post(`/api/v1/memos/${noteId}/edit-sessions`)).json()).editSession;
  const legacySave = await request.patch(`/api/v1/memos/${noteId}`, {
    data: {
      contentMarkdown: `${(await readMemo(request, noteId)).contentMarkdown}\n\n旧客户端补充 ${stamp}`,
      editSessionId: session.id,
      expectedRevision: session.baseRevision,
      expectedContentHash: session.baseContentHash,
    },
  });
  expect(legacySave.ok()).toBe(true);
  const afterLegacy = await openNote(page, notebookName, noteId);
  await expect(afterLegacy).toContainText(`旧客户端补充 ${stamp}`);
  await expect(afterLegacy.locator("[data-artifact-card]")).toHaveCount(0);
  await expect(afterLegacy.locator(`a[href="${artifactHref}"]`)).toHaveCount(2);
  await afterLegacy.locator(`a[href="${artifactHref}"]`).first().click();
  await expectArtifactOpen(page, title);
});
