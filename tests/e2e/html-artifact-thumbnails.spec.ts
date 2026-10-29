import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
// A 1×1 PNG; served without CORS headers it taints any canvas it is drawn on.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const pageHtml = (title: string, body = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#0f766e;color:#fff;font:48px sans-serif}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

const countThumbnailUploads = (page: Page) => {
  const uploads: string[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/artifacts\/([^/]+)\/thumbnail$/.exec(new URL(request.url()).pathname);
    if (match && request.method() === "PUT") uploads.push(decodeURIComponent(match[1]));
  });
  return uploads;
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("a locally imported artifact shows a card in style B with its first-screen thumbnail", async ({ page }) => {
  await page.goto(E2E_WEB_URL);
  const title = `E2E 缩略图 ${Date.now()}`;

  await importArtifact(page, `thumbnail-${Date.now()}.html`, pageHtml(title));

  const card = page.locator("[data-memo-id]").filter({ hasText: title });
  await expect(card).toBeVisible();
  const thumbnail = card.locator("img[data-artifact-thumbnail]");
  await expect(thumbnail).toBeVisible({ timeout: 20_000 });
  await expect(card.locator("[data-artifact-thumbnail-placeholder]")).toHaveCount(0);
  // 480 px wide, 16:10, and actually showing the page's teal first screen.
  const image = await thumbnail.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    const [red, green, blue] = context.getImageData(canvas.width - 5, canvas.height - 5, 1, 1).data;
    return { width: element.naturalWidth, height: element.naturalHeight, red, green, blue };
  });
  expect(image).toMatchObject({ width: 480, height: 300 });
  expect(Math.abs(image.red - 0x0f) + Math.abs(image.green - 0x76) + Math.abs(image.blue - 0x6e)).toBeLessThan(30);

  // Title on top, the 16:10 image in the middle, then relative time and tags.
  const order = await card.evaluate((element) => {
    const top = (selector: string) => element.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN;
    return { title: top("span.truncate"), image: top("img[data-artifact-thumbnail]"), time: top("time") };
  });
  expect(order.title).toBeLessThan(order.image);
  expect(order.image).toBeLessThan(order.time);
  await expect(card.locator("time")).toHaveText(/(现在|分钟前|秒)/);

  // Only one card layout: the library's list menu offers no density switch.
  await page.getByRole("button", { name: "列表更多操作" }).first().click();
  await expect(page.getByRole("menuitem", { name: /排序/ })).toBeVisible();
  await expect(page.getByText("紧凑列表")).toHaveCount(0);
  await expect(page.getByText("预览列表")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("an artifact created through the API gets its thumbnail once per session; a tainted page keeps the placeholder", async ({ page }) => {
  // A real server without CORS headers: Playwright's route.fulfill would add them.
  const imageServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(PNG_1X1);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
  // 127.0.0.1 with another port is another origin than the app's.
  const crossOriginImageUrl = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}/photo.png`;
  try {
    await page.goto(E2E_WEB_URL);
    const stamp = Date.now();
    const plainTitle = `E2E 补生成 ${stamp}`;
    const taintedTitle = `E2E 污染 ${stamp}`;
    const library = page.locator("[data-artifact-library-section]").getByRole("button").first();
    // Make sure the library exists before creating artifacts through the API.
    await library.click();

    // Create both straight through the API, as an agent would: no thumbnail yet.
    const created = await page.evaluate(async ({ plain, tainted }) => {
      const create = async (name: string, html: string) => {
        const form = new FormData();
        form.append("file", new File([html], name, { type: "text/html" }));
        const response = await fetch("/api/v1/artifacts", { method: "POST", body: form, credentials: "include" });
        return (await response.json()).memo as { id: string; artifact: { thumbnailStale: boolean } };
      };
      return [await create("plain.html", plain), await create("tainted.html", tainted)];
    }, {
      plain: pageHtml(plainTitle),
      tainted: pageHtml(taintedTitle, `<img src="${crossOriginImageUrl}" width="400" height="300">`),
    });
    expect(created.map((memo) => memo.artifact.thumbnailStale)).toEqual([true, true]);
    // Other stale artifacts in a shared dev workspace may be filled in too; only these two matter.
    const allUploads = countThumbnailUploads(page);
    const createdIds = new Set(created.map((memo) => memo.id));
    const uploads = () => allUploads.filter((memoId) => createdIds.has(memoId));

    // A fresh session opens the library: the list shows both cards and the client fills in what it can.
    await page.reload();
    await library.click();
    const plainCard = page.locator("[data-memo-id]").filter({ hasText: plainTitle });
    const taintedCard = page.locator("[data-memo-id]").filter({ hasText: taintedTitle });
    await expect(plainCard.locator("img[data-artifact-thumbnail]")).toBeVisible({ timeout: 20_000 });
    await expect(taintedCard.locator("[data-artifact-thumbnail-placeholder]")).toBeVisible();
    // The tainted page was rendered but never uploaded.
    await expect.poll(() => page.locator("[data-artifact-thumbnail-renderer]").count(), { timeout: 20_000 }).toBe(0);
    expect(uploads()).toEqual([created[0].id]);

    // Leaving and coming back in the same session does not try the tainted page again.
    await page.getByRole("button", { name: "全部笔记" }).first().click();
    await library.click();
    await expect(taintedCard).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator("[data-artifact-thumbnail-renderer]")).toHaveCount(0);
    expect(uploads()).toEqual([created[0].id]);
    await expect(taintedCard.locator("[data-artifact-thumbnail-placeholder]")).toBeVisible();
  } finally {
    imageServer.close();
  }
});

test("the bridge only trusts messages from its own frame with its channel id", async ({ page }) => {
  await page.goto(E2E_WEB_URL);

  const result = await page.evaluate(async () => {
    // Runs in the page: the dev server serves the app's own bridge module by URL.
    const bridgeModule = "/src/lib/html-artifact-bridge.ts";
    const { connectArtifactBridge, createArtifactBridge } = await import(/* @vite-ignore */ bridgeModule);
    const sandbox = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
    const mount = (srcdoc: string) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", sandbox);
      frame.style.cssText = "position:fixed;left:-5000px;top:0;width:800px;height:500px";
      document.body.appendChild(frame);
      frame.srcdoc = srcdoc;
      return frame;
    };

    // The page itself forges answers. It cannot read the channel (the bridge
    // script removed itself), so it reports what it can see and guesses.
    const forgingPage = `<!doctype html><html><body style="background:#fff"><p>forger</p><script>
      parent.postMessage({ seen: document.documentElement.outerHTML }, "*");
      const fake = new Blob(["not a screenshot"], { type: "image/png" });
      setInterval(() => {
        for (const channel of ["", "edgeever", "0".repeat(32), undefined]) {
          parent.postMessage({ channel, type: "edgeever-artifact:capture-result", requestId: 1, ok: true, image: fake }, "*");
          parent.postMessage({ channel, type: "edgeever-artifact:height", height: 123456 }, "*");
          parent.postMessage({ channel, type: "edgeever-artifact:ready" }, "*");
        }
      }, 5);
    </script></body></html>`;
    const real = createArtifactBridge(forgingPage);
    let seenByPage = "";
    window.addEventListener("message", (event) => {
      if (typeof event.data?.seen === "string") seenByPage = event.data.seen;
    });
    const heights: number[] = [];
    // Readiness is announced on load; a forged "ready" must not be enough.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", sandbox);
    frame.style.cssText = "position:fixed;left:-5000px;top:0;width:800px;height:500px";
    document.body.appendChild(frame);
    const bridge = connectArtifactBridge(frame, real.channel, { onHeight: (height: number) => heights.push(height) });

    // Another frame that somehow learned the channel is still not this frame.
    const intruder = mount(`<!doctype html><script>
      const fake = new Blob(["intruder"], { type: "image/png" });
      setInterval(() => {
        parent.postMessage({ channel: ${JSON.stringify(real.channel)}, type: "edgeever-artifact:capture-result", requestId: 1, ok: true, image: fake }, "*");
        parent.postMessage({ channel: ${JSON.stringify(real.channel)}, type: "edgeever-artifact:height", height: 654321 }, "*");
      }, 5);
    </script>`);

    frame.srcdoc = real.srcDoc;
    await bridge.ready;
    // The bridge removed its script tag, so the page cannot read the channel from the DOM.
    const image: Blob = await bridge.capture({ area: "viewport", mimeType: "image/png", outputWidth: 200 });
    const header = new Uint8Array(await image.slice(0, 8).arrayBuffer());
    const decoded = await createImageBitmap(image);
    bridge.dispose();
    frame.remove();
    intruder.remove();
    return {
      isPng: header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47,
      width: decoded.width,
      heights,
      pageSawChannel: seenByPage.includes(real.channel),
      pageSawSomething: seenByPage.includes("forger"),
    };
  });

  expect(result.isPng).toBe(true);
  expect(result.width).toBe(200);
  expect(result.heights.length).toBeGreaterThan(0);
  expect(result.heights).not.toContain(123456);
  expect(result.heights).not.toContain(654321);
  expect(result).toMatchObject({ pageSawSomething: true, pageSawChannel: false });
});
