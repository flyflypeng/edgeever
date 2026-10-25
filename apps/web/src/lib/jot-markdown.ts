import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";
import { Marked, type Token, type Tokens } from "marked";
import { getAttachmentFilenameFromLabel, isFileAttachmentLink, parseMemoLinkHref, resolveMemoContentMarkdown, type TiptapDoc } from "@edgeever/shared";
import { isDesktopResourceRuntime, toApiResourceUrl, toDesktopResourceDownloadUrl, toDesktopResourceUrl } from "@/lib/desktop-resources";

// Kept local so the renderer does not import the persistence layer (Dexie, uploads).
const JOT_PENDING_URL_PREFIX = "edgeever-jot-pending://";
const RESOURCE_URL_PATTERN = /^(?:\/api\/v1\/resources\/|edgeever-(?:resource|staged|jot-pending):\/\/)/i;
const GALLERY_MARKER_PATTERN = /^\s*<!--\s*\/?edgeever:image-gallery\b[^>]*-->\s*$/;
const HTML_COMMENT_PATTERN = /^\s*<!--[\s\S]*?-->\s*$/;
const EXTERNAL_LINK_PATTERN = /^(?:https?:|mailto:)/i;

/**
 * Typography for rendered jot Markdown. Shared by cards and the editor preview
 * so both show the same result.
 */
export const JOT_CONTENT_CLASS = [
  "min-w-0 break-words text-[14px] leading-[1.7] text-slate-800",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_p]:mb-2 [&_p]:mt-0",
  "[&_h1]:mb-1.5 [&_h1]:mt-2.5 [&_h1]:text-[16px] [&_h1]:font-semibold [&_h1]:leading-normal",
  "[&_h2]:mb-1.5 [&_h2]:mt-2.5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:leading-normal",
  "[&_h3]:mb-1.5 [&_h3]:mt-2.5 [&_h3]:text-[14.5px] [&_h3]:font-semibold [&_h3]:leading-normal",
  "[&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:text-[14px] [&_h4]:font-semibold",
  "[&_h5]:mb-1 [&_h5]:mt-2 [&_h5]:text-[14px] [&_h5]:font-semibold",
  "[&_h6]:mb-1 [&_h6]:mt-2 [&_h6]:text-[14px] [&_h6]:font-semibold",
  "[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-[22px] [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-[22px]",
  "[&_li>ul]:mb-0 [&_li>ol]:mb-0",
  "[&_ul.jot-task-list]:list-none [&_ul.jot-task-list]:pl-0.5",
  "[&_li.jot-task-item]:flex [&_li.jot-task-item]:flex-wrap [&_li.jot-task-item]:items-start [&_li.jot-task-item]:gap-x-2",
  "[&_li.jot-task-item>p]:mb-0 [&_li.jot-task-item>ul]:basis-full [&_li.jot-task-item>ul]:pl-6",
  "[&_li[data-checked=true]]:text-slate-400 [&_li[data-checked=false]]:text-slate-800",
  "[&_blockquote]:mb-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-slate-200 [&_blockquote]:py-0.5 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600",
  "[&_code]:rounded [&_code]:border [&_code]:border-slate-200 [&_code]:bg-slate-50 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px]",
  "[&_pre]:mb-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-slate-200 [&_pre]:bg-slate-50 [&_pre]:px-3 [&_pre]:py-2.5",
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_a:not(.jot-file-chip)]:text-slate-900 [&_a:not(.jot-file-chip)]:underline [&_a:not(.jot-file-chip)]:decoration-slate-300 [&_a:not(.jot-file-chip)]:underline-offset-[3px]",
  "[&_hr]:my-3 [&_hr]:border-slate-200",
  "[&_table]:mb-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[13px]",
  "[&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1",
  "[&_img.jot-inline-image]:inline-block [&_img.jot-inline-image]:max-h-60 [&_img.jot-inline-image]:max-w-full [&_img.jot-inline-image]:rounded-md",
].join(" ");

export type JotMarkdownRenderOptions = {
  /** Maps `edgeever-jot-pending://` references to a previewable (object) URL; empty keeps the reference. */
  resolvePendingUrl?: (url: string) => string | null | undefined;
  /** Render task checkboxes as toggle buttons carrying `data-jot-task-index`. */
  interactiveTasks?: boolean;
  /** Accessible label for task toggle buttons. */
  toggleTaskLabel?: string;
  /** Accessible label for image buttons; receives the image alt text. */
  viewImageLabel?: (alt: string) => string;
};

/** Resource URLs as stored in notes, mapped to what the current runtime can load. */
export const normalizeJotResourceUrl = (url: string) =>
  isDesktopResourceRuntime() ? toDesktopResourceUrl(url) : toApiResourceUrl(url);

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;")
  .replaceAll("'", "&#39;");

type RenderContext = {
  options: JotMarkdownRenderOptions;
  imageIndex: number;
  taskIndex: number;
};

// marked renders synchronously, so one module-level context per call is safe.
let context: RenderContext = { options: {}, imageIndex: 0, taskIndex: 0 };

const resolveUrl = (url: string) => {
  const trimmed = url.trim();
  if (trimmed.startsWith(JOT_PENDING_URL_PREFIX)) return context.options.resolvePendingUrl?.(trimmed) || trimmed;
  return normalizeJotResourceUrl(trimmed);
};

const renderImageButton = (token: Tokens.Image, buttonClass: string, imageClass: string) => {
  const index = context.imageIndex;
  context.imageIndex += 1;
  const alt = token.text ?? "";
  return `<button type="button" class="${buttonClass}" data-jot-image-index="${index}" aria-label="${escapeHtml(context.options.viewImageLabel?.(alt) ?? alt)}">`
    + `<img src="${escapeHtml(resolveUrl(token.href))}" alt="${escapeHtml(alt)}" loading="lazy" class="${imageClass}"></button>`;
};

/** Grid columns for a run of consecutive images: 1, 2, 3, 2×2, then 3 per row. */
export const getJotGalleryColumns = (count: number) => (count <= 1 ? 1 : count === 2 || count === 4 ? 2 : 3);

const GALLERY_COLUMN_CLASS: Record<number, string> = {
  1: "grid-cols-1 justify-items-start",
  2: "max-w-[412px] grid-cols-2",
  3: "grid-cols-3",
};

const renderGallery = (images: Tokens.Image[]) => {
  const columns = getJotGalleryColumns(images.length);
  const single = images.length === 1;
  const buttonClass = single
    ? "block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
    : "block aspect-square cursor-zoom-in overflow-hidden rounded-lg border border-slate-200 bg-slate-50";
  const imageClass = single
    ? "block max-h-[340px] w-auto max-w-full object-contain"
    : "block h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]";
  return `<div class="jot-gallery mb-2 mt-1 grid gap-1.5 ${GALLERY_COLUMN_CLASS[columns]}" data-jot-gallery="${images.length}">`
    + images.map((image) => renderImageButton(image, buttonClass, imageClass)).join("")
    + "</div>";
};

const getParagraphImages = (token: Token): Tokens.Image[] | null => {
  if (token.type !== "paragraph" || !Array.isArray(token.tokens)) return null;
  const images = token.tokens.filter((child): child is Tokens.Image => child.type === "image");
  if (images.length === 0) return null;
  return token.tokens.every((child) => child.type === "image" || child.type === "br" || (child.type === "text" && !String(child.text ?? "").trim()))
    ? images
    : null;
};

type GalleryToken = Tokens.Generic & { type: "jotGallery"; images: Tokens.Image[] };

/** Merge runs of image-only paragraphs (and EdgeEver gallery markers) into one gallery token. */
export const groupJotImageRuns = (tokens: Token[]): Token[] => {
  const result: Token[] = [];
  let run: Tokens.Image[] = [];
  let pendingGaps: Token[] = [];
  const flush = () => {
    if (run.length > 0) {
      const gallery: GalleryToken = { type: "jotGallery", raw: "", images: run };
      result.push(gallery);
    }
    run = [];
    result.push(...pendingGaps);
    pendingGaps = [];
  };

  for (const token of tokens) {
    const images = getParagraphImages(token);
    if (images) {
      // Blank lines between images do not break a run.
      pendingGaps = [];
      run.push(...images);
      continue;
    }
    // Text with images pasted into the same paragraph: keep the text, then show the images as a gallery.
    if (token.type === "paragraph" && Array.isArray(token.tokens) && token.tokens.some((child) => child.type === "image")) {
      flush();
      const inline = token.tokens.filter((child) => child.type !== "image");
      while (inline.length && (inline.at(-1)!.type === "br" || !inline.at(-1)!.raw.trim())) inline.pop();
      if (inline.length) result.push({ ...token, tokens: inline });
      run.push(...token.tokens.filter((child): child is Tokens.Image => child.type === "image"));
      continue;
    }
    // Blank lines and EdgeEver gallery markers between images do not break a run.
    if (run.length > 0 && (token.type === "space" || (token.type === "html" && GALLERY_MARKER_PATTERN.test(String(token.raw ?? ""))))) {
      pendingGaps.push(token);
      continue;
    }
    flush();
    result.push(token);
  }
  flush();
  return result;
};

const renderFileChip = (label: string, href: string) => {
  const filename = getAttachmentFilenameFromLabel(label) || label || "file";
  const target = toDesktopResourceDownloadUrl(resolveUrl(href), filename);
  const extension = /\.([a-z0-9]{1,5})$/i.exec(filename.trim())?.[1]?.toUpperCase() ?? "FILE";
  return `<a class="jot-file-chip mr-1.5 inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 align-middle text-[13px] text-slate-600 no-underline hover:bg-slate-100 hover:text-slate-900" href="${escapeHtml(target)}" data-jot-file="true">`
    + `<span class="rounded-sm bg-slate-200 px-1 text-[10px] font-semibold leading-4 text-slate-600">${escapeHtml(extension)}</span>`
    + `<span class="min-w-0 max-w-[14rem] truncate">${escapeHtml(filename)}</span></a>`;
};

const renderTaskBox = (checked: boolean) => {
  const index = context.taskIndex;
  context.taskIndex += 1;
  const box = checked
    ? "border-slate-800 bg-slate-800 text-white"
    : "border-slate-300 bg-card text-transparent";
  const check = "<span aria-hidden=\"true\" class=\"text-[10px] font-bold leading-none\">✓</span>";
  if (!context.options.interactiveTasks) {
    return `<span class="jot-task-box mt-[5px] inline-flex size-4 shrink-0 items-center justify-center rounded border ${box}" aria-hidden="true">${check}</span>`;
  }
  const label = context.options.toggleTaskLabel ?? "Toggle task";
  return `<button type="button" role="checkbox" aria-checked="${checked ? "true" : "false"}" aria-label="${escapeHtml(label)}" data-jot-task-index="${index}" class="jot-task-box mt-[5px] inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors hover:border-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 ${box}">${check}</button>`;
};

const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({
  extensions: [{
    name: "jotGallery",
    renderer: (token) => renderGallery((token as GalleryToken).images),
  }],
  renderer: {
    image(token) {
      return renderImageButton(token, "jot-image-button inline cursor-zoom-in align-middle", "jot-inline-image");
    },
    link(token) {
      const label = token.text ?? "";
      if (RESOURCE_URL_PATTERN.test(token.href.trim()) || isFileAttachmentLink(label, token.href)) return renderFileChip(label, token.href);
      const inner = this.parser.parseInline(token.tokens);
      const memoId = parseMemoLinkHref(token.href);
      const href = memoId ? token.href : resolveUrl(token.href);
      const title = token.title ? ` aria-description="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${memoId ? " data-jot-memo-link=\"true\"" : ""}${title}>${inner}</a>`;
    },
    checkbox(token) {
      return renderTaskBox(token.checked);
    },
    list(token) {
      const body = token.items.map((item) => this.listitem(item)).join("");
      const isTaskList = token.items.some((item) => item.task);
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && token.start !== 1 && token.start !== "" ? ` start="${Number(token.start)}"` : "";
      return `<${tag}${start}${isTaskList ? " class=\"jot-task-list\"" : ""}>\n${body}</${tag}>\n`;
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens);
      if (!item.task) return `<li>${body}</li>\n`;
      return `<li class="jot-task-item" data-checked="${item.checked ? "true" : "false"}">${body}</li>\n`;
    },
    html(token) {
      // Gallery markers and other comments are layout metadata, not content.
      return HTML_COMMENT_PATTERN.test(token.text) ? "" : token.text;
    },
  },
});

let purifier: DOMPurifyInstance | null = null;

const getPurifier = () => {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName !== "A") return;
    const href = node.getAttribute("href") ?? "";
    // Object URLs only serve pending image previews; never navigate to one.
    if (/^blob:/i.test(href)) {
      node.removeAttribute("href");
      return;
    }
    if (EXTERNAL_LINK_PATTERN.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifier = instance;
  return instance;
};

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "id", "name"],
  ADD_ATTR: ["loading"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|edgeever-resource|edgeever-staged|edgeever-jot-pending|blob):|[^:]*$)/i,
};

/**
 * Render jot Markdown to sanitized HTML: consecutive images become a gallery of
 * `[data-jot-image-index]` buttons, resource links become file chips, and
 * resource URLs are mapped for the current runtime.
 */
export function renderJotMarkdownHtml(source: string, options: JotMarkdownRenderOptions = {}): string {
  const previous = context;
  context = { options, imageIndex: 0, taskIndex: 0 };
  try {
    const tokens = groupJotImageRuns(markdown.lexer(source.replace(/\r\n?/g, "\n")));
    const html = markdown.parser(tokens);
    return getPurifier().sanitize(html, SANITIZE_CONFIG);
  } finally {
    context = previous;
  }
}

type DocNode = { type?: string; attrs?: Record<string, unknown>; content?: DocNode[] };

/**
 * Flip the `index`-th task item (document order, matching the order of
 * `data-jot-task-index` in rendered Markdown). Returns null when absent.
 */
export const toggleJotTaskInDoc = (doc: TiptapDoc, index: number): TiptapDoc | null => {
  let seen = 0;
  let found = false;
  const visit = (node: DocNode): DocNode => {
    if (found || !node || typeof node !== "object") return node;
    let next = node;
    if (node.type === "taskItem") {
      if (seen === index) {
        found = true;
        return { ...node, attrs: { ...node.attrs, checked: !node.attrs?.checked } };
      }
      seen += 1;
    }
    if (Array.isArray(node.content)) {
      const content = node.content.map(visit);
      if (content.some((child, childIndex) => child !== node.content![childIndex])) next = { ...node, content };
    }
    return next;
  };
  const result = visit(doc as DocNode) as TiptapDoc;
  return found ? result : null;
};

/** Markdown to show for a note; older rich saves may have only contentJson. */
export const getJotDisplayMarkdown = (memo: { contentJson: TiptapDoc; contentMarkdown: string }) =>
  memo.contentMarkdown.trim() ? memo.contentMarkdown : resolveMemoContentMarkdown(memo.contentJson, memo.contentMarkdown);

/** Drop a leading heading that only repeats the card title, so the title is not shown twice. */
export const stripJotLeadingTitle = (markdown: string, title: string) => {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return markdown;
  const match = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  return match && match[1].trim() === normalizedTitle ? markdown.slice(match[0].length).replace(/^\s*\n/, "") : markdown;
};
