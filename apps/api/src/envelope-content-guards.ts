import {
  hasInfographicDocumentMarker,
  hasPosterDocumentMarker,
  hasTableDocumentMarker,
  parseDiagramDocument,
  parsePosterDocument,
  parseTableDocument,
} from "@edgeever/shared";

type Markdown = string | null | undefined;
type SaveRejection = { error: string; message: string; status: number };

/**
 * An envelope type whose body must only be changed through its own update path.
 * The ordinary memo save and MCP `update_memo` consult this list instead of
 * branching on each type, so a new type only needs one entry here.
 */
export type EnvelopeContentGuard = {
  /** Ordinary memo save (`PATCH /api/v1/memos/:id`, `POST .../save`). */
  save?: {
    /** The stored body belongs to this type. */
    protects: (markdown: Markdown) => boolean;
    /** The new body may replace a protected one. */
    accepts: (markdown: Markdown) => boolean;
    rejected: SaveRejection;
    /** Rejects a new body that carries this type's marker but does not parse, whatever the stored body is. */
    invalid?: SaveRejection & { hasMarker: (markdown: Markdown) => boolean };
  };
  /** MCP `update_memo` with `contentMarkdown`; rejected with status 400. */
  updateMemo?: {
    protects: (markdown: Markdown) => boolean;
    code: string;
    message: string;
  };
};

// Order is the order checks run in when one body matches several entries.
export const ENVELOPE_CONTENT_GUARDS: EnvelopeContentGuard[] = [
  {
    updateMemo: {
      protects: (markdown) => Boolean(parseDiagramDocument(markdown)),
      code: "diagram_update_required",
      message: "Diagram content cannot be replaced through update_memo. Use update_diagram for semantic changes.",
    },
  },
  {
    save: {
      protects: hasPosterDocumentMarker,
      accepts: (markdown) => Boolean(parsePosterDocument(markdown)),
      rejected: { error: "poster_update_required", message: "Poster source must be edited on a supported client.", status: 409 },
      invalid: { hasMarker: hasPosterDocumentMarker, error: "invalid_poster", message: "Invalid poster source.", status: 400 },
    },
    updateMemo: {
      protects: hasPosterDocumentMarker,
      code: "poster_update_required",
      message: "Poster content cannot be replaced through update_memo. Use get_poster then update_poster.",
    },
  },
  {
    save: {
      protects: (markdown) => Boolean(parseTableDocument(markdown)),
      accepts: (markdown) => Boolean(parseTableDocument(markdown)),
      rejected: { error: "table_update_required", message: "Structured table content must stay a structured table.", status: 409 },
    },
    updateMemo: {
      protects: hasTableDocumentMarker,
      code: "table_update_required",
      message: "Structured table content cannot be replaced through update_memo.",
    },
  },
  {
    updateMemo: {
      protects: hasInfographicDocumentMarker,
      code: "infographic_update_required",
      message: "Infographic content cannot be replaced through update_memo.",
    },
  },
];

export const findSaveContentRejection = (currentMarkdown: string, nextMarkdown: string): SaveRejection | null => {
  for (const { save } of ENVELOPE_CONTENT_GUARDS) {
    if (!save) continue;
    if (save.protects(currentMarkdown) && !save.accepts(nextMarkdown)) return save.rejected;
    if (save.invalid?.hasMarker(nextMarkdown) && !save.accepts(nextMarkdown)) {
      const { error, message, status } = save.invalid;
      return { error, message, status };
    }
  }
  return null;
};

export const findUpdateMemoContentRejection = (currentMarkdown: string) =>
  ENVELOPE_CONTENT_GUARDS.find(({ updateMemo }) => updateMemo?.protects(currentMarkdown))?.updateMemo ?? null;
