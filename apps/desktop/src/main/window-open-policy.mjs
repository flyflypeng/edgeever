import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadContentDispositionFromRequest, resourceIdFromRequest } from "./resource-url.mjs";

export const isResourceDownloadUrl = (targetUrl) => {
  try {
    const target = new URL(targetUrl);
    return ["edgeever-resource:", "edgeever-staged:"].includes(target.protocol)
      && !target.username && !target.password && !target.port
      && (target.protocol === "edgeever-resource:"
        ? target.hostname === "resource" && target.pathname.length > 1
        : Boolean(target.hostname) && ["", "/"].includes(target.pathname))
      && Boolean(resourceIdFromRequest(targetUrl))
      && Boolean(downloadContentDispositionFromRequest(targetUrl));
  } catch { return false; }
};

/**
 * What to do when a srcdoc iframe, such as the HTML artifact reader, follows a
 * link. The page is never replaced: a web link opens in the system browser, as
 * window.open already does; anything else, including a "#section" link that
 * resolves against the app's own URL, goes nowhere. Returns null for
 * navigations to leave alone.
 */
export const frameNavigationDecision = ({ url, isMainFrame, isSameDocument, frameUrl, appUrl }) => {
  if (isMainFrame || isSameDocument || frameUrl !== "about:srcdoc" || url === "about:srcdoc") return null;
  try {
    const target = new URL(url);
    const external = ["http:", "https:"].includes(target.protocol)
      && !target.username && !target.password
      && target.origin !== new URL(appUrl).origin;
    return external ? { block: true, openExternal: target.toString() } : { block: true };
  } catch { return { block: true }; }
};

export const isAllowedAppNavigation = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    const expected = new URL(appUrl);
    if (target.username || target.password || target.protocol !== expected.protocol) return false;
    if (target.protocol === "file:") return target.host === expected.host && target.pathname === expected.pathname;
    return ["http:", "https:", "edgeever-app:"].includes(target.protocol)
      && target.hostname === expected.hostname && target.port === expected.port;
  } catch { return false; }
};

export const isAllowedPrintPreviewUrl = (targetUrl, appUrl) => {
  try {
    const target = new URL(targetUrl);
    const currentApp = new URL(appUrl);
    if (target.username || target.password) return false;

    if (currentApp.protocol === "file:") {
      const expected = pathToFileURL(join(dirname(fileURLToPath(currentApp)), "note-print.html"));
      return target.protocol === "file:" && target.pathname === expected.pathname;
    }

    const expected = new URL("/note-print.html", currentApp);
    return target.protocol === expected.protocol &&
      target.hostname === expected.hostname &&
      target.port === expected.port &&
      target.pathname === expected.pathname;
  } catch {
    return false;
  }
};
