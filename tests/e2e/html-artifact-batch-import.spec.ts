import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
const MiB = 1024 * 1024;

const htmlFile = (name: string, html: string) => ({ name, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });

const openArtifactFolder = async (page: Page, folderName: string) => {
  const section = page.locator("[data-artifact-library-section]");
  await section.locator("button").first().click();
  await expect(section.locator("[aria-current='page']")).toBeVisible();
  await section.hover();
  await section.getByRole("button", { name: "新建制品文件夹" }).click();
  await page.getByRole("dialog").getByLabel("名称").fill(folderName);
  await page.getByRole("dialog").getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const folderRow = section.locator("[data-artifact-folder-tree] [data-notebook-id]").filter({ hasText: folderName });
  await folderRow.getByText(folderName).click();
  await expect(section.locator("[aria-current='page']")).toContainText(folderName);
};

test("imports several HTML files from the picker and by drop, reporting each file's problems", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);
  const stamp = Date.now();
  await openArtifactFolder(page, `E2E 批量导入 ${stamp}`);

  // In the library the primary button imports HTML; the menu still lists every type.
  const primary = page.getByRole("button", { name: "导入 HTML", exact: true });
  await expect(primary).toBeVisible();
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  await expect(page.getByRole("menuitem", { name: "普通笔记" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "导入 HTML 制品" })).toBeVisible();
  await page.keyboard.press("Escape");

  // One picker selection: a page with local assets, the same page again, and one over 20 MB.
  const withAssets = `<title>带资源 ${stamp}</title><link rel="stylesheet" href="./style.css"><img src="./img.png"><img src="https://example.com/a.png"><a href="#top">top</a>`;
  const chooser = page.waitForEvent("filechooser");
  await primary.click();
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(true);
  await expect(page.locator("[data-html-artifact-input]")).toHaveAttribute("accept", ".html,.htm,text/html");
  await fileChooser.setFiles([
    htmlFile("with-assets.html", withAssets),
    htmlFile("too-large.html", `<title>超限 ${stamp}</title>${"a".repeat(20 * MiB)}`),
    htmlFile("with-assets-copy.htm", withAssets),
  ]);

  const notice = page.getByRole("dialog");
  await expect(notice.getByText("部分 HTML 文件没能导入")).toBeVisible();
  const details = notice.locator("[data-notice-details] li");
  await expect(details).toHaveText([
    "with-assets.html：缺少本地资源 ./style.css, ./img.png",
    "too-large.html：HTML 文件不能超过 20MB。",
    "with-assets-copy.htm：缺少本地资源 ./style.css, ./img.png",
  ]);
  await notice.getByRole("button", { name: "知道了" }).click();

  // Both copies of the same file land in the open folder as separate artifacts; the large one does not.
  const cards = page.locator("[data-memo-id]");
  await expect(cards.filter({ hasText: `带资源 ${stamp}` })).toHaveCount(2);
  await expect(cards.filter({ hasText: `超限 ${stamp}` })).toHaveCount(0);

  // Dropping files onto the memo list imports them into the same folder.
  const dataTransfer = await page.evaluateHandle((pageStamp) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([`<title>拖入 ${pageStamp}</title><p>dropped</p>`], "dropped.html", { type: "text/html" }));
    return transfer;
  }, stamp);
  const list = page.locator("[data-memo-id]").first().locator("xpath=ancestor::div[@tabindex='0'][1]");
  await list.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("松开以导入 HTML 制品")).toBeVisible();
  await list.dispatchEvent("dragover", { dataTransfer });
  await list.dispatchEvent("drop", { dataTransfer });
  await expect(cards.filter({ hasText: `拖入 ${stamp}` })).toHaveCount(1);
  await expect(page.locator("[data-html-artifact-reader]")).toBeVisible();
});
