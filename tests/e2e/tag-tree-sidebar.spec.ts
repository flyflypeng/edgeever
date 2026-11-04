import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";

const inboxId = async (request: APIRequestContext) => {
  const response = await request.get("/api/v1/notebooks");
  expect(response.ok(), await response.text()).toBe(true);
  const notebooks = (await response.json() as { notebooks: Array<{ id: string; slug: string }> }).notebooks;
  const inbox = notebooks.find((notebook) => notebook.slug === "inbox") ?? notebooks[0];
  expect(inbox).toBeTruthy();
  return inbox!.id;
};

/**
 * Creates notes carrying hierarchical tags and removes them afterwards. Every
 * rename queues one exact operation per stored tag, so each test gets a budget
 * well above the default.
 */
const withTagFixtures = async (
  page: Page,
  run: (fixtures: {
    suffix: string;
    root: string;
    createMemo: (title: string, tags: string[]) => Promise<{ id: string; tags: string[] }>;
    request: APIRequestContext;
    memoTags: (memoId: string) => Promise<string[]>;
  }) => Promise<void>,
) => {
  test.setTimeout(120_000);
  const request = page.request;
  const notebookId = await inboxId(request);
  const suffix = Date.now();
  const created: string[] = [];

  const createMemo = async (title: string, tags: string[]) => {
    const response = await request.post("/api/v1/memos", {
      data: { notebookId, title, contentMarkdown: `# ${title}`, tags },
    });
    expect(response.status(), await response.text()).toBe(201);
    const memo = (await response.json() as { memo: { id: string; tags: string[] } }).memo;
    created.push(memo.id);
    return memo;
  };
  const memoTags = async (memoId: string) => {
    const response = await request.get(`/api/v1/memos/${memoId}`);
    return (await response.json() as { memo: { tags: string[] } }).memo.tags;
  };

  try {
    await run({ suffix, root: `e2e${suffix}`, createMemo, request, memoTags });
  } finally {
    for (const memoId of created) {
      await request.delete(`/api/v1/memos/${memoId}`);
      await request.delete(`/api/v1/memos/${memoId}?permanent=1`);
    }
  }
};

test("browses the tag tree and filters notes by a parent tag", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(E2E_WEB_URL);

  await withTagFixtures(page, async ({ root, createMemo }) => {
    const parent = await createMemo(`parent`, [`${root}/kernel`]);
    const child = await createMemo(`child`, [`${root.toUpperCase()}/Kernel/Deep`]);
    const unrelated = await createMemo(`unrelated`, [`other${root}`]);

    await page.reload();
    const tree = page.locator("[data-tag-tree-section]");
    await expect(tree).toBeVisible();

    // Case variants of the same path form one node, and the parent exists even
    // though no note carries it directly.
    const rootNode = tree.locator(`[data-tag-tree-node="${root}"]`);
    await expect(rootNode).toBeVisible();
    await expect(rootNode).toContainText("2");
    await expect(tree.locator(`[data-tag-tree-node="${root}/kernel"]`)).toHaveCount(0);

    // Selecting the parent lists notes from its descendants too.
    await rootNode.locator("[data-tag-tree-button]").click();
    await expect(page.locator(`[data-memo-id="${parent.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-memo-id="${child.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-memo-id="${unrelated.id}"]`)).toHaveCount(0);
    // The list header offers a reset only while a tag filter is active.
    await expect(page.getByRole("button", { name: "重置" })).toBeVisible();

    // A card chip switches the filter without opening the note it sits on. Open
    // the child, then use the parent chip: both notes stay in the filtered list,
    // so an accidental open would visibly swap the editor to the parent.
    await page.locator(`[data-memo-id="${child.id}"] button`).first().click();
    await expect(page.getByRole("textbox", { name: "无标题笔记" })).toHaveValue("child");
    await page.locator(`[data-memo-id="${parent.id}"]`)
      .getByRole("button", { name: `按标签 ${root}/kernel 筛选` })
      .click();
    await expect(tree.locator(`[data-tag-tree-node="${root}/kernel"] [aria-current='page']`)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "无标题笔记" })).toHaveValue("child");

    // The chip also reveals the node it belongs to, however deep.
    await page.locator(`[data-memo-id="${child.id}"]`)
      .getByRole("button", { name: `按标签 ${root.toUpperCase()}/Kernel/Deep 筛选` })
      .click();
    const deepNode = tree.locator(`[data-tag-tree-node="${root}/kernel/deep"]`);
    await expect(deepNode).toBeVisible();
    await expect(deepNode.locator("[aria-current='page']")).toBeVisible();
  });
});

test("renames a tag subtree, confirms a merge, and removes the tags", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(E2E_WEB_URL);

  await withTagFixtures(page, async ({ root, createMemo, memoTags }) => {
    const parent = await createMemo(`parent`, [`${root}/kernel`]);
    const child = await createMemo(`child`, [`${root}/kernel/deep`]);
    await createMemo(`unrelated`, [`other${root}`]);

    await page.reload();
    const tree = page.locator("[data-tag-tree-section]");
    const rootNode = tree.locator(`[data-tag-tree-node="${root}"]`);
    await expect(rootNode).toBeVisible();

    // Renaming the root moves the whole subtree under a new path.
    await rootNode.click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByLabel("标签路径").fill(`archive${root}`);
    await renameDialog.getByRole("button", { name: "重命名" }).click();
    await expect(tree.locator(`[data-tag-tree-node="archive${root}"]`)).toBeVisible();
    await expect.poll(() => memoTags(parent.id)).toContain(`archive${root}/kernel`);
    await expect.poll(() => memoTags(child.id)).toContain(`archive${root}/kernel/deep`);

    // Renaming onto an existing path asks before merging.
    await tree.locator(`[data-tag-tree-node="archive${root}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名" }).click();
    const mergeRenameDialog = page.getByRole("dialog").filter({ hasText: "重命名标签" });
    await mergeRenameDialog.getByLabel("标签路径").fill(`other${root}`);
    await mergeRenameDialog.getByRole("button", { name: "重命名" }).click();
    const confirmDialog = page.getByRole("dialog").filter({ hasText: "与已有标签合并" });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(`other${root}`);
    await confirmDialog.getByRole("button", { name: "合并" }).click();
    await expect(tree.locator(`[data-tag-tree-node="other${root}"]`)).toContainText("3");
    await expect(tree.locator(`[data-tag-tree-node="archive${root}"]`)).toHaveCount(0);

    // Removing the node drops it and every tag below it, keeping the notes.
    await tree.locator(`[data-tag-tree-node="other${root}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移除标签" }).click();
    const removeDialog = page.getByRole("dialog");
    await expect(removeDialog).toContainText("笔记内容不会被删除");
    await removeDialog.getByRole("button", { name: "移除标签" }).click();
    await expect(tree.locator(`[data-tag-tree-node="other${root}"]`)).toHaveCount(0);
    await expect.poll(() => memoTags(parent.id)).toEqual([]);
    await expect.poll(() => memoTags(child.id)).toEqual([]);
  });
});

test("keeps the tag tree out of the collapsed rail and reveals it from the toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(E2E_WEB_URL);

  const tree = page.locator("[data-tag-tree-section]");
  await expect(tree).toBeVisible();

  // Collapsing the whole section hides the nodes and survives a reload.
  await tree.locator("> div > button").click();
  await expect(page.locator("[data-tag-tree-node]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-tag-tree-node]")).toHaveCount(0);

  // The toolbar entry point brings the section back instead of opening a pane.
  await page.getByRole("button", { name: "标签", exact: true }).first().click();
  await expect(tree).toBeVisible();

  await page.getByRole("button", { name: /收起笔记本栏/ }).first().click();
  const rail = page.locator("[data-notebook-sidebar-rail]");
  await expect(rail).toBeVisible();
  await expect(tree).toBeHidden();
  await rail.getByRole("button", { name: "标签", exact: true }).click();
  await expect(tree).toBeVisible();
});
