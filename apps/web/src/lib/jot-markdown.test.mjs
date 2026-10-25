import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

// DOMPurify reads `ownerDocument`, `nodeType` and `parentNode` through
// Node.prototype getters; linkedom stores them as own fields. Expose them as
// accessors for the duration of this file, then restore linkedom's shape.
const linkedom = parseHTML("<!DOCTYPE html><html><head></head><body></body></html>");
const patchedNodeKeys = ["ownerDocument", "nodeType", "parentNode"];
const originalNodeDescriptors = patchedNodeKeys.map((key) => [key, Object.getOwnPropertyDescriptor(linkedom.Node.prototype, key)]);
for (const key of patchedNodeKeys) {
  const slot = Symbol(key);
  Object.defineProperty(linkedom.Node.prototype, key, {
    configurable: true,
    get() { return this[slot] ?? null; },
    set(value) { this[slot] = value; },
  });
}
const BaseParser = linkedom.DOMParser;
const wrapDocument = (html) => `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
const createDocument = () => new BaseParser().parseFromString(wrapDocument(""), "text/html");
Object.defineProperty(linkedom.document, "implementation", {
  value: { createHTMLDocument: createDocument, createDocument },
});
const windowState = { edgeeverDesktop: undefined };
const testWindow = new Proxy(linkedom, {
  get(target, key) {
    if (key === "DOMParser") {
      // linkedom only builds <body> for full documents.
      return class { parseFromString(html) { return new BaseParser().parseFromString(wrapDocument(html), "text/html"); } };
    }
    if (key === "NodeFilter") {
      return target.NodeFilter ?? { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, SHOW_PROCESSING_INSTRUCTION: 64, SHOW_COMMENT: 128 };
    }
    if (key === "edgeeverDesktop") return windowState.edgeeverDesktop;
    if (key === "localStorage") return { getItem: () => null };
    return target[key];
  },
});
globalThis.window = testWindow;

afterAll(() => {
  for (const [key, descriptor] of originalNodeDescriptors) {
    if (descriptor) Object.defineProperty(linkedom.Node.prototype, key, descriptor);
    else delete linkedom.Node.prototype[key];
  }
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

const {
  getJotGalleryColumns,
  normalizeJotResourceUrl,
  renderJotMarkdownHtml,
  toggleJotTaskInDoc,
  stripJotLeadingTitle,
} = await import("./jot-markdown.ts");
const { markdownToDoc } = await import("@edgeever/shared");

const render = (markdown, options) => parseHTML(wrapDocument(renderJotMarkdownHtml(markdown, options))).document;

const withDesktop = (run) => {
  windowState.edgeeverDesktop = { isAvailable: true, apiBaseUrl: "" };
  try {
    return run();
  } finally {
    windowState.edgeeverDesktop = undefined;
  }
};

describe("card title", () => {
  test("drops only a leading heading that repeats the title", () => {
    expect(stripJotLeadingTitle("# Welcome\n\nBody", "Welcome")).toBe("Body");
    expect(stripJotLeadingTitle("## Welcome ##\nBody", "Welcome")).toBe("Body");
    expect(stripJotLeadingTitle("# Other\n\nBody", "Welcome")).toBe("# Other\n\nBody");
    expect(stripJotLeadingTitle("Intro\n# Welcome", "Welcome")).toBe("Intro\n# Welcome");
    expect(stripJotLeadingTitle("# Welcome", "")).toBe("# Welcome");
  });
});

describe("resource URL normalization", () => {
  test("maps native resource URLs to the API on the web", () => {
    expect(normalizeJotResourceUrl("edgeever-resource://resource/res-1")).toBe("/api/v1/resources/res-1/blob");
    expect(normalizeJotResourceUrl("/api/v1/resources/res-1/blob")).toBe("/api/v1/resources/res-1/blob");
    expect(normalizeJotResourceUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  test("maps API resource URLs to the native protocol on desktop", () => {
    withDesktop(() => {
      expect(normalizeJotResourceUrl("/api/v1/resources/res-1/blob")).toBe("edgeever-resource://resource/res-1");
      expect(normalizeJotResourceUrl("edgeever-staged://stage-1")).toBe("edgeever-staged://stage-1");
    });
  });

  test("rendered images use the runtime URL", () => {
    const web = render("![a](edgeever-resource://resource/res-1)");
    expect(web.querySelector("img").getAttribute("src")).toBe("/api/v1/resources/res-1/blob");

    withDesktop(() => {
      const desktop = render("![a](/api/v1/resources/res-2/blob)");
      expect(desktop.querySelector("img").getAttribute("src")).toBe("edgeever-resource://resource/res-2");
    });
  });

  test("keeps staged and blob preview URLs and resolves pending files", () => {
    const doc = render("![a](edgeever-staged://stage-1)\n![b](edgeever-jot-pending://p1)\n![c](edgeever-jot-pending://p2)", {
      resolvePendingUrl: (url) => (url === "edgeever-jot-pending://p1" ? "blob:http://localhost/abc" : null),
    });
    const sources = Array.from(doc.querySelectorAll("img")).map((image) => image.getAttribute("src"));
    expect(sources).toEqual(["edgeever-staged://stage-1", "blob:http://localhost/abc", "edgeever-jot-pending://p2"]);
  });

  test("renders resource links as file chips", () => {
    const doc = render("[report.pdf.zip](/api/v1/resources/res-3/blob) and [site](https://example.com)");
    const chip = doc.querySelector("a[data-jot-file]");
    expect(chip.getAttribute("href")).toBe("/api/v1/resources/res-3/blob");
    expect(chip.textContent).toContain("report.pdf.zip");
    const external = Array.from(doc.querySelectorAll("a")).find((link) => link.getAttribute("href") === "https://example.com");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("sanitization", () => {
  test("strips scripts, event handlers, frames, SVG, styles and forms", () => {
    const html = renderJotMarkdownHtml([
      "hello <script>alert(1)</script>",
      "",
      "<img src=\"x\" onerror=\"alert(1)\">",
      "",
      "<iframe src=\"https://evil.example\"></iframe>",
      "",
      "<svg><circle onload=\"alert(1)\"/></svg>",
      "",
      "<style>body{display:none}</style>",
      "",
      "<form><input name=\"x\"></form>",
      "",
      "<p style=\"color:red\" id=\"x\">styled</p>",
    ].join("\n"));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("id=\"x\"");
    expect(html).toContain("styled");
  });

  test("drops privileged and script URLs", () => {
    const doc = render("[a](javascript:alert(1)) [b](data:text/html,hi) [c](file:///etc/passwd)");
    for (const link of doc.querySelectorAll("a")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/^(?:javascript|data|file):/i);
    }
  });

  test("blob URLs never become navigable links", () => {
    const doc = render("[x](blob:http://localhost/abc)");
    expect(doc.querySelector("a").hasAttribute("href")).toBe(false);
  });
});

describe("image grouping", () => {
  test("uses 1, 2, 3, 2×2, then three columns", () => {
    expect([1, 2, 3, 4, 5, 9].map(getJotGalleryColumns)).toEqual([1, 2, 3, 2, 3, 3]);
  });

  test("groups consecutive image lines and paragraphs into one gallery", () => {
    const doc = render("intro\n\n![a](/a.png)\n![b](/b.png)\n\n![c](/c.png)\n\noutro\n\n![d](/d.png)");
    const galleries = doc.querySelectorAll("[data-jot-gallery]");
    expect(Array.from(galleries).map((gallery) => gallery.getAttribute("data-jot-gallery"))).toEqual(["3", "1"]);
    const indexes = Array.from(doc.querySelectorAll("[data-jot-image-index]")).map((button) => button.getAttribute("data-jot-image-index"));
    expect(indexes).toEqual(["0", "1", "2", "3"]);
  });

  test("treats EdgeEver gallery markers as part of the run", () => {
    const doc = render("<!-- edgeever:image-gallery fit=height layout=2 -->\n\n![a](/a.png)\n\n![b](/b.png)\n\n<!-- /edgeever:image-gallery -->");
    expect(doc.querySelectorAll("[data-jot-gallery]").length).toBe(1);
    expect(doc.querySelector("[data-jot-gallery]").getAttribute("data-jot-gallery")).toBe("2");
    expect(doc.body.innerHTML).not.toContain("edgeever:image-gallery");
  });

  test("moves images out of text paragraphs into a gallery after the text", () => {
    const doc = render("真实图片测试![a](/a.png)\n![b](/b.png)\n\nnext");
    const gallery = doc.querySelector("[data-jot-gallery]");
    expect(gallery?.getAttribute("data-jot-gallery")).toBe("2");
    expect(gallery?.previousElementSibling?.textContent).toBe("真实图片测试");
    expect(gallery?.nextElementSibling?.textContent).toBe("next");
    expect(doc.querySelector("p img")).toBeNull();
  });
});

describe("task lists", () => {
  test("renders interactive task toggles in document order", () => {
    const doc = render("- [ ] a\n- [x] b\n  - [ ] c", { interactiveTasks: true, toggleTaskLabel: "Toggle" });
    const toggles = Array.from(doc.querySelectorAll("[data-jot-task-index]"));
    expect(toggles.map((toggle) => [toggle.getAttribute("data-jot-task-index"), toggle.getAttribute("aria-checked")]))
      .toEqual([["0", "false"], ["1", "true"], ["2", "false"]]);
  });

  test("toggles the matching task item in the document", () => {
    const doc = markdownToDoc("- [ ] a\n- [x] b\n  - [ ] c");
    const toggled = toggleJotTaskInDoc(doc, 2);
    const checked = [];
    const visit = (node) => {
      if (node.type === "taskItem") checked.push(node.attrs.checked);
      node.content?.forEach(visit);
    };
    visit(toggled);
    expect(checked).toEqual([false, true, true]);
    expect(toggleJotTaskInDoc(doc, 5)).toBeNull();
  });
});
