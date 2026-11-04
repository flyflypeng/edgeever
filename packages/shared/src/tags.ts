/**
 * Hierarchical tags (see ADR-0003).
 *
 * A tag stays a plain string on the memo; levels are expressed with `/` inside
 * the text. Everything here is pure so the web app and the API share one copy
 * of the rules: path normalization, tree building, and the rename/removal plan
 * the client expands into exact tag operations.
 */

export const TAG_PATH_SEPARATOR = "/";
export const MAX_TAG_LENGTH = 80;

const LEADING_HASH = /^#/;
/** Matches the first code point, so ZWJ sequences and skin tones count as one emoji. */
const EMOJI_PICTOGRAPHIC = /^\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;

const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const firstGrapheme = (value: string) => {
  if (!value) return "";
  if (graphemeSegmenter) {
    for (const segment of graphemeSegmenter.segment(value)) return segment.segment;
    return "";
  }
  return Array.from(value)[0] ?? "";
};

const isEmojiCluster = (cluster: string) =>
  EMOJI_PICTOGRAPHIC.test(cluster) || REGIONAL_INDICATOR.test(cluster) || KEYCAP.test(cluster);

/** Tidies a written tag: trims every level, drops empty levels, strips one leading `#`. */
export const normalizeTagPath = (value: string) =>
  value
    .trim()
    .replace(LEADING_HASH, "")
    .split(TAG_PATH_SEPARATOR)
    .map((level) => level.trim())
    .filter(Boolean)
    .join(TAG_PATH_SEPARATOR);

/**
 * Matches a stored tag exactly, without path normalization. Lookup keys must
 * keep this shape so legacy spellings such as `a / b` stay renamable.
 */
export const matchTagText = (value: string) => value.trim().replace(LEADING_HASH, "");

/** Trimmed, de-duplicated lookup keys for exact tag matching. */
export const tagLookupKeys = (values: readonly string[]) =>
  Array.from(new Set(values.map(matchTagText).filter(Boolean)));

export const splitTagPath = (value: string) => normalizeTagPath(value).split(TAG_PATH_SEPARATOR).filter(Boolean);

export const tagPathLevels = (value: string) => splitTagPath(value).length;

/** Canonical tree key: the normalized path, lowercased level by level. */
export const resolveTagNodeKey = (value: string) =>
  splitTagPath(value).map((level) => level.toLowerCase()).join(TAG_PATH_SEPARATOR);

export const splitTagDisplay = (value: string): { icon: string | null; label: string } => {
  const cluster = firstGrapheme(value);
  if (!cluster || !isEmojiCluster(cluster)) return { icon: null, label: value.trim() };
  return { icon: cluster, label: value.slice(cluster.length).trimStart().trim() };
};

export type TagActivityItem = { id: string; tags: string[] };

export type TagTreeNode = {
  key: string;
  label: string;
  icon: string | null;
  level: string;
  /** Raw spellings that resolve to this exact node. */
  names: string[];
  /** Raw spellings of this node and all its descendants. */
  subtreeNames: string[];
  count: number;
  children: TagTreeNode[];
};

const nodeSortLabel = (node: TagTreeNode) => node.label || node.icon || node.level;

const compareTagNodes = (left: TagTreeNode, right: TagTreeNode, locale?: string) => {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byLabel = collator.compare(nodeSortLabel(left), nodeSortLabel(right));
  if (byLabel !== 0) return byLabel;
  return collator.compare(left.level, right.level);
};

const sortNodes = (nodes: TagTreeNode[], locale?: string): TagTreeNode[] => {
  nodes.sort((left, right) => compareTagNodes(left, right, locale));
  for (const node of nodes) sortNodes(node.children, locale);
  return nodes;
};

/**
 * Builds the tag tree from per-memo tag arrays. Memos sharing several tags in
 * one subtree are counted once; case and spacing variants form one node.
 */
export const buildTagTree = (items: readonly TagActivityItem[], locale?: string): TagTreeNode[] => {
  const nodes = new Map<string, TagTreeNode>();
  const memoIds = new Map<string, Set<string>>();

  for (const item of items) {
    for (const rawName of item.tags) {
      const levels = splitTagPath(rawName);
      if (levels.length === 0) continue;
      let key = "";
      let parent: TagTreeNode | null = null;
      for (const level of levels) {
        key = key ? `${key}${TAG_PATH_SEPARATOR}${level.toLowerCase()}` : level.toLowerCase();
        let node = nodes.get(key);
        if (!node) {
          const display = splitTagDisplay(level.toLowerCase());
          node = {
            key,
            level,
            label: display.label,
            icon: display.icon,
            names: [],
            subtreeNames: [],
            count: 0,
            children: [],
          };
          nodes.set(key, node);
          if (parent) parent.children.push(node);
        }
        if (!memoIds.has(key)) memoIds.set(key, new Set());
        memoIds.get(key)!.add(item.id);
        parent = node;
      }
      const leaf = nodes.get(key)!;
      if (!leaf.names.includes(rawName)) leaf.names.push(rawName);
    }
  }

  const roots: TagTreeNode[] = [];
  for (const node of nodes.values()) {
    node.count = memoIds.get(node.key)?.size ?? 0;
    if (!node.key.includes(TAG_PATH_SEPARATOR)) roots.push(node);
  }
  // Children are collected in insertion order; a parent always exists before its
  // children, so one pass over the map can roll descendant names upwards.
  for (const node of [...nodes.values()].reverse()) {
    const names = new Set(node.names);
    for (const child of node.children) {
      for (const name of child.subtreeNames) names.add(name);
    }
    node.subtreeNames = [...names];
  }

  return sortNodes(roots, locale);
};

/**
 * The tag text a picker writes when a node is checked: the stored spelling when
 * the node has one, otherwise the canonical path shown in the tree.
 */
export const tagNodeToggleName = (node: TagTreeNode) => node.names[0] ?? node.key;

const tagNodeNames = (node: TagTreeNode) => (node.names.length > 0 ? node.names : [node.key]);

export const tagNodeIsSelected = (node: TagTreeNode, selectedNames: ReadonlySet<string>) =>
  tagNodeNames(node).some((name) => selectedNames.has(name.toLowerCase()));

/** Whether a stored tag with this exact text exists; levels alone do not count. */
export const tagTreeHasName = (nodes: readonly TagTreeNode[], name: string) => {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return false;
  for (const node of nodes) {
    if (node.names.some((candidate) => candidate.toLowerCase() === wanted)) return true;
    if (tagTreeHasName(node.children, name)) return true;
  }
  return false;
};

/**
 * Prunes the tree to the nodes matching a search, keeping the ancestors that
 * lead to them so a hit never loses its path.
 */
export const filterTagTree = (nodes: readonly TagTreeNode[], query: string): TagTreeNode[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...nodes];

  const keep: TagTreeNode[] = [];
  for (const node of nodes) {
    const children = filterTagTree(node.children, query);
    const matches = node.key.includes(needle)
      || node.label.toLowerCase().includes(needle)
      || node.names.some((name) => name.toLowerCase().includes(needle));
    if (!matches && children.length === 0) continue;
    keep.push(children === node.children ? node : { ...node, children });
  }
  return keep;
};

export const findTagNode = (nodes: readonly TagTreeNode[], key: string): TagTreeNode | null => {
  for (const node of nodes) {
    if (node.key === key) return node;
    const found = findTagNode(node.children, key);
    if (found) return found;
  }
  return null;
};

export const tagNodeAncestorKeys = (key: string) => {
  const levels = key.split(TAG_PATH_SEPARATOR).filter(Boolean);
  return levels.slice(0, -1).map((_, index) => levels.slice(0, index + 1).join(TAG_PATH_SEPARATOR));
};

export type TagRenameOperation = { from: string; to: string };

export type TagRenamePlan =
  | { ok: false; reason: "empty_path" | "path_too_long"; operations: TagRenameOperation[] }
  | {
    ok: true;
    operations: TagRenameOperation[];
    newKey: string;
    mergesInto: { count: number } | null;
  };

/**
 * Plans the exact tag renames that move a node and its descendants under a new
 * path. Existing rename operations match one stored name at a time, so the
 * order matters: every operation shifts the level count by the same amount,
 * which keeps the plan acyclic and lets depth order resolve it.
 */
export const planTagRename = (
  node: TagTreeNode,
  newPath: string,
  options: { mergeTarget?: { count: number } | null } = {},
): TagRenamePlan => {
  const normalized = normalizeTagPath(newPath);
  if (!normalized) return { ok: false, reason: "empty_path", operations: [] };

  const nodeLevels = node.key.split(TAG_PATH_SEPARATOR).filter(Boolean).length;
  const newLevels = normalized.split(TAG_PATH_SEPARATOR);
  const operations: TagRenameOperation[] = [];

  for (const name of node.subtreeNames) {
    const rest = splitTagPath(name).slice(nodeLevels);
    const to = [...newLevels, ...rest].join(TAG_PATH_SEPARATOR);
    if (to.length > MAX_TAG_LENGTH) return { ok: false, reason: "path_too_long", operations: [] };
    if (to === name) continue;
    operations.push({ from: name, to });
  }

  const delta = newLevels.length - nodeLevels;
  if (delta !== 0) {
    operations.sort((left, right) => {
      const depth = tagPathLevels(left.from) - tagPathLevels(right.from);
      return delta > 0 ? -depth : depth;
    });
  }

  return {
    ok: true,
    operations,
    newKey: resolveTagNodeKey(normalized),
    mergesInto: options.mergeTarget ?? null,
  };
};

export const planTagRemoval = (node: TagTreeNode) => ({
  names: [...node.subtreeNames],
  count: node.count,
});
