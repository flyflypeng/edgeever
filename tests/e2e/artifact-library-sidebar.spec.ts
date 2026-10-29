import { expect, test } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";

test("manages artifact folders in their own sidebar section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(E2E_WEB_URL);

  const section = page.locator("[data-artifact-library-section]");
  const notebookTree = page.locator("[data-notebook-tree]");
  await expect(section).toBeVisible();

  // Opening the section creates the library on first use and selects it.
  // The library is renamable, so read its current name instead of assuming one.
  const libraryButton = section.locator("button").first();
  await libraryButton.click();
  await expect(section.locator("[aria-current='page']")).toBeVisible();
  const libraryName = (await libraryButton.innerText()).trim();

  const folderName = `E2E 制品文件夹 ${Date.now()}`;
  await section.hover();
  await section.getByRole("button", { name: "新建制品文件夹" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("新建制品文件夹").first()).toBeVisible();
  await dialog.getByLabel("名称").fill(folderName);
  await dialog.getByRole("button", { name: "创建" }).click();

  const folderRow = section.locator("[data-artifact-folder-tree] [data-notebook-id]").filter({ hasText: folderName });
  await expect(folderRow).toBeVisible();
  await expect(notebookTree.getByText(folderName)).toHaveCount(0);
  await expect(notebookTree.getByText(libraryName, { exact: true })).toHaveCount(0);

  const renamed = `${folderName} 已改名`;
  await folderRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await expect(page.getByRole("dialog").getByText("重命名制品文件夹")).toBeVisible();
  await page.getByRole("dialog").getByLabel("名称").fill(renamed);
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  const renamedRow = section.locator("[data-notebook-id]").filter({ hasText: renamed });
  await expect(renamedRow).toBeVisible();

  await renamedRow.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /分享/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "删除文件夹" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expect(section.locator("[data-notebook-id]").filter({ hasText: renamed })).toHaveCount(0);

  // The collapsed rail keeps an entry into the library.
  await page.getByRole("button", { name: /收起笔记本栏/ }).first().click();
  const rail = page.locator("[data-notebook-sidebar-rail]");
  await expect(rail).toBeVisible();
  const railEntry = rail.getByRole("button", { name: libraryName, exact: true });
  await expect(railEntry).toBeVisible();
  await railEntry.click();
  await expect(railEntry).toHaveAttribute("aria-current", "page");
  await rail.getByRole("button", { name: /展开笔记本栏/ }).click();
});
