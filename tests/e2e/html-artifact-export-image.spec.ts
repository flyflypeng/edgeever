import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

const E2E_WEB_URL = process.env.EDGE_EVER_E2E_WEB_URL ?? "/";
// A 1×1 PNG; served without CORS headers it taints any canvas it is drawn on.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A teal page three screens tall whose last 200 px are red: only an image of
// the whole document shows the red band.
const longPage = (title: string, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;background:#0f766e;color:#fff;font:32px sans-serif}#bottom{height:200px;background:#dc2626}</style></head>
<body><h1>${title}</h1>${extra}<div style="height:2400px"></div><div id="bottom"></div></body></html>`;

const importArtifact = async (page: Page, filename: string, html: string) => {
  await page.getByRole("button", { name: "选择笔记类型" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入 HTML 制品" }).click();
  await (await chooser).setFiles({ name: filename, mimeType: "text/html", buffer: Buffer.from(html, "utf8") });
};

// The radios are visually hidden inside their labels; pick by clicking the label, as a user does.
const choose = async (dialog: Locator, label: string) => {
  await dialog.getByText(label, { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: label })).toBeChecked();
};

const inspectImage = async (download: Download) => {
  const path = await download.path();
  expect(path).not.toBeNull();
  const { data, info } = await sharp(path!).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  return { format: (await sharp(path!).metadata()).format, width: info.width, height: info.height, top: pixel(info.width - 5, 5), bottom: pixel(info.width - 5, info.height - 5) };
};

const isColor = ([red, green, blue]: number[], [r, g, b]: [number, number, number]) =>
  Math.abs(red - r) + Math.abs(green - g) + Math.abs(blue - b) < 40;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

// Right after a local import the client renders its thumbnail and syncs, and
// the reader may be put up once more meanwhile; wait for that to finish so
// the dialog opened next stays open.
const importSettled = async (page: Page, run: () => Promise<void>) => {
  const renderer = page.waitForSelector("[data-artifact-thumbnail-renderer]", { state: "attached" });
  await run();
  await renderer;
  await expect(page.locator("[data-artifact-thumbnail-renderer]")).toHaveCount(0, { timeout: 20_000 });
};

test("exports the whole page as a PNG and the visible area as a JPEG", async ({ page }) => {
  await page.goto(E2E_WEB_URL);
  const stamp = Date.now();
  const title = `E2E 导出图片 ${stamp}`;
  await importSettled(page, () => importArtifact(page, `export-${stamp}.html`, longPage(title)));

  const reader = page.locator("[data-html-artifact-reader]");
  const iframe = reader.locator("iframe");
  await expect(page.frameLocator("[data-html-artifact-reader] iframe").locator("h1")).toHaveText(title);
  const frameBox = await iframe.evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));

  // PNG of the whole page: taller than the frame and showing the red band below the fold.
  await reader.getByRole("button", { name: "导出图片" }).click();
  const dialog = page.getByRole("dialog", { name: "导出图片" });
  await choose(dialog, "PNG");
  await choose(dialog, "整页长图");
  const pngDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出" }).click();
  const png = await pngDownload;
  expect(png.suggestedFilename()).toBe(`${title}.png`);
  const pageImage = await inspectImage(png);
  expect(pageImage.format).toBe("png");
  expect(pageImage.width).toBe(frameBox.width);
  expect(pageImage.height).toBeGreaterThan(2600);
  expect(isColor(pageImage.top, [0x0f, 0x76, 0x6e])).toBe(true);
  expect(isColor(pageImage.bottom, [0xdc, 0x26, 0x26])).toBe(true);
  await expect(dialog).toHaveCount(0);

  // JPEG of what is on screen: the frame's size, no red band.
  await reader.getByRole("button", { name: "导出图片" }).click();
  await choose(dialog, "JPEG");
  await choose(dialog, "当前可视区域");
  const jpegDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出" }).click();
  const jpeg = await jpegDownload;
  expect(jpeg.suggestedFilename()).toBe(`${title}.jpg`);
  const viewportImage = await inspectImage(jpeg);
  expect(viewportImage).toMatchObject({ format: "jpeg", width: frameBox.width, height: frameBox.height });
  expect(isColor(viewportImage.bottom, [0x0f, 0x76, 0x6e])).toBe(true);
});

test("a page with cross-origin content that taints the screenshot shows why and downloads nothing", async ({ page }) => {
  // A real server without CORS headers: Playwright's route.fulfill would add them.
  const imageServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(PNG_1X1);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
  const crossOriginImageUrl = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}/photo.png`;
  try {
    await page.goto(E2E_WEB_URL);
    const stamp = Date.now();
    const title = `E2E 导出污染 ${stamp}`;
    await importSettled(page, () => importArtifact(page, `export-tainted-${stamp}.html`, longPage(title, `<img src="${crossOriginImageUrl}" width="400" height="300">`)));
    await expect(page.frameLocator("[data-html-artifact-reader] iframe").locator("h1")).toHaveText(title);

    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    const reader = page.locator("[data-html-artifact-reader]");
    await reader.getByRole("button", { name: "导出图片" }).click();
    const dialog = page.getByRole("dialog", { name: "导出图片" });
    await choose(dialog, "PNG");
    await dialog.getByRole("button", { name: "导出" }).click();
    await expect(dialog.getByRole("alert")).toContainText("跨域", { timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "导出" })).toBeEnabled();
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
  } finally {
    imageServer.close();
  }
});
