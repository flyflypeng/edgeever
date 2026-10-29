import { ARTIFACT_MAX_HTML_BYTES, type MemoDetail } from "@edgeever/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { ARTIFACT_THUMBNAIL_MIME_TYPES, createHtmlArtifact, replaceHtmlArtifactContent, setArtifactThumbnail } from "./artifact-service";
import { apiError, badRequest } from "./http-errors";
import { getActorLabel, getAuditActor, getWorkspaceId, hasScopes, requireScopes } from "./request-auth";
import { MAX_IMAGE_UPLOAD_BYTES } from "./resource-service";

// Room for the multipart framing and the small text fields next to the file.
const MAX_CREATE_REQUEST_BYTES = ARTIFACT_MAX_HTML_BYTES + 1024 * 1024;
const MAX_THUMBNAIL_REQUEST_BYTES = MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024;

const unsupportedThumbnail = (context: Context<AppEnv>) =>
  apiError(context, "unsupported_media_type", "Thumbnails must be WebP, PNG or JPEG images.", 415);

/**
 * Attaches the optional `thumbnail` sent with a create or replace. The page is
 * already saved by then, so a thumbnail that cannot be stored only leaves the
 * card stale for a client to regenerate; failing would make callers retry the
 * whole import.
 */
const attachUploadedThumbnail = async (context: Context<AppEnv>, memo: MemoDetail, thumbnail: File | null) => {
  if (!thumbnail || !memo.artifact) return memo;
  return setArtifactThumbnail(context, {
    workspaceId: getWorkspaceId(context),
    memoId: memo.id,
    bytes: new Uint8Array(await thumbnail.arrayBuffer()),
    mimeType: thumbnail.type,
    filename: thumbnail.name || "thumbnail",
    sourceSha256: memo.artifact.sha256,
    actor: getAuditActor(context),
    actorLabel: getActorLabel(context),
  }).catch(() => memo);
};

const thumbnailField = (form: FormData) => {
  const thumbnail = form.get("thumbnail");
  return thumbnail instanceof File && thumbnail.size > 0 ? thumbnail : null;
};

const parseTags = (value: FormDataEntryValue | null) => {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) throw new Error("invalid tags");
  return parsed as string[];
};

const parseExpectedRevision = (value: FormDataEntryValue | null) => {
  if (value === null || value === "") return undefined;
  const revision = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(revision) || revision < 0) throw new Error("invalid expectedRevision");
  return revision;
};

export const registerArtifactRoutes = (app: Hono<AppEnv>) => {
  app.post("/api/v1/artifacts", async (context) => {
    const denied = requireScopes(context, "write:memos", "write:resources");
    if (denied) return denied;

    const declaredBytes = Number(context.req.header("Content-Length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CREATE_REQUEST_BYTES) {
      return apiError(context, "artifact_too_large", "HTML artifacts can be at most 20 MB.", 413);
    }

    const form = await context.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return badRequest(context, "Expected multipart form field named file.");
    const title = form.get("title");
    if (typeof title === "string" && title.trim().length > 160) return badRequest(context, "title can be at most 160 characters.");
    let tags: string[];
    try {
      tags = parseTags(form.get("tags"));
    } catch {
      return badRequest(context, "tags must be a JSON array of strings.");
    }
    const folderId = form.get("folderId");
    const locale = form.get("locale");
    const thumbnail = thumbnailField(form);
    if (thumbnail && !ARTIFACT_THUMBNAIL_MIME_TYPES[thumbnail.type]) return unsupportedThumbnail(context);
    const auth = context.get("auth");

    try {
      const created = await createHtmlArtifact(context, {
        workspaceId: getWorkspaceId(context),
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        folderId: typeof folderId === "string" ? folderId : null,
        title: typeof title === "string" ? title : null,
        tags,
        source: { type: "upload" },
        locale: typeof locale === "string" && locale ? locale : context.req.header("accept-language"),
        actor: getAuditActor(context),
        actorLabel: getActorLabel(context),
        canCreateLibrary: Boolean(auth && hasScopes(auth, ["write:notebooks"])),
      });
      return context.json({ ...created, memo: await attachUploadedThumbnail(context, created.memo, thumbnail) }, 201);
    } catch (error) {
      if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
      throw error;
    }
  });

  app.put("/api/v1/artifacts/:id/content", async (context) => {
    const denied = requireScopes(context, "write:memos", "write:resources");
    if (denied) return denied;

    const declaredBytes = Number(context.req.header("Content-Length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CREATE_REQUEST_BYTES) {
      return apiError(context, "artifact_too_large", "HTML artifacts can be at most 20 MB.", 413);
    }

    const form = await context.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return badRequest(context, "Expected multipart form field named file.");
    let expectedRevision: number | undefined;
    try {
      expectedRevision = parseExpectedRevision(form.get("expectedRevision"));
    } catch {
      return badRequest(context, "expectedRevision must be a non-negative integer.");
    }
    const thumbnail = thumbnailField(form);
    if (thumbnail && !ARTIFACT_THUMBNAIL_MIME_TYPES[thumbnail.type]) return unsupportedThumbnail(context);

    try {
      const memo = await replaceHtmlArtifactContent(context, {
        workspaceId: getWorkspaceId(context),
        memoId: context.req.param("id"),
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        expectedRevision,
        source: { type: "upload" },
        actor: getAuditActor(context),
        actorLabel: getActorLabel(context),
      });
      return context.json({ memo: await attachUploadedThumbnail(context, memo, thumbnail) });
    } catch (error) {
      if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
      throw error;
    }
  });

  app.put("/api/v1/artifacts/:id/thumbnail", async (context) => {
    const denied = requireScopes(context, "write:memos", "write:resources");
    if (denied) return denied;

    const declaredBytes = Number(context.req.header("Content-Length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_THUMBNAIL_REQUEST_BYTES) {
      return apiError(context, "upload_too_large", "Image must be between 1 byte and 100 MiB.", 413);
    }

    const form = await context.req.raw.formData().catch(() => null);
    const image = form?.get("image");
    if (!form || !(image instanceof File)) return badRequest(context, "Expected multipart form field named image.");
    const sourceSha256 = form.get("sourceSha256");
    if (typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
      return badRequest(context, "sourceSha256 must be the SHA-256 of the HTML the image was rendered from.");
    }

    try {
      const memo = await setArtifactThumbnail(context, {
        workspaceId: getWorkspaceId(context),
        memoId: context.req.param("id"),
        bytes: new Uint8Array(await image.arrayBuffer()),
        mimeType: image.type,
        filename: image.name || "thumbnail",
        sourceSha256,
        actor: getAuditActor(context),
        actorLabel: getActorLabel(context),
      });
      return context.json({ memo });
    } catch (error) {
      if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
      throw error;
    }
  });
};
