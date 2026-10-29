import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
const CDN_SCRIPT_URL = "https://cdn.edgeever-e2e.test/lib.js";

// The page probes everything a hostile artifact would try and writes what it
// could reach into its own DOM, where the test reads it back.
const artifactHtml = (title: string) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <script src="${CDN_SCRIPT_URL}"></script>
</head>
<body>
  <h1>Sandbox probe</h1>
  <output id="cdn">cdn:missing</output>
  <output id="parent-dom"></output>
  <output id="parent-storage"></output>
  <output id="parent-cookie"></output>
  <output id="top-navigation"></output>
  <button id="counter" type="button">clicks:0</button>
  <form id="form"><input id="name" name="name"><button id="submit" type="submit">send</button></form>
  <output id="form-result"></output>
  <button id="escape" type="button">leave</button>
  <script>
    const probe = (id, read) => {
      let value;
      try { value = "leaked:" + String(read()); } catch (error) { value = "blocked:" + error.name; }
      document.getElementById(id).textContent = value;
    };
    document.getElementById("cdn").textContent = window.e2eCdnLoaded ? "cdn:loaded" : "cdn:missing";
    probe("parent-dom", () => window.parent.document.title);
    probe("parent-storage", () => window.parent.localStorage.getItem("e2e-artifact-secret") ?? window.localStorage.getItem("e2e-artifact-secret"));
    probe("parent-cookie", () => window.parent.document.cookie || document.cookie);
    let clicks = 0;
    document.getElementById("counter").addEventListener("click", (event) => {
      clicks += 1;
      event.currentTarget.textContent = "clicks:" + clicks;
    });
    document.getElementById("form").addEventListener("submit", (event) => {
      event.preventDefault();
      document.getElementById("form-result").textContent = "hello " + new FormData(event.currentTarget).get("name");
    });
    document.getElementById("escape").addEventListener("click", () => {
      try { window.top.location.href = "https://example.com/escaped"; document.getElementById("top-navigation").textContent = "attempted"; }
      catch (error) { document.getElementById("top-navigation").textContent = "blocked:" + error.name; }
    });
  </script>
</body>
</html>`;

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

test("imports a local HTML file and renders it in an isolated, interactive sandbox", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(CDN_SCRIPT_URL, (route) => route.fulfill({ contentType: "text/javascript", body: "window.e2eCdnLoaded = true;" }));
  await page.goto(E2E_WEB_URL);
  await context.addCookies([{ name: "e2e_artifact_cookie", value: "parent-secret", url: page.url() }]);
  await page.evaluate(() => window.localStorage.setItem("e2e-artifact-secret", "parent-secret"));
  const appUrl = page.url();

  const title = `E2E 制品 ${Date.now()}`;
  const filename = `sandbox-probe-${Date.now()}.html`;
  await importArtifact(page, filename, artifactHtml(title));

  // The card lands in the Artifact Library with a placeholder thumbnail.
  const card = page.locator("[data-memo-id]").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card.locator("[data-artifact-thumbnail-placeholder]")).toBeVisible();
  await expect(page.locator("[data-artifact-library-section] [aria-current='page']")).toBeVisible();

  const reader = page.locator("[data-html-artifact-reader]");
  const iframe = reader.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads");
  await expect(iframe).toHaveAttribute("allow", "fullscreen");
  const frame = page.frameLocator("[data-html-artifact-reader] iframe");

  // External scripts load; the parent's DOM, storage and cookies stay out of reach.
  await expect(frame.locator("#cdn")).toHaveText("cdn:loaded");
  await expect(frame.locator("#parent-dom")).toHaveText(/^blocked:/);
  await expect(frame.locator("#parent-storage")).toHaveText(/^blocked:/);
  await expect(frame.locator("#parent-cookie")).toHaveText(/^blocked:/);

  // Buttons and forms inside the page work.
  await frame.locator("#counter").click();
  await frame.locator("#counter").click();
  await expect(frame.locator("#counter")).toHaveText("clicks:2");
  await frame.locator("#name").fill("artifact");
  await frame.locator("#submit").click();
  await expect(frame.locator("#form-result")).toHaveText("hello artifact");

  // Navigating the top window fails and the app stays put.
  await frame.locator("#escape").click();
  await expect(frame.locator("#top-navigation")).not.toHaveText("");
  expect(page.url()).toBe(appUrl);
  await expect(reader).toBeVisible();

  // Reload resets the page's state.
  await reader.getByRole("button", { name: "刷新" }).click();
  await expect(frame.locator("#counter")).toHaveText("clicks:0");

  // Fullscreen covers the reader and Esc leaves it.
  await reader.getByRole("button", { name: /全屏沉浸/ }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.hasAttribute("data-html-artifact-viewer") ?? false)).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  // Download keeps the original file name.
  const download = page.waitForEvent("download");
  await reader.getByRole("button", { name: "下载 HTML" }).click();
  expect((await download).suggestedFilename()).toBe(filename);

  // There is no way to open the page in a new tab.
  await expect(page.getByRole("button", { name: /新标签页/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /新标签页/ })).toHaveCount(0);

  // Rename from the toolbar.
  const renamed = `${title} 已改名`;
  const titleInput = reader.getByRole("textbox", { name: "制品标题" });
  await titleInput.fill(renamed);
  await titleInput.press("Enter");
  await expect(page.locator("[data-memo-id]").filter({ hasText: renamed })).toBeVisible();

  // Artifacts cannot be shared: neither the reader nor the card menu offers it.
  await expect(reader.getByRole("button", { name: /分享/ })).toHaveCount(0);
  await page.locator("[data-memo-id]").filter({ hasText: renamed }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "导出 HTML" }).or(page.getByRole("menuitem", { name: /移入回收站|删除/ })).first()).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /分享笔记|管理分享|同步后可分享/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Move to trash.
  await reader.getByRole("button", { name: "移入回收站" }).click();
  await expect(page.locator("[data-memo-id]").filter({ hasText: renamed })).toHaveCount(0);
});
