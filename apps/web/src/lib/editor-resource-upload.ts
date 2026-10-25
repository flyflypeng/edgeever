import { resolveResourceUploadMimeType, type Resource } from "@edgeever/shared";
import { isDesktopResourceRuntime, stageDesktopResource, toDesktopResourceUrl } from "@/lib/desktop-resources";
import { shouldUploadWithPicGo, uploadImageWithPicGo, type PicGoFailureCopy } from "@/lib/picgo";
import type { EdgeEverRepository } from "@/lib/repository";
import { findMatchingMemoResource } from "@/lib/staged-resource-repair";

export type UploadedEditorResource = Pick<Resource, "kind" | "url" | "filename" | "mimeType" | "byteSize">;

/**
 * Upload one file that an editor is inserting into a note: fix the MIME type,
 * honor the PicGo preference for images, and on desktop fall back to an
 * already-cached resource or a staged file when the cloud upload fails.
 */
export const uploadEditorResourceFile = async ({
  repository,
  memoId,
  file,
  isImage,
  picGoCopy,
  isTargetCurrent,
}: {
  repository: Pick<EdgeEverRepository, "uploadMemoResource" | "listResources">;
  memoId: string;
  file: File;
  isImage: boolean;
  /** UI copy for the PicGo failure dialog. */
  picGoCopy: PicGoFailureCopy;
  /** PicGo or its failure dialog may outlive the original note; return false to abort. */
  isTargetCurrent?: () => boolean;
}): Promise<UploadedEditorResource> => {
  let uploadFile = file;
  const mimeType = resolveResourceUploadMimeType(uploadFile.name, uploadFile.type);
  if (mimeType !== uploadFile.type) uploadFile = new File([uploadFile], uploadFile.name, { type: mimeType, lastModified: uploadFile.lastModified });
  if (isImage && shouldUploadWithPicGo()) {
    const external = await uploadImageWithPicGo(uploadFile, picGoCopy);
    if (isTargetCurrent && !isTargetCurrent()) {
      throw new Error("The active note changed during image upload");
    }
    if (external) return external;
  }
  try {
    const resource = (await repository.uploadMemoResource(memoId, uploadFile)).resource;
    return { ...resource, url: toDesktopResourceUrl(resource.url) };
  } catch (error) {
    if (!isDesktopResourceRuntime()) throw error;
    const listed = await repository.listResources().catch(() => ({ resources: [] as Array<{ memoId?: string; url: string; filename?: string | null; kind?: string | null; mimeType?: string | null; byteSize?: number }> }));
    const existing = findMatchingMemoResource(
      listed.resources.filter((item) => item.memoId === memoId),
      uploadFile.name,
      isImage ? "image" : "attachment",
    );
    if (existing) {
      return {
        kind: isImage ? "image" as const : "attachment" as const,
        filename: existing.filename || uploadFile.name,
        mimeType: existing.mimeType || uploadFile.type || null,
        byteSize: existing.byteSize ?? uploadFile.size,
        url: toDesktopResourceUrl(existing.url),
      };
    }
    const staged = await stageDesktopResource(memoId, uploadFile);
    if (!staged) throw error;
    return {
      kind: isImage ? "image" as const : "attachment" as const,
      filename: uploadFile.name,
      mimeType: uploadFile.type || null,
      byteSize: uploadFile.size,
      url: `edgeever-staged://${staged.id}`,
    };
  }
};
