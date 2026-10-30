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

  // The artifact shows up in the trash, opens read-only and can be restored.
  await page.getByRole("button", { name: "回收站" }).first().click();
  const trashed = page.locator("[data-memo-id]").filter({ hasText: renamed });
  await expect(trashed).toBeVisible();
  await trashed.click();
  await reader.getByRole("button", { name: "恢复制品" }).click();
  await expect(trashed).toHaveCount(0);
  await page.locator("[data-artifact-library-section]").getByRole("button").first().click();
  await expect(page.locator("[data-memo-id]").filter({ hasText: renamed })).toBeVisible();
});

test("a #section link scrolls within the artifact instead of blanking it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);
  const appUrl = page.url();
  await importArtifact(page, `section-links-${Date.now()}.html`, `<!doctype html>
<html>
<body>
  <nav><a id="to-far" href="#far"><span id="to-far-label">far</span></a> <a id="own" href="#far">own</a></nav>
  <div style="height: 4000px"></div>
  <h2 id="far">Far section</h2>
  <div style="height: 4000px"></div>
  <script>
    document.getElementById("own").addEventListener("click", (event) => {
      event.preventDefault();
      event.currentTarget.textContent = "own:handled";
    });
  </script>
</body>
</html>`);

  const frame = page.frameLocator("[data-html-artifact-reader] iframe");
  const far = frame.locator("#far");
  await expect(far).toHaveText("Far section");

  // The page's own click handler keeps priority: no jump to the section.
  await frame.locator("#own").click();
  await expect(frame.locator("#own")).toHaveText("own:handled");
  expect(await far.evaluate(() => window.location.hash)).toBe("");

  // A click on the link's content goes to the section, in the same document.
  await frame.locator("#to-far-label").click();
  await expect(far).toBeInViewport();
  expect(await far.evaluate(() => window.location.hash)).toBe("#far");
  await expect(frame.locator("#own")).toHaveText("own:handled");

  // The section can be reached again after scrolling away.
  await far.evaluate(() => window.scrollTo(0, 0));
  await expect(far).not.toBeInViewport();
  await frame.locator("#to-far").click();
  await expect(far).toBeInViewport();
  expect(page.url()).toBe(appUrl);
});

test("a link that resolves to the app stays on the artifact, other links still leave", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);
  const appOrigin = new URL(page.url()).origin;
  const externalUrl = "https://external.edgeever-e2e.test/page";
  await page.route(externalUrl, (route) => route.fulfill({ contentType: "text/html", body: "<h1 id=\"arrived\">external</h1>" }));
  const appLoads: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() !== page.mainFrame() && request.url().startsWith(appOrigin)) appLoads.push(request.url());
  });

  await importArtifact(page, `app-links-${Date.now()}.html`, `<!doctype html>
<html>
<body>
  <a id="relative" href="other.html">relative</a>
  <a id="root-relative" href="/other">root</a>
  <a id="query" href="?page=2">query</a>
  <a id="empty" href="">empty</a>
  <a id="absolute" href="${appOrigin}/other">absolute</a>
  <a id="to-far" href="#far">far</a>
  <a id="external" href="${externalUrl}">external</a>
  <div style="height: 4000px"></div>
  <h2 id="far">Far section</h2>
</body>
</html>`);
  const frame = page.frameLocator("[data-html-artifact-reader] iframe");
  for (const id of ["relative", "root-relative", "query", "empty", "absolute"]) await frame.locator(`#${id}`).click();
  // A later click still lands, so the page is still there; it also gives a navigation time to start.
  await frame.locator("#to-far").click();
  await expect(frame.locator("#far")).toBeInViewport();
  expect(appLoads).toEqual([]);

  // A link to anywhere else behaves as the page wrote it.
  await frame.locator("#external").click();
  await expect(frame.locator("#arrived")).toHaveText("external");

  // A page's own <base> pointing at the app is caught as well.
  await importArtifact(page, `app-base-${Date.now()}.html`, `<!doctype html>
<html>
<head><base href="${appOrigin}/sub/"></head>
<body>
  <a id="based" href="other.html">based</a>
  <a id="based-section" href="#far">section</a>
  <div style="height: 4000px"></div>
  <h2 id="far">Far section</h2>
</body>
</html>`);
  await frame.locator("#based").click();
  await frame.locator("#based-section").click();
  await expect(frame.locator("#far")).toHaveText("Far section");
  expect(appLoads).toEqual([]);
});
