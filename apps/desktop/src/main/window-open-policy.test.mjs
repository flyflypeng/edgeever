import { describe, expect, test } from "bun:test";
import { frameNavigationDecision, isAllowedPrintPreviewUrl, isResourceDownloadUrl } from "./window-open-policy.mjs";

test("resource downloads require a safe resource ID and explicit download filename", () => {
  for (const url of ["edgeever-resource://resource/note?download=note.html", "edgeever-staged://pending?download=note.txt"]) {
    expect(isResourceDownloadUrl(url)).toBe(true);
  }
  for (const url of ["edgeever-resource://resource/note", "edgeever-staged://pending", "https://example.org/note?download=note.html", "edgeever-resource://user@resource/note?download=note.html", "edgeever-resource://resource/%2e%2e?download=note.html", "edgeever-staged://pending?download=%00"]) {
    expect(isResourceDownloadUrl(url)).toBe(false);
  }
});

test("links followed inside an HTML artifact open in the system browser and never replace the page", () => {
  const appUrl = "http://127.0.0.1:5173/";
  const link = { url: "https://example.com/docs", isMainFrame: false, isSameDocument: false, frameUrl: "about:srcdoc", appUrl };
  expect(frameNavigationDecision(link)).toEqual({ block: true, openExternal: "https://example.com/docs" });
  expect(frameNavigationDecision({ ...link, url: "http://example.com/" })).toEqual({ block: true, openExternal: "http://example.com/" });
  // A "#section" link in a srcdoc page resolves against the app's URL: stay put, open nothing.
  expect(frameNavigationDecision({ ...link, url: "http://127.0.0.1:5173/#section" })).toEqual({ block: true });
  expect(frameNavigationDecision({ ...link, url: "edgeever-app://app/index.html#section", appUrl: "edgeever-app://app/index.html" })).toEqual({ block: true });
  expect(frameNavigationDecision({ ...link, url: "javascript:alert(1)" })).toEqual({ block: true });
  expect(frameNavigationDecision({ ...link, url: "file:///etc/passwd" })).toEqual({ block: true });
  expect(frameNavigationDecision({ ...link, url: "https://user:secret@example.com/" })).toEqual({ block: true });
  // The reader reloading the page, the app's own frame and frames the page embeds are left alone.
  expect(frameNavigationDecision({ ...link, url: "about:srcdoc" })).toBeNull();
  expect(frameNavigationDecision({ ...link, isSameDocument: true })).toBeNull();
  expect(frameNavigationDecision({ ...link, isMainFrame: true })).toBeNull();
  expect(frameNavigationDecision({ ...link, frameUrl: "about:blank" })).toBeNull();
  expect(frameNavigationDecision({ ...link, frameUrl: "https://www.youtube.com/embed/x" })).toBeNull();
});

describe("desktop window open policy", () => {
  test("allows only the packaged print preview beside the app entry", () => {
    const appUrl = "file:///Applications/EdgeEver.app/Contents/Resources/web/index.html";

    expect(isAllowedPrintPreviewUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/note-print.html?token=abc",
      appUrl,
    )).toBe(true);
    expect(isAllowedPrintPreviewUrl("file:///note-print.html?token=abc", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl(
      "file:///Applications/EdgeEver.app/Contents/Resources/web/mobile-edit.html",
      appUrl,
    )).toBe(false);
  });

  test("allows the same-origin print preview in desktop development", () => {
    const appUrl = "http://127.0.0.1:5173/";

    expect(isAllowedPrintPreviewUrl("http://127.0.0.1:5173/note-print.html?token=abc", appUrl)).toBe(true);
    expect(isAllowedPrintPreviewUrl("https://example.com/note-print.html", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl("http://127.0.0.1:5173/settings", appUrl)).toBe(false);
  });

  test("allows only the print preview on the private desktop origin", () => {
    const appUrl = "edgeever-app://app/index.html";

    expect(isAllowedPrintPreviewUrl("edgeever-app://app/note-print.html?token=abc", appUrl)).toBe(true);
    expect(isAllowedPrintPreviewUrl("edgeever-app://other/note-print.html", appUrl)).toBe(false);
    expect(isAllowedPrintPreviewUrl("edgeever-app://app/mobile-edit.html", appUrl)).toBe(false);
  });
});
