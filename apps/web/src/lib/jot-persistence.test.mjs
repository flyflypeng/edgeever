import { afterAll, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { markdownToDoc } from "@edgeever/shared";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
globalThis.window = Object.assign(new EventTarget(), { location: { hostname: "localhost", origin: "http://localhost" } });

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

const {
  JOT_PENDING_PREFIX,
  JotUnsafeTableEditError,
  getJotEditableMarkdown,
  submitJotCapture,
  submitJotEdit,
} = await import("./jot-persistence.ts");

const memoFrom = (id, markdown, overrides = {}) => ({
  id,
  notebookId: "inbox",
  title: null,
  excerpt: "",
  tags: [],
  isPinned: false,
  isArchived: false,
  isDeleted: false,
  revision: 1,
  contentHash: `hash-${id}`,
  contentJson: markdownToDoc(markdown),
  contentMarkdown: markdown,
  contentText: markdown,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...overrides,
});

const createRepository = (overrides = {}) => {
  const calls = { create: [], update: [], delete: [], upload: [] };
  let nextResource = 0;
  const repository = {
    createMemo: async (input) => {
      calls.create.push(input);
      return { memo: memoFrom("memo_1", input.contentMarkdown ?? "", { tags: input.tags ?? [] }) };
    },
    updateMemo: async (memo, input) => {
      calls.update.push({ memo, input });
      return { memo: { ...memo, ...input, revision: memo.revision + 1 }, queued: true };
    },
    deleteMemo: async (memoId, permanent) => {
      calls.delete.push({ memoId, permanent });
      return { ok: true };
    },
    getMemo: async () => { throw new Error("getMemo should not be called"); },
    uploadMemoResource: async (memoId, file) => {
      calls.upload.push({ memoId, file });
      nextResource += 1;
      return {
        resource: {
          id: `res_${nextResource}`,
          memoId,
          kind: file.type.startsWith("image/") ? "image" : "attachment",
          filename: file.name,
          mimeType: file.type,
          byteSize: file.size,
          url: `/api/v1/resources/res_${nextResource}/blob`,
        },
      };
    },
    listResources: async () => ({ resources: [], summary: {} }),
    ...overrides,
  };
  return { repository, calls };
};

const pending = (id, name, type) => ({ url: `${JOT_PENDING_PREFIX}${id}`, file: new File(["bytes"], name, { type }) });

describe("submitJotCapture", () => {
  test("creates the note once when there are no pending files", async () => {
    const { repository, calls } = createRepository();
    const memo = await submitJotCapture({
      repository, notebookId: "inbox", markdown: "Hello **jot**\n", tags: ["idea"], pendingFiles: [], imageCompressionEnabled: false,
    });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ notebookId: "inbox", title: "Hello jot", contentMarkdown: "Hello **jot**", tags: ["idea"] });
    expect(calls.create[0].contentJson).toEqual(markdownToDoc("Hello **jot**"));
    expect(calls.update).toHaveLength(0);
    expect(calls.upload).toHaveLength(0);
    expect(memo.id).toBe("memo_1");
  });

  test("creates without pending references, uploads, then saves the real resource URLs", async () => {
    const { repository, calls } = createRepository();
    const image = pending("a", "photo.png", "image/png");
    const attachment = pending("b", "brief.pdf", "application/pdf");
    const unused = pending("c", "removed.png", "image/png");
    const markdown = `Look\n\n![photo.png](${image.url})\n\n[brief.pdf](${attachment.url})`;

    const memo = await submitJotCapture({
      repository, notebookId: "inbox", markdown, tags: ["trip"], pendingFiles: [image, attachment, unused], imageCompressionEnabled: false,
    });

    expect(calls.create[0].contentMarkdown).toBe("Look");
    expect(calls.create[0].contentMarkdown).not.toContain(JOT_PENDING_PREFIX);
    expect(calls.upload.map((call) => call.file.name)).toEqual(["photo.png", "brief.pdf"]);
    expect(calls.upload.every((call) => call.memoId === "memo_1")).toBe(true);
    expect(calls.update).toHaveLength(1);
    const saved = calls.update[0].input;
    expect(saved.contentMarkdown).toBe("Look\n\n![photo.png](/api/v1/resources/res_1/blob)\n\n[brief.pdf](/api/v1/resources/res_2/blob)");
    expect(saved).toMatchObject({ expectedRevision: 1, expectedContentHash: "hash-memo_1", title: "Look", tags: ["trip"] });
    expect(saved.contentJson).toEqual(markdownToDoc(saved.contentMarkdown));
    expect(memo.contentMarkdown).toBe(saved.contentMarkdown);
    expect(calls.delete).toHaveLength(0);
  });

  test("permanently deletes the created note and rethrows when an upload fails", async () => {
    const failure = new Error("upload failed");
    const { repository, calls } = createRepository({
      uploadMemoResource: async () => { throw failure; },
    });
    const image = pending("a", "photo.png", "image/png");

    await expect(submitJotCapture({
      repository, notebookId: "inbox", markdown: `![photo.png](${image.url})`, tags: [], pendingFiles: [image], imageCompressionEnabled: false,
    })).rejects.toBe(failure);

    expect(calls.create).toHaveLength(1);
    expect(calls.update).toHaveLength(0);
    expect(calls.delete).toEqual([{ memoId: "memo_1", permanent: true }]);
  });
});

const richTableDocument = {
  type: "doc",
  content: [{
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "事项" }] }] }],
      },
      {
        type: "tableRow",
        content: [{
          type: "tableCell",
          content: [{
            type: "taskList",
            content: [{
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [{ type: "text", text: "待办" }] }],
            }],
          }],
        }],
      },
    ],
  }],
};

describe("submitJotEdit", () => {
  test("only updates tags and keeps the rich document when the source is unchanged", async () => {
    const { repository, calls } = createRepository();
    const memo = memoFrom("memo_rich", "", { contentJson: richTableDocument, contentMarkdown: "stored", tags: ["old"] });

    await submitJotEdit({
      repository, memo, markdown: getJotEditableMarkdown(memo), tags: ["old", "new"], pendingFiles: [], imageCompressionEnabled: false,
    });

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].input.contentJson).toEqual(richTableDocument);
    expect(calls.update[0].input.contentMarkdown).toBe("stored");
    expect(calls.update[0].input.tags).toEqual(["old", "new"]);
    expect(calls.upload).toHaveLength(0);
  });

  test("throws JotUnsafeTableEditError for an unsafe rich table edit without saving", async () => {
    const { repository, calls } = createRepository();
    const memo = memoFrom("memo_rich", "", { contentJson: richTableDocument });
    const markdown = getJotEditableMarkdown(memo).replace("| - [ ] 待办 |", "");

    await expect(submitJotEdit({
      repository, memo, markdown, tags: [], pendingFiles: [], imageCompressionEnabled: false,
    })).rejects.toBeInstanceOf(JotUnsafeTableEditError);
    expect(calls.update).toHaveLength(0);
  });

  test("uploads pending files before saving the edited Markdown", async () => {
    const { repository, calls } = createRepository();
    const memo = memoFrom("memo_plain", "Before");
    const image = pending("x", "shot.png", "image/png");

    await submitJotEdit({
      repository, memo, markdown: `After\n\n![shot.png](${image.url})`, tags: ["t"], pendingFiles: [image], imageCompressionEnabled: false,
    });

    expect(calls.upload.map((call) => call.memoId)).toEqual(["memo_plain"]);
    expect(calls.update[0].input.contentMarkdown).toBe("After\n\n![shot.png](/api/v1/resources/res_1/blob)");
    expect(calls.update[0].input.contentJson).toEqual(markdownToDoc("After\n\n![shot.png](/api/v1/resources/res_1/blob)"));
  });

  test("follows the new first line unless the user typed a title", async () => {
    const cases = [
      { title: null, expected: "After" },
      { title: "无标题笔记", expected: "After" },
      { title: "Before", expected: "After" },
      { title: "手动标题", expected: "手动标题" },
    ];
    for (const { title, expected } of cases) {
      const { repository, calls } = createRepository();
      await submitJotEdit({
        repository, memo: memoFrom("memo_plain", "Before\nBody", { title }), markdown: "After\nBody", tags: [], pendingFiles: [], imageCompressionEnabled: false,
      });
      expect(calls.update[0].input.title).toBe(expected);
    }
  });
});
