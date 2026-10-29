import htmlToImageSource from "html-to-image/dist/html-to-image.js?raw";

/**
 * The bridge between the app and a sandboxed HTML Artifact frame. A small
 * script is put first into the page; it reports the document height and takes
 * screenshots on request, and nothing else.
 *
 * Messages are only trusted when they come from that frame's window and carry
 * the channel id chosen for this load. The script removes itself from the DOM
 * before the page's own scripts run, so the page cannot read the id; a page
 * can still post anything it likes, which is why every field is validated.
 *
 * App → frame: `{ channel, type: "edgeever-artifact:capture", requestId, area, mimeType, quality?, outputWidth? }`
 * Frame → app:
 * - `{ channel, type: "edgeever-artifact:ready" }` once the page has loaded;
 * - `{ channel, type: "edgeever-artifact:height", height }` whenever the document height changes;
 * - `{ channel, type: "edgeever-artifact:capture-result", requestId, ok: true, image: Blob, width, height }`, or
 *   `{ channel, type: "edgeever-artifact:capture-result", requestId, ok: false, reason: "tainted" | "failed" }`.
 */

const MESSAGE = {
  ready: "edgeever-artifact:ready",
  height: "edgeever-artifact:height",
  capture: "edgeever-artifact:capture",
  captureResult: "edgeever-artifact:capture-result",
} as const;

export type ArtifactCaptureOptions = {
  /** `viewport`: what is on screen now; `page`: the whole scrollable document. */
  area: "viewport" | "page";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
  /** Width of the image in pixels; the height keeps the captured area's aspect ratio. Defaults to the area's CSS width. */
  outputWidth?: number;
};

/**
 * `tainted`: the page uses something the screenshot cannot include, such as a
 * cross-origin image without CORS, so the image would be incomplete.
 * `failed`: anything else, including no answer in time.
 */
export class ArtifactCaptureError extends Error {
  constructor(readonly reason: "tainted" | "failed" | "timeout") {
    super(`HTML artifact capture ${reason}`);
    this.name = "ArtifactCaptureError";
  }
}

const createChannelId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

// Runs inside the sandboxed page. html-to-image is evaluated in a closure whose
// `fetch` records every resource the page shows but the screenshot cannot
// read: html-to-image silently leaves those out, and a picture missing them
// must not be used. A failed request means the browser refused it (a
// cross-origin resource without CORS); a resource that is simply missing
// answers with an error status and is missing from the page too.
const bridgeScript = (channel: string, targetOrigin: string) => `(function () {
  "use strict";
  var channel = ${JSON.stringify(channel)};
  var targetOrigin = ${JSON.stringify(targetOrigin)};
  var current = document.currentScript;
  if (current && current.parentNode) current.parentNode.removeChild(current);
  var parentWindow = window.parent;
  var realFetch = window.fetch.bind(window);
  var unreadable = 0;
  var trackedFetch = function (input, init) {
    return realFetch(input, init).catch(function (error) {
      unreadable += 1;
      throw error;
    });
  };
  // Browsers pause animation frames in frames that are off screen, like the
  // hidden thumbnail renderer; html-to-image only waits one frame after an
  // image decodes, so a timer does the same job.
  var nextFrame = function (callback) {
    return setTimeout(function () { callback(performance.now()); }, 16);
  };
  var lib = {};
  (function (exports, module, define, fetch, requestAnimationFrame) {
${htmlToImageSource}
  }).call(window, lib, {}, undefined, trackedFetch, nextFrame);
  var post = function (message) {
    message.channel = channel;
    parentWindow.postMessage(message, targetOrigin);
  };
  var root = document.documentElement;
  var documentHeight = function () {
    return Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0);
  };
  var lastHeight = -1;
  var reportHeight = function () {
    var height = documentHeight();
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: ${JSON.stringify(MESSAGE.height)}, height: height });
  };
  window.addEventListener("load", function () {
    reportHeight();
    if (typeof ResizeObserver === "function") new ResizeObserver(reportHeight).observe(root);
    post({ type: ${JSON.stringify(MESSAGE.ready)} });
  });
  var background = function () {
    var elements = [document.body, root];
    for (var index = 0; index < elements.length; index += 1) {
      var color = elements[index] && getComputedStyle(elements[index]).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
    }
    return "#ffffff";
  };
  var TAINTED = {};
  var capture = function (request) {
    unreadable = 0;
    var unreadableFrames = 0;
    var page = request.area === "page";
    var width = page ? Math.max(root.scrollWidth, window.innerWidth) : window.innerWidth;
    var height = page ? documentHeight() : window.innerHeight;
    var outputWidth = Math.max(1, Math.round(Number(request.outputWidth) || width));
    var outputHeight = Math.max(1, Math.round(height * outputWidth / width));
    return lib.toCanvas(root, {
      width: width,
      height: height,
      canvasWidth: outputWidth,
      canvasHeight: outputHeight,
      pixelRatio: 1,
      backgroundColor: background(),
      style: page ? {} : { transform: "translate(" + -window.scrollX + "px, " + -window.scrollY + "px)" },
      filter: function (node) {
        // An image that is broken in the page is drawn as nothing either way.
        if (node.tagName === "IMG" && node.complete && node.naturalWidth === 0) return false;
        // A frame from another origin is drawn empty.
        if (node.tagName === "IFRAME") {
          try { if (!node.contentDocument) unreadableFrames += 1; } catch (error) { unreadableFrames += 1; }
        }
        return true;
      },
    }).then(function (canvas) {
      if (unreadable || unreadableFrames) throw TAINTED;
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve({ image: blob, width: canvas.width, height: canvas.height });
          else reject(new Error("empty capture"));
        }, request.mimeType, request.quality);
      });
    });
  };
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parentWindow || !data || data.channel !== channel || data.type !== ${JSON.stringify(MESSAGE.capture)}) return;
    var requestId = data.requestId;
    capture(data).then(function (result) {
      post({ type: ${JSON.stringify(MESSAGE.captureResult)}, requestId: requestId, ok: true, image: result.image, width: result.width, height: result.height });
    }, function (error) {
      // A resource the browser refused makes html-to-image fail on the empty
      // image it puts in its place; reading pixels drawn from another origin
      // throws SecurityError.
      var tainted = error === TAINTED || unreadable > 0 || (error && error.name === "SecurityError");
      post({ type: ${JSON.stringify(MESSAGE.captureResult)}, requestId: requestId, ok: false, reason: tainted ? "tainted" : "failed" });
    });
  });
})();`;

// The script goes right after the doctype: anything before it would switch
// the page into quirks mode.
const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/**
 * A fresh channel and the page with the bridge put in front of it. Create a
 * new one for every load, including reloads.
 */
export const createArtifactBridge = (html: string) => {
  const channel = createChannelId();
  const origin = window.location.origin;
  // Opaque or custom-scheme origins cannot be addressed by name.
  const targetOrigin = /^https?:\/\//.test(origin) ? origin : "*";
  const script = `<script>${bridgeScript(channel, targetOrigin).replace(/<\/(script)/gi, "<\\/$1")}</script>`;
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return { channel, srcDoc: `${doctype}${script}${html.slice(doctype.length)}` };
};

type BridgeMessage = { channel?: unknown; type?: unknown; requestId?: unknown; [key: string]: unknown };

export type ArtifactBridgeConnection = {
  /** Resolves once the page has loaded; rejects with `timeout`, or `failed` after `dispose`. */
  ready: Promise<void>;
  /** Resolves with the image, or rejects with an {@link ArtifactCaptureError}. */
  capture(options: ArtifactCaptureOptions, timeoutMs?: number): Promise<Blob>;
  /** Stops listening and fails anything still waiting. */
  dispose(): void;
};

/**
 * Listens to one frame's bridge. Connect before the frame's `srcdoc` loads so
 * `ready` is not missed, and call `dispose` when the frame goes away.
 */
export const connectArtifactBridge = (
  frame: HTMLIFrameElement,
  channel: string,
  { readyTimeoutMs = 20_000, onHeight }: { readyTimeoutMs?: number; onHeight?: (height: number) => void } = {},
): ArtifactBridgeConnection => {
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (image: Blob) => void; reject: (error: ArtifactCaptureError) => void }>();
  let markReady: () => void = () => undefined;
  let failReady: (error: ArtifactCaptureError) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // Avoid an unhandled rejection when nobody waits for readiness.
  ready.catch(() => undefined);
  const readyTimer = window.setTimeout(() => failReady(new ArtifactCaptureError("timeout")), readyTimeoutMs);

  const handleMessage = (event: MessageEvent) => {
    const data = event.data as BridgeMessage | null;
    if (!frame.contentWindow || event.source !== frame.contentWindow || !data || data.channel !== channel) return;
    if (data.type === MESSAGE.ready) {
      window.clearTimeout(readyTimer);
      markReady();
      return;
    }
    if (data.type === MESSAGE.height) {
      if (typeof data.height === "number" && Number.isFinite(data.height) && data.height >= 0) onHeight?.(data.height);
      return;
    }
    if (data.type !== MESSAGE.captureResult || typeof data.requestId !== "number") return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    if (data.ok === true && data.image instanceof Blob && data.image.type.startsWith("image/") && data.image.size > 0) {
      request.resolve(data.image);
    } else {
      request.reject(new ArtifactCaptureError(data.reason === "tainted" ? "tainted" : "failed"));
    }
  };
  window.addEventListener("message", handleMessage);

  return {
    /** Resolves once the page has loaded; rejects with `timeout`. */
    ready,
    capture(options: ArtifactCaptureOptions, timeoutMs = 30_000) {
      const target = frame.contentWindow;
      if (!target) return Promise.reject(new ArtifactCaptureError("failed"));
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise<Blob>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(requestId);
          reject(new ArtifactCaptureError("timeout"));
        }, timeoutMs);
        pending.set(requestId, {
          resolve: (image) => {
            window.clearTimeout(timer);
            resolve(image);
          },
          reject: (error) => {
            window.clearTimeout(timer);
            reject(error);
          },
        });
        // The frame's origin is opaque, so it cannot be named as the target.
        target.postMessage({ ...options, channel, type: MESSAGE.capture, requestId }, "*");
      });
    },
    dispose() {
      window.clearTimeout(readyTimer);
      window.removeEventListener("message", handleMessage);
      failReady(new ArtifactCaptureError("failed"));
      for (const request of pending.values()) request.reject(new ArtifactCaptureError("failed"));
      pending.clear();
    },
  };
};
