import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";

const page_ = (heading: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><h1 id="heading">${heading}</h1></body></html>`;

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

test("replaces an artifact's page and restores the previous version from its history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);

  const stamp = Date.now();
  const title = `E2E 版本 ${stamp}`;
  await importArtifact(page, `versions-${stamp}.html`, page_(title));

  const reader = page.locator("[data-html-artifact-reader]");
  const frame = page.frameLocator("[data-html-artifact-reader] iframe");
  await expect(frame.locator("#heading")).toHaveText(title);

  // Replace the page with a new file; the title stays and the new page shows.
  const chooser = page.waitForEvent("filechooser");
  await reader.getByRole("button", { name: "替换内容…" }).click();
  await (await chooser).setFiles({ name: `versions-${stamp}-v2.html`, mimeType: "text/html", buffer: Buffer.from(page_("第二版内容"), "utf8") });
  await expect(frame.locator("#heading")).toHaveText("第二版内容");
  await expect(reader.getByRole("textbox", { name: "制品标题" })).toHaveValue(title);

  // The version before the replacement is in the history and can be restored.
  await reader.getByRole("button", { name: "版本历史" }).click();
  const history = page.getByRole("dialog").filter({ hasText: "恢复该版本" });
  await expect(history.getByText(title).first()).toBeVisible();
  await history.getByRole("button", { name: "恢复该版本" }).click();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(frame.locator("#heading")).toHaveText(title);

  // A file that is not HTML is refused and the page stays.
  const badChooser = page.waitForEvent("filechooser");
  await reader.getByRole("button", { name: "替换内容…" }).click();
  await (await badChooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain", "utf8") });
  await expect(reader.getByRole("alert")).toContainText(".html");
  await expect(frame.locator("#heading")).toHaveText(title);
});
