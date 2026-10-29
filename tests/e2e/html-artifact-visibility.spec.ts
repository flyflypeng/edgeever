import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

test("artifacts stay out of All Notes but are found by global search, the quick switcher and tags", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);
  const stamp = Date.now();
  const title = `可见性制品 ${stamp}`;
  const word = `pangolin${stamp}`;
  const tag = `制品标签${stamp}`;
  await importArtifact(page, `visibility-${stamp}.html`, `<title>${title}</title><p>${word} visible</p><script>var hidden${stamp} = 1;</script>`);

  // Tag it from the reader toolbar.
  const reader = page.locator("[data-html-artifact-reader]");
  await expect(reader.getByLabel("制品标题")).toHaveValue(title);
  const addTag = async (name: string) => {
    await reader.getByRole("button", { name: "选择笔记标签" }).click();
    await page.getByPlaceholder("搜索或输入新标签").fill(name);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
  };
  await addTag(tag);
  await addTag(`${tag}-tmp`);
  await expect(reader.getByText(`#${tag}-tmp`).first()).toBeVisible();
  await reader.getByRole("button", { name: "选择笔记标签" }).click();
  await page.getByRole("button", { name: new RegExp(`${tag}-tmp`) }).first().click();
  await page.keyboard.press("Escape");
  await expect(reader.getByText(`#${tag}-tmp`)).toHaveCount(0);
  await expect(reader.getByText(`#${tag}`).first()).toBeVisible();

  // All Notes does not list it; a global search by visible text does, with the artifact mark.
  await page.getByRole("button", { name: "全部笔记", exact: true }).click();
  const card = page.locator("[data-memo-id]").filter({ hasText: title });
  await expect(page.locator("[data-memo-id]").first()).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByPlaceholder("搜索笔记").fill(`hidden${stamp}`);
  await expect(card).toHaveCount(0);
  await page.getByPlaceholder("搜索笔记").fill(word);
  await expect(card).toBeVisible();
  await card.click();
  await expect(reader).toBeVisible();
  await expect(page.locator("[data-artifact-library-section] [aria-current='page']")).toBeVisible();

  // The quick switcher marks artifacts and opens them in the Agent Artifacts view.
  await page.getByRole("button", { name: "全部笔记", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+o");
  await page.getByPlaceholder("搜索笔记标题或内容…").fill(word);
  const result = page.getByRole("option").filter({ hasText: title });
  await expect(result.locator("[data-artifact-result-icon]")).toBeVisible();
  await result.click();
  await expect(reader.getByLabel("制品标题")).toHaveValue(title);
  await expect(page.locator("[data-artifact-library-section] [aria-current='page']")).toBeVisible();

  // The tag view lists the artifact.
  await page.getByRole("button", { name: "标签", exact: true }).first().click();
  await page.getByRole("button", { name: new RegExp(`#${tag}`) }).first().click();
  await expect(page.locator("[data-memo-id]").filter({ hasText: title })).toBeVisible();
});
