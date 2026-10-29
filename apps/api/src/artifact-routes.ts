import { ARTIFACT_MAX_HTML_BYTES } from "@edgeever/shared";
import type { Hono } from "hono";
import type { AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { createHtmlArtifact } from "./artifact-service";
import { apiError, badRequest } from "./http-errors";
import { getActorLabel, getAuditActor, getWorkspaceId, hasScopes, requireScopes } from "./request-auth";

// Room for the multipart framing and the small text fields next to the file.
const MAX_CREATE_REQUEST_BYTES = ARTIFACT_MAX_HTML_BYTES + 1024 * 1024;

const parseTags = (value: FormDataEntryValue | null) => {
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) throw new Error("invalid tags");
  return parsed as string[];
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
    const auth = context.get("auth");

    try {
      const memo = await createHtmlArtifact(context, {
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
      return context.json({ memo }, 201);
    } catch (error) {
      if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
      throw error;
    }
  });
};
