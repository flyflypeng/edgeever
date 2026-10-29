import { expect, test, type Page } from "@playwright/test";
import { parseArtifactDocument } from "../../packages/shared/src/artifact";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
const CDN_SCRIPT_URL = "https://cdn.edgeever-e2e.test/offline-lib.js";

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

test("an opened artifact renders offline, an unopened one asks for a connection, and sync carries no HTML", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  const openedTitle = `离线已打开 ${stamp}`;
  const unopenedTitle = `离线未打开 ${stamp}`;
  // Script bodies stay out of the searchable text, so they only travel inside the HTML itself.
  const openedMarker = `openedBody${stamp}`;
  const unopenedMarker = `unopenedBody${stamp}`;
  const openedHtml = `<!doctype html><title>${openedTitle}</title><script src="${CDN_SCRIPT_URL}"></script>
<output id="inline">inline:missing</output><output id="cdn">cdn:missing</output>
<script>var ${openedMarker} = 1; document.getElementById("inline").textContent = "inline:ok";
document.getElementById("cdn").textContent = window.e2eOfflineCdn ? "cdn:loaded" : "cdn:missing";</script>`;
  const unopenedHtml = `<!doctype html><title>${unopenedTitle}</title><p>never opened</p><script>var ${unopenedMarker} = 1;</script>`;

  await page.route(CDN_SCRIPT_URL, (route) => route.fulfill({ contentType: "text/javascript", body: "window.e2eOfflineCdn = true;" }));
  const syncBodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/v1/sync/")) syncBodies.push(response.text().catch(() => ""));
  });
  await page.goto(E2E_WEB_URL);

  // Opening an artifact once is what keeps it readable offline.
  await importArtifact(page, `offline-opened-${stamp}.html`, openedHtml);
  const reader = page.locator("[data-html-artifact-reader]");
  const frame = page.frameLocator("[data-html-artifact-reader] iframe");
  await expect(reader.getByLabel("制品标题")).toHaveValue(openedTitle);
  await expect(frame.locator("#inline")).toHaveText("inline:ok");
  await expect(frame.locator("#cdn")).toHaveText("cdn:loaded");

  // The second artifact reaches this device only through sync. Its HTML is
  // blocked so that nothing on this device, not even a thumbnail render, keeps a copy.
  const created = await page.request.post("/api/v1/artifacts", {
    multipart: { file: { name: `offline-unopened-${stamp}.html`, mimeType: "text/html", buffer: Buffer.from(unopenedHtml, "utf8") } },
  });
  expect(created.status()).toBe(201);
  const unopenedHtmlId = parseArtifactDocument((await created.json()).memo.contentMarkdown)?.htmlResourceId;
  expect(unopenedHtmlId).toBeTruthy();
  await page.route(`**/api/v1/resources/${unopenedHtmlId}/blob`, (route) => route.abort());

  // Pull it the way a reconnect does. A reload would not do: in development the
  // app clears Cache Storage on every page load.
  await page.locator("[data-artifact-library-section]").getByRole("button").first().click();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const openedCard = page.locator("[data-memo-id]").filter({ hasText: openedTitle });
  const unopenedCard = page.locator("[data-memo-id]").filter({ hasText: unopenedTitle });
  await expect(openedCard).toBeVisible();
  await expect(unopenedCard).toBeVisible();
  // Sync moves the memos only; neither page's HTML is in its traffic.
  const synced = (await Promise.all(syncBodies)).join("\n");
  expect(synced).toContain(unopenedTitle);
  expect(synced).not.toContain(openedMarker);
  expect(synced).not.toContain(unopenedMarker);

  // A routed request would still be answered offline.
  await page.unroute(CDN_SCRIPT_URL);
  await context.setOffline(true);
  try {
    expect(await page.evaluate(async () => { try { await fetch("/api/v1/auth/session"); return false; } catch { return true; } })).toBe(true);

    await unopenedCard.click();
    await expect(reader.getByLabel("制品标题")).toHaveValue(unopenedTitle);
    await expect(reader.getByRole("alert")).toContainText("需要联网加载");
    await expect(reader.locator("iframe")).toHaveCount(0);

    await openedCard.click();
    await expect(reader.getByLabel("制品标题")).toHaveValue(openedTitle);
    await expect(frame.locator("#inline")).toHaveText("inline:ok");
    // Only inline content is kept; the CDN script needs the network.
    await expect(frame.locator("#cdn")).toHaveText("cdn:missing");
  } finally {
    await context.setOffline(false);
  }
});
