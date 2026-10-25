// Pure CodeMirror Markdown formatting commands for the Jot editor format bar.
// Semantics follow the memos MemoEditor commands (toggleWrap, toggleLinePrefix,
// insertCodeBlock, insertLink, table insert/format). No React, no DOM.
import { EditorSelection, type EditorState, type StateCommand } from "@codemirror/state";

const LINK_PLACEHOLDER_URL = "url";
const URL_REGEX = /^(https?:\/\/[^\s]+)$/;

// `*x*` selected as `x` inside `**x**` belongs to the bold run, so it must not be unwrapped as italic.
const isPartOfLongerRun = (state: EditorState, outerFrom: number, outerTo: number, delimiter: string) => {
  const ch = delimiter[0]!;
  if (![...delimiter].every((c) => c === ch)) return false;
  return state.sliceDoc(outerFrom - 1, outerFrom) === ch && state.sliceDoc(outerTo, outerTo + 1) === ch;
};

/**
 * Surrounds inserted file references with blank lines, so images form their own paragraph and
 * render as a gallery instead of inline inside the surrounding text.
 */
export const padAsBlock = (doc: string, from: number, to: number, text: string) => {
  const head = doc.slice(0, from);
  const tail = doc.slice(to);
  const before = !head || head.endsWith("\n\n") ? "" : head.endsWith("\n") ? "\n" : "\n\n";
  const after = !tail || tail.startsWith("\n\n") ? "" : tail.startsWith("\n") ? "\n" : "\n\n";
  return `${before}${text}${after}`;
};

/**
 * Wraps the selection with `delimiter`, or removes it when the selection (or the text right
 * around it) is already wrapped. With an empty selection, inserts the pair around `placeholder`
 * and selects it.
 */
export const toggleWrap =
  (delimiter: string, placeholder = ""): StateCommand =>
  ({ state, dispatch }) => {
    const len = delimiter.length;
    const { from, to } = state.selection.main;
    const selected = state.sliceDoc(from, to);

    if (selected.length >= len * 2 && selected.startsWith(delimiter) && selected.endsWith(delimiter)) {
      const inner = selected.slice(len, -len);
      dispatch(state.update({
        changes: { from, to, insert: inner },
        selection: EditorSelection.range(from, from + inner.length),
        userEvent: "input",
      }));
      return true;
    }

    const before = state.sliceDoc(from - len, from);
    const after = state.sliceDoc(to, to + len);
    if (from >= len && before === delimiter && after === delimiter && !isPartOfLongerRun(state, from - len, to + len, delimiter)) {
      dispatch(state.update({
        changes: [{ from: from - len, to: from }, { from: to, to: to + len }],
        selection: EditorSelection.range(from - len, to - len),
        userEvent: "input",
      }));
      return true;
    }

    const inner = selected || placeholder;
    dispatch(state.update({
      changes: { from, to, insert: delimiter + inner + delimiter },
      selection: EditorSelection.range(from + len, from + len + inner.length),
      userEvent: "input",
    }));
    return true;
  };

/**
 * A selected URL becomes `[](url)` with the cursor inside the brackets; otherwise inserts
 * `[selection](url)` and selects the `url` placeholder.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  const selected = state.sliceDoc(from, to);
  if (URL_REGEX.test(selected.trim())) {
    dispatch(state.update({
      changes: { from, to, insert: `[](${selected})` },
      selection: EditorSelection.cursor(from + 1),
      userEvent: "input",
    }));
    return true;
  }
  const insert = `[${selected}](${LINK_PLACEHOLDER_URL})`;
  const urlStart = from + selected.length + 3;
  dispatch(state.update({
    changes: { from, to, insert },
    selection: EditorSelection.range(urlStart, urlStart + LINK_PLACEHOLDER_URL.length),
    userEvent: "input",
  }));
  return true;
};

export type LinePrefixKind = "heading" | "quote" | "bullet" | "ordered" | "task";

const INDENT = /^\s*/;
// Any block marker that a list toggle replaces: bullet/ordered list, task box.
const ANY_LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const LINE_PREFIX: Record<LinePrefixKind, { active: RegExp; replaces: RegExp; marker: (index: number) => string; indent: boolean }> = {
  heading: { active: /^##\s+/, replaces: /^#{1,6}\s+/, marker: () => "## ", indent: false },
  quote: { active: /^>\s?/, replaces: /^>\s?/, marker: () => "> ", indent: false },
  bullet: { active: /^[-*+]\s+(?!\[[ xX]\])/, replaces: ANY_LIST_MARKER, marker: () => "- ", indent: true },
  ordered: { active: /^\d+[.)]\s+/, replaces: ANY_LIST_MARKER, marker: (i) => `${i + 1}. `, indent: true },
  task: { active: /^[-*+]\s+\[[ xX]\]\s+/, replaces: ANY_LIST_MARKER, marker: () => "- [ ] ", indent: true },
};

/**
 * Toggles a block prefix on every non-blank line touched by the selection. When every line
 * already has it, the prefix is removed; otherwise it is added, replacing another marker of the
 * same family (`- x` → `1. x`, `# t` → `## t`).
 */
export const toggleLinePrefix =
  (kind: LinePrefixKind): StateCommand =>
  ({ state, dispatch }) => {
    const spec = LINE_PREFIX[kind];
    const { from, to } = state.selection.main;
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    let lines = Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i));
    if (lines.some((line) => line.text.trim())) lines = lines.filter((line) => line.text.trim());

    const parsed = lines.map((line) => {
      const indent = spec.indent ? INDENT.exec(line.text)![0] : "";
      const rest = line.text.slice(indent.length);
      return { indent, active: spec.active.exec(rest)?.[0] ?? "", replaced: spec.replaces.exec(rest)?.[0] ?? "" };
    });
    const remove = parsed.every((p) => p.active);
    const changeSet = state.changes(lines.map((line, i) => {
      const { indent, active, replaced } = parsed[i]!;
      const start = line.from + indent.length;
      return remove ? { from: start, to: start + active.length } : { from: start, to: start + replaced.length, insert: spec.marker(i) };
    }));
    const selection = from === to
      ? EditorSelection.cursor(changeSet.mapPos(from, 1))
      : EditorSelection.range(changeSet.mapPos(from, -1), changeSet.mapPos(to, 1));
    dispatch(state.update({ changes: changeSet, selection, scrollIntoView: true, userEvent: "input" }));
    return true;
  };

/** Wraps the selection (or an empty line for the cursor) in a fenced code block on its own lines. */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  const before = from === state.doc.lineAt(from).from ? "" : "\n";
  const after = to === state.doc.lineAt(to).to ? "" : "\n";
  const open = `${before}\`\`\`\n`;
  const start = from + open.length;
  dispatch(state.update({
    changes: { from, to, insert: `${open}${state.sliceDoc(from, to)}\n\`\`\`${after}` },
    selection: EditorSelection.range(start, start + to - from),
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
};

/**
 * Inserts a `rows` × `cols` GFM table (rows include the header row) in place of the selection,
 * with the cursor in the first header cell. Blank lines separate it from surrounding text so
 * neither the previous paragraph nor the following line is parsed into the table.
 */
export const insertTable =
  (rows: number, cols: number): StateCommand =>
  ({ state, dispatch }) => {
    const { from, to } = state.selection.main;
    const startLine = state.doc.lineAt(from);
    const endLine = state.doc.lineAt(to);
    const row = (cell: string) => `|${` ${cell} |`.repeat(cols)}`;
    const empty = row("   ");
    const table = [empty, row("---"), ...Array.from({ length: Math.max(rows - 1, 0) }, () => empty)].join("\n");
    const hasTextBefore = state.sliceDoc(startLine.from, from).trim() !== "";
    const hasTextAfter = state.sliceDoc(to, endLine.to).trim() !== "";
    const prevLineHasText = startLine.number > 1 && state.doc.line(startLine.number - 1).text.trim() !== "";
    const nextLineHasText = endLine.number < state.doc.lines && state.doc.line(endLine.number + 1).text.trim() !== "";
    const lead = hasTextBefore ? "\n\n" : prevLineHasText ? "\n" : "";
    const tail = hasTextAfter ? "\n\n" : nextLineHasText ? "\n" : "";
    const cursor = from + lead.length + 2;
    dispatch(state.update({
      changes: { from, to, insert: lead + table + tail },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      userEvent: "input",
    }));
    return true;
  };

type Cell = { from: number; to: number };

/**
 * Splits a row the way the GFM parser does: unescaped pipes separate cells, and a leading or
 * trailing pipe does not open an extra empty cell. Offsets are relative to `text`.
 */
const splitRow = (text: string): Cell[] => {
  const cells: Cell[] = [];
  let cellFrom = 0;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && !escaped) {
      cells.push({ from: cellFrom, to: i });
      cellFrom = i + 1;
    }
    escaped = !escaped && text[i] === "\\";
  }
  cells.push({ from: cellFrom, to: text.length });
  const isBlank = (cell: Cell) => text.slice(cell.from, cell.to).trim() === "";
  if (cells.length > 1 && isBlank(cells[0]!) && text.trimStart().startsWith("|")) cells.shift();
  if (cells.length > 1 && isBlank(cells[cells.length - 1]!)) cells.pop();
  return cells;
};

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// East Asian Wide and Fullwidth blocks (UAX #11) not covered by the emoji check below.
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
const ZERO_WIDTH_REGEX = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/** Monospace display width: wide CJK characters and emoji take 2 columns, combining marks 0. */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const code = segment.codePointAt(0)!;
    if (EMOJI_REGEX.test(segment) || WIDE_RANGES.some(([start, end]) => code >= start && code <= end)) width += 2;
    else if (!ZERO_WIDTH_REGEX.test(segment)) width += 1;
  }
  return width;
};

type Alignment = "none" | "left" | "center" | "right";

const padCell = (text: string, width: number, align: Alignment) => {
  const space = width - displayWidth(text);
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center") return " ".repeat(Math.floor(space / 2)) + text + " ".repeat(Math.ceil(space / 2));
  return text + " ".repeat(space);
};

const delimiterCell = (width: number, align: Alignment) => {
  if (align === "left") return `:${"-".repeat(width - 1)}`;
  if (align === "right") return `${"-".repeat(width - 1)}:`;
  if (align === "center") return `:${"-".repeat(width - 2)}:`;
  return "-".repeat(width);
};

/**
 * Formats the GFM table at the cursor: outer pipes, one space of padding, every column padded to
 * its widest cell (by display width, at least 3) following its alignment marker. Cell content is
 * unchanged, so the rendered table stays the same. Returns false outside a table.
 */
export const formatTable: StateCommand = ({ state, dispatch }) => {
  const { head } = state.selection.main;
  const cursorLine = state.doc.lineAt(head);
  if (!cursorLine.text.includes("|")) return false;
  let first = cursorLine.number;
  let last = cursorLine.number;
  while (first > 1 && state.doc.line(first - 1).text.includes("|")) first--;
  while (last < state.doc.lines && state.doc.line(last + 1).text.includes("|")) last++;
  if (last - first < 1 || !DELIMITER_ROW.test(state.doc.line(first + 1).text)) return false;

  const lines = Array.from({ length: last - first + 1 }, (_, i) => state.doc.line(first + i));
  const rows = lines.map((line) => {
    const indent = INDENT.exec(line.text)![0];
    const body = line.text.slice(indent.length);
    const cells = splitRow(body);
    return { line, indent, body, cells, contents: cells.map((cell) => body.slice(cell.from, cell.to).trim()) };
  });
  const cols = rows[0]!.cells.length;
  const aligns = Array.from({ length: cols }, (_, col): Alignment => {
    const marker = rows[1]!.contents[col] ?? "";
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    return left && right ? "center" : left ? "left" : right ? "right" : "none";
  });
  const widths = aligns.map((_, col) => Math.max(
    3,
    ...rows.filter((_, index) => index !== 1).map((row) => displayWidth(row.contents[col] ?? "")),
  ));

  // Caret offset within the rewritten cursor row; null when the caret sits outside every cell.
  let caretInRow: number | null = null;
  const changes = rows.map((row, rowIndex) => {
    const isDelimiter = rowIndex === 1;
    let text = `${row.indent}|`;
    const cellCount = Math.max(cols, row.cells.length);
    const caret = head - row.line.from - row.indent.length;
    for (let col = 0; col < cellCount; col++) {
      const content = row.contents[col] ?? "";
      const body = col >= cols ? content : isDelimiter ? delimiterCell(widths[col]!, aligns[col]!) : padCell(content, widths[col]!, aligns[col]!);
      const cell = row.cells[col];
      if (row.line.number === cursorLine.number && cell && caret >= cell.from && caret <= cell.to) {
        const raw = row.body.slice(cell.from, cell.to);
        const offset = Math.min(Math.max(caret - cell.from - (raw.length - raw.trimStart().length), 0), content.length);
        const lead = content && !isDelimiter ? body.length - body.trimStart().length : 0;
        caretInRow = text.length + 1 + lead + offset;
      }
      text += ` ${body} |`;
    }
    return { from: row.line.from, to: row.line.to, insert: text };
  });

  const changeSet = state.changes(changes);
  // Rewritten rows keep their start positions relative to each other, so map the row start.
  const selection = EditorSelection.cursor(caretInRow === null
    ? changeSet.mapPos(head)
    : changeSet.mapPos(cursorLine.from, -1) + caretInRow);
  dispatch(state.update({ changes: changeSet, selection, userEvent: "input" }));
  return true;
};
