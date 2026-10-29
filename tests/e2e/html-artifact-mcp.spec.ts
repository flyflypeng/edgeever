import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const pageHtml = (title: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#0f766e;color:#fff;font:48px sans-serif}</style></head>
<body><h1>${title}</h1></body></html>`;

// An agent's MCP call, authenticated by the signed-in session like the desktop bridge.
const callMcpTool = async (page: Page, name: string, args: Record<string, unknown>) => {
  const response = await page.request.post("/mcp", {
    headers: { Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  const { result } = await response.json();
  expect(result.isError).toBe(false);
  return result.structuredContent;
};

test("artifacts imported through MCP show up in the web list; only the one without a thumbnail is rendered by the client", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(E2E_WEB_URL);
  const stamp = Date.now();
  const plainTitle = `E2E MCP 无缩略图 ${stamp}`;
  const thumbnailTitle = `E2E MCP 带缩略图 ${stamp}`;

  const plain = await callMcpTool(page, "create_html_artifact", { title: plainTitle, html: pageHtml(plainTitle), source: "e2e", externalId: `plain-${stamp}` });
  const withThumbnail = await callMcpTool(page, "create_html_artifact", {
    title: thumbnailTitle,
    html: pageHtml(thumbnailTitle),
    thumbnailBase64: PNG_1X1_BASE64,
    thumbnailMimeType: "image/png",
  });
  const memoResponse = await page.request.get(`/api/v1/memos/${withThumbnail.artifact.id}`);
  const thumbnailResourceId: string = (await memoResponse.json()).memo.artifact.thumbnailResourceId;

  const uploads: string[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/artifacts\/([^/]+)\/thumbnail$/.exec(new URL(request.url()).pathname);
    if (match && request.method() === "PUT") uploads.push(decodeURIComponent(match[1]));
  });

  await page.reload();
  await page.locator("[data-artifact-library-section]").getByRole("button").first().click();
  const plainCard = page.locator("[data-memo-id]").filter({ hasText: plainTitle });
  const thumbnailCard = page.locator("[data-memo-id]").filter({ hasText: thumbnailTitle });
  await expect(plainCard).toBeVisible();
  await expect(thumbnailCard).toBeVisible();

  // The agent's image is the card thumbnail as is.
  await expect(thumbnailCard.locator("img[data-artifact-thumbnail]")).toHaveAttribute("src", new RegExp(thumbnailResourceId));
  // The page without one is rendered and uploaded by the client.
  await expect(plainCard.locator("img[data-artifact-thumbnail]")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => uploads.includes(plain.artifact.id)).toBe(true);
  expect(uploads).not.toContain(withThumbnail.artifact.id);

  // Importing the same page again changes nothing.
  expect((await callMcpTool(page, "create_html_artifact", { title: plainTitle, html: pageHtml(plainTitle), source: "e2e", externalId: `plain-${stamp}` })).status)
    .toBe("unchanged");
});
