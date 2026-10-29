import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArtifactCaptureError, type ArtifactBridgeConnection, type ArtifactCaptureOptions } from "@/lib/html-artifact-bridge";
import { downloadBlob, infographicExportBasename } from "@/lib/infographic-image-export";
import { cn } from "@/lib/utils";

type ExportFormat = ArtifactCaptureOptions["mimeType"];
type ExportArea = ArtifactCaptureOptions["area"];

const FORMATS: { mimeType: ExportFormat; label: string; extension: string }[] = [
  { mimeType: "image/png", label: "PNG", extension: "png" },
  { mimeType: "image/jpeg", label: "JPEG", extension: "jpg" },
  { mimeType: "image/webp", label: "WebP", extension: "webp" },
];

/**
 * Exports the page shown in the reader as an image through its sandbox
 * bridge. A failed capture explains why and never downloads a partial image.
 */
export function HtmlArtifactExportImageDialog({
  open,
  title,
  getBridge,
  onOpenChange,
}: {
  open: boolean;
  /** Names the file. */
  title: string;
  /** The bridge of the page currently shown, if it has one. */
  getBridge: () => ArtifactBridgeConnection | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>("image/png");
  const [area, setArea] = useState<ExportArea>("page");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportImage = async () => {
    const bridge = getBridge();
    const chosen = FORMATS.find((item) => item.mimeType === format)!;
    setError(null);
    setExporting(true);
    try {
      if (!bridge) throw new ArtifactCaptureError("failed");
      await bridge.ready;
      const image = await bridge.capture({ area, mimeType: format, quality: format === "image/png" ? undefined : 0.92 });
      // Browsers that cannot encode a format fall back to PNG silently.
      if (image.type !== format) {
        setError(t("htmlArtifact.exportFormatUnsupported", { format: chosen.label }));
        return;
      }
      downloadBlob(image, `${infographicExportBasename(title || t("htmlArtifact.name"))}.${chosen.extension}`);
      onOpenChange(false);
    } catch (caught) {
      const reason = caught instanceof ArtifactCaptureError ? caught.reason : "failed";
      setError(t(reason === "tainted" ? "htmlArtifact.exportTainted" : reason === "timeout" ? "htmlArtifact.exportTimeout" : "htmlArtifact.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const choice = (name: string, checked: boolean, label: string, onChange: () => void) => (
    <label
      key={label}
      className={cn(
        "flex h-9 cursor-pointer select-none items-center justify-center rounded-md border px-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-slate-900/15",
        checked ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200 text-slate-700 hover:bg-slate-50",
      )}
    >
      <input className="sr-only" type="radio" name={name} checked={checked} disabled={exporting} onChange={onChange} />
      {label}
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (exporting) return;
        if (next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md" data-html-artifact-export-image>
        <DialogHeader>
          <DialogTitle>{t("htmlArtifact.exportImage")}</DialogTitle>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-slate-700">{t("htmlArtifact.exportFormat")}</legend>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((item) => choice("html-artifact-export-format", format === item.mimeType, item.label, () => setFormat(item.mimeType)))}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-slate-700">{t("htmlArtifact.exportArea")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {choice("html-artifact-export-area", area === "page", t("htmlArtifact.exportAreaPage"), () => setArea("page"))}
            {choice("html-artifact-export-area", area === "viewport", t("htmlArtifact.exportAreaViewport"), () => setArea("viewport"))}
          </div>
        </fieldset>
        {error && <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-700">{error}</p>}
        <Button className="w-full" variant="solid" disabled={exporting} onClick={() => void exportImage()}>
          {exporting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t(exporting ? "htmlArtifact.exporting" : "htmlArtifact.exportAction")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
