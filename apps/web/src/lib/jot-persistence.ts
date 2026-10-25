import {
  markdownToDoc,
  resolveResourceUploadMimeType,
  SUPPORTED_IMAGE_MIME_TYPES,
  type MemoDetail,
} from "@edgeever/shared";
import i18next from "i18next";
import {
  analyzeMarkdownModeContent,
  createMarkdownModeSnapshot,
  docToEditableMarkdown,
  isMarkdownSourceUnchanged,
} from "@/components/editor/editor-mode-content";
import { isDesktopResourceRuntime } from "@/lib/desktop-resources";
import { uploadEditorResourceFile } from "@/lib/editor-resource-upload";
import { processFileUploadBatch } from "@/lib/file-batch";
import { compressImageForUpload } from "@/lib/image-compression";
import { localDb } from "@/lib/local-db";
import { resourceToMarkdown } from "@/lib/markdown-resource-paste";
import { isBrowserOffline } from "@/lib/network-status";
import type { JotPendingFile } from "@/components/jot/JotEditor";
import type { EdgeEverRepository } from "@/lib/repository";
import { notifySyncQueueChanged } from "@/lib/sync-events";

export const JOT_PENDING_PREFIX = "edgeever-jot-pending://";

export class JotUnsafeTableEditError extends Error {
  constructor(message = "Rich table cells cannot be safely edited as Markdown") {
    super(message);
    this.name = "JotUnsafeTableEditError";
  }
}

type JotRepository = Pick<
  EdgeEverRepository,
  "createMemo" | "updateMemo" | "deleteMemo" | "getMemo" | "uploadMemoResource" | "listResources"
>;

// `![label](edgeever-jot-pending://id)` or `[label](edgeever-jot-pending://id)`.
const PENDING_REFERENCE_PATTERN = /!?\[(?:\\.|[^\]\\\n])*\]\((edgeever-jot-pending:\/\/[^\s)]+)\)/g;
// The web repository creates notes under a temporary `local_` ID until the
// sync queue acknowledges them; the API cannot attach resources to that ID.
const WEB_LOCAL_MEMO_ID_PREFIX = "local_";
const REMOTE_MEMO_WAIT_MS = 20_000;
const REMOTE_MEMO_POLL_MS = 250;

export const getJotEditableMarkdown = (memo: MemoDetail): string => docToEditableMarkdown(memo.contentJson);

const replacePendingReferences = (markdown: string, replace: (url: string) => string) =>
  markdown.replace(PENDING_REFERENCE_PATTERN, (_match, url: string) => replace(url));

/** Pending files still referenced by the Markdown, in their first appearance order. */
const referencedPendingFiles = (markdown: string, pendingFiles: JotPendingFile[]) => {
  const byUrl = new Map(pendingFiles.map((pending) => [pending.url, pending]));
  const referenced = new Map<string, JotPendingFile>();
  for (const match of markdown.matchAll(PENDING_REFERENCE_PATTERN)) {
    const pending = byUrl.get(match[1]!);
    if (pending) referenced.set(pending.url, pending);
  }
  return [...referenced.values()];
};

/** Drop pending references, collapsing the blank lines they leave; other text stays byte-identical. */
const stripPendingReferences = (markdown: string) => {
  const stripped = replacePendingReferences(markdown, () => "");
  return stripped === markdown ? markdown : stripped.replace(/\n{3,}/g, "\n\n").trim();
};

const isImageFile = (file: File) => SUPPORTED_IMAGE_MIME_TYPES.has(resolveResourceUploadMimeType(file.name, file.type));

/**
 * Web notes keep a temporary `local_` ID until the sync queue acknowledges
 * the create; the API cannot attach resources to it. Online, ask the queue to
 * run and wait for the durable ID. Offline uploads stay queued under the local ID.
 */
const waitForRemoteMemo = async (repository: JotRepository, memo: MemoDetail): Promise<MemoDetail> => {
  if (!memo.id.startsWith(WEB_LOCAL_MEMO_ID_PREFIX) || isBrowserOffline()) return memo;
  notifySyncQueueChanged();
  const deadline = Date.now() + REMOTE_MEMO_WAIT_MS;
  while (Date.now() < deadline) {
    const mapping = await localDb.idMappings.filter((item) => item.temporaryId === memo.id).first();
    if (mapping) return (await repository.getMemo(mapping.remoteId)).memo;
    await new Promise((resolve) => setTimeout(resolve, REMOTE_MEMO_POLL_MS));
  }
  throw new Error("The note did not sync before its attachments could be uploaded");
};

/** Upload every pending file; any failure rejects so the caller can roll back. */
const uploadPendingFiles = async (
  repository: JotRepository,
  memoId: string,
  pendingFiles: JotPendingFile[],
  imageCompressionEnabled: boolean,
) => {
  const fileUrls = new Map(pendingFiles.map((pending) => [pending.file, pending.url]));
  const results = await processFileUploadBatch(
    pendingFiles.map((pending) => pending.file),
    async (file) => (imageCompressionEnabled && isImageFile(file) ? (await compressImageForUpload(file)).file : file),
    (uploadFile, file) => uploadEditorResourceFile({
      repository,
      memoId,
      file: uploadFile,
      isImage: isImageFile(file),
      // The app initializes the shared i18next instance; persistence must not import
      // the i18n bootstrap module, which touches `document` at load time.
      picGoCopy: {
        title: i18next.t("settings.picgo.failedTitle"),
        message: i18next.t("settings.picgo.failedMessage"),
        retry: i18next.t("settings.picgo.retry"),
        fallback: i18next.t("settings.picgo.fallback"),
        cancel: i18next.t("settings.picgo.cancel"),
      },
    }),
  );
  const uploaded = new Map<string, string>();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    uploaded.set(fileUrls.get(result.file)!, resourceToMarkdown(result.value, result.file.name));
  }
  return uploaded;
};

// Desktop-only modules stay lazily loaded, as in WorkspaceApp and EditorPane,
// so the Web bundle does not pull in the desktop sync runtime.
/** Desktop notes get their durable ID from sync; keep create, stage and update together. */
const pauseDesktopSync = async () => isDesktopResourceRuntime()
  ? (await import("@/lib/desktop-sync")).pauseDesktopSyncForImport()
  : null;

const discardCreatedMemo = (repository: JotRepository, memoId: string) => isDesktopResourceRuntime()
  ? import("@/lib/desktop-repository").then(({ cancelPendingDesktopImportMemo }) => cancelPendingDesktopImportMemo(memoId))
  : repository.deleteMemo(memoId, true);

export const submitJotCapture = async (input: {
  repository: JotRepository;
  notebookId: string;
  markdown: string;
  tags: string[];
  pendingFiles: JotPendingFile[];
  imageCompressionEnabled: boolean;
}): Promise<MemoDetail> => {
  const { repository, notebookId, markdown, tags } = input;
  const files = referencedPendingFiles(markdown, input.pendingFiles);
  if (files.length === 0) {
    const contentMarkdown = stripPendingReferences(markdown).trim();
    return (await repository.createMemo({ notebookId, contentJson: markdownToDoc(contentMarkdown), contentMarkdown, tags })).memo;
  }

  const resumeDesktopSync = await pauseDesktopSync();
  try {
    const draftMarkdown = stripPendingReferences(markdown);
    let created = (await repository.createMemo({
      notebookId,
      contentJson: markdownToDoc(draftMarkdown),
      contentMarkdown: draftMarkdown,
      tags,
    })).memo;
    try {
      created = await waitForRemoteMemo(repository, created);
      const uploaded = await uploadPendingFiles(repository, created.id, files, input.imageCompressionEnabled);
      const contentMarkdown = replacePendingReferences(markdown, (url) => uploaded.get(url) ?? "").trim();
      return (await repository.updateMemo(created, {
        expectedRevision: created.revision,
        expectedContentHash: created.contentHash,
        editSessionId: `jot:${created.id}`,
        title: created.title ?? "",
        contentJson: markdownToDoc(contentMarkdown),
        contentMarkdown,
        tags,
      })).memo;
    } catch (error) {
      await discardCreatedMemo(repository, created.id).catch(() => undefined);
      throw error;
    }
  } finally {
    resumeDesktopSync?.();
  }
};

export const submitJotEdit = async (input: {
  repository: JotRepository;
  memo: MemoDetail;
  markdown: string;
  tags: string[];
  pendingFiles: JotPendingFile[];
  imageCompressionEnabled: boolean;
}): Promise<MemoDetail> => {
  const { repository, tags } = input;
  const snapshot = createMarkdownModeSnapshot(input.memo.id, input.memo.contentJson);
  const files = referencedPendingFiles(input.markdown, input.pendingFiles);

  if (files.length === 0 && isMarkdownSourceUnchanged(snapshot, input.memo.id, stripPendingReferences(input.markdown))) {
    if (JSON.stringify(tags) === JSON.stringify(input.memo.tags)) return input.memo;
    // The Markdown projection may be lossy; keep the authoritative rich document.
    return (await repository.updateMemo(input.memo, {
      expectedRevision: input.memo.revision,
      expectedContentHash: input.memo.contentHash,
      editSessionId: `jot:${input.memo.id}`,
      title: input.memo.title ?? "",
      contentJson: input.memo.contentJson,
      contentMarkdown: input.memo.contentMarkdown,
      tags,
    })).memo;
  }

  // Reject before uploading anything that could not be saved anyway.
  if (analyzeMarkdownModeContent(snapshot, input.memo.id, stripPendingReferences(input.markdown)).hasUnsafeRichTableEdit) {
    throw new JotUnsafeTableEditError();
  }

  const resumeDesktopSync = files.length > 0 ? await pauseDesktopSync() : null;
  try {
    let memo = input.memo;
    let markdown = stripPendingReferences(input.markdown);
    if (files.length > 0) {
      memo = await waitForRemoteMemo(repository, memo);
      const uploaded = await uploadPendingFiles(repository, memo.id, files, input.imageCompressionEnabled);
      markdown = replacePendingReferences(input.markdown, (url) => uploaded.get(url) ?? "").trim();
    }
    const analysis = analyzeMarkdownModeContent(
      memo.id === snapshot.memoId ? snapshot : { ...snapshot, memoId: memo.id },
      memo.id,
      markdown,
    );
    if (analysis.hasUnsafeRichTableEdit) throw new JotUnsafeTableEditError();
    return (await repository.updateMemo(memo, {
      expectedRevision: memo.revision,
      expectedContentHash: memo.contentHash,
      editSessionId: `jot:${memo.id}`,
      title: memo.title ?? "",
      contentJson: analysis.contentJson,
      contentMarkdown: markdown,
      tags,
    })).memo;
  } finally {
    resumeDesktopSync?.();
  }
};
