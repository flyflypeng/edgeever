import { describe, expect, test } from "bun:test";
import {
  buildTagTree,
  filterTagTree,
  findTagNode,
  normalizeTagPath,
  planTagRemoval,
  planTagRename,
  resolveTagNodeKey,
  splitTagDisplay,
  tagNodeIsSelected,
  tagNodeToggleName,
  tagTreeHasName,
} from "./tags.ts";

describe("tag path normalization", () => {
  test("trims every level and drops empty levels", () => {
    expect(normalizeTagPath("a / b")).toBe("a/b");
    expect(normalizeTagPath("a//b")).toBe("a/b");
    expect(normalizeTagPath("/a/")).toBe("a");
    expect(normalizeTagPath("  spaced  out  ")).toBe("spaced  out");
    expect(normalizeTagPath("#读书/小说")).toBe("读书/小说");
    expect(normalizeTagPath("  ")).toBe("");
    expect(normalizeTagPath("///")).toBe("");
  });

  test("keeps case, emoji and inner spacing as written", () => {
    expect(normalizeTagPath("Topic/Kernel")).toBe("Topic/Kernel");
    expect(normalizeTagPath("📚读书 / 小说")).toBe("📚读书/小说");
  });
});

describe("tag display parsing", () => {
  test("treats a leading pictographic emoji as the node icon", () => {
    expect(splitTagDisplay("📚读书")).toEqual({ icon: "📚", label: "读书" });
    expect(splitTagDisplay("读书")).toEqual({ icon: null, label: "读书" });
    expect(splitTagDisplay("1️⃣项目")).toEqual({ icon: "1️⃣", label: "项目" });
    expect(splitTagDisplay("🇯🇵旅行")).toEqual({ icon: "🇯🇵", label: "旅行" });
    expect(splitTagDisplay("👩‍💻工作")).toEqual({ icon: "👩‍💻", label: "工作" });
    expect(splitTagDisplay("👍🏽赞")).toEqual({ icon: "👍🏽", label: "赞" });
  });

  test("keeps an emoji-only level as the icon with an empty label", () => {
    expect(splitTagDisplay("📚")).toEqual({ icon: "📚", label: "" });
    expect(splitTagDisplay("📚 ")).toEqual({ icon: "📚", label: "" });
  });
});

describe("tag tree", () => {
  const activity = [
    { id: "m1", tags: ["读书/小说/科幻"] },
    { id: "m2", tags: ["读书/小说/推理", "Topic/Kernel"] },
    { id: "m3", tags: ["topic/kernel", "读书"] },
    { id: "m4", tags: ["📚读书/漫画"] },
  ];

  test("creates intermediate levels and merges case and spacing variants", () => {
    const tree = buildTagTree(activity);
    // Sorting ignores the leading emoji, so the two "读书" nodes tie and fall
    // back to the full level, where the emoji sorts first.
    expect(tree.map((node) => node.key)).toEqual(["topic", "📚读书", "读书"]);
    const topic = tree[0];
    expect(topic.label).toBe("topic");
    expect(topic.children.map((node) => node.key)).toEqual(["topic/kernel"]);
    const kernel = topic.children[0];
    expect(kernel.names).toEqual(["Topic/Kernel", "topic/kernel"]);
    expect(kernel.subtreeNames).toEqual(["Topic/Kernel", "topic/kernel"]);
    expect(kernel.count).toBe(2);
  });

  test("counts each subtree by distinct memos", () => {
    const tree = buildTagTree(activity);
    const reading = tree.find((node) => node.key === "读书");
    expect(reading.count).toBe(3);
    expect(reading.children.map((node) => node.key)).toEqual(["读书/小说"]);
    const fiction = reading.children[0];
    expect(fiction.count).toBe(2);
    expect(fiction.children.map((node) => node.key)).toEqual(["读书/小说/推理", "读书/小说/科幻"]);
    const emoji = tree.find((node) => node.key === "📚读书");
    expect(emoji.icon).toBe("📚");
    expect(emoji.label).toBe("读书");
    expect(emoji.count).toBe(1);
  });

  test("sorts levels with numeric order and ignores a leading emoji", () => {
    const tree = buildTagTree([
      { id: "a", tags: ["10_x"] },
      { id: "b", tags: ["2_x"] },
      { id: "c", tags: ["📚zebra"] },
      { id: "d", tags: ["alpha"] },
    ]);
    expect(tree.map((node) => node.key)).toEqual(["2_x", "10_x", "alpha", "📚zebra"]);
  });

  test("leaves out memos without tags and resolves node keys from raw names", () => {
    const tree = buildTagTree([{ id: "a", tags: [] }, { id: "b", tags: ["Topic / Kernel"] }]);
    expect(tree.map((node) => node.key)).toEqual(["topic"]);
    expect(resolveTagNodeKey("Topic / Kernel")).toBe("topic/kernel");
    expect(tree[0].subtreeNames).toEqual(["Topic / Kernel"]);
  });
});

describe("tag rename plan", () => {
  const tree = buildTagTree([
    { id: "m1", tags: ["a"] },
    { id: "m2", tags: ["a/b"] },
    { id: "m3", tags: ["a/b/c"] },
  ]);
  const node = tree[0];

  test("rewrites every subtree name under the new path", () => {
    const plan = planTagRename(node, "x/y");
    expect(plan.ok).toBe(true);
    expect(plan.newKey).toBe("x/y");
    expect([...plan.operations].sort((left, right) => left.from.localeCompare(right.from))).toEqual([
      { from: "a", to: "x/y" },
      { from: "a/b", to: "x/y/b" },
      { from: "a/b/c", to: "x/y/b/c" },
    ]);
  });

  test("orders operations so a deeper move never swallows a pending source", () => {
    const into = buildTagTree([
      { id: "m1", tags: ["a"] },
      { id: "m2", tags: ["a/b"] },
    ]);
    // Renaming `a` to `a/b` must move the existing `a/b` out of the way first,
    // otherwise the second step would pick up the memo that was just renamed.
    const plan = planTagRename(into[0], "a/b");
    expect(plan.ok).toBe(true);
    expect(plan.operations).toEqual([
      { from: "a/b", to: "a/b/b" },
      { from: "a", to: "a/b" },
    ]);
  });

  test("orders operations so a shallower move never swallows a pending source", () => {
    const out = buildTagTree([
      { id: "m1", tags: ["a/b"] },
      { id: "m2", tags: ["a/b/c"] },
    ]);
    const plan = planTagRename(out[0].children[0], "a");
    expect(plan.ok).toBe(true);
    expect(plan.operations).toEqual([
      { from: "a/b", to: "a" },
      { from: "a/b/c", to: "a/c" },
    ]);
  });

  test("refuses an empty path and a path that would exceed the 80 character limit", () => {
    expect(planTagRename(node, "   ").ok).toBe(false);
    const shallow = buildTagTree([{ id: "m", tags: ["a"] }]);
    expect(planTagRename(shallow[0], "x".repeat(80)).ok).toBe(true);
    expect(planTagRename(shallow[0], "x".repeat(81)).ok).toBe(false);
    // The limit applies to every rewritten name, descendants included.
    const deep = buildTagTree([{ id: "m", tags: [`a/${"b".repeat(78)}`] }]);
    expect(planTagRename(deep[0], "y").ok).toBe(true);
    expect(planTagRename(deep[0], "yy").ok).toBe(false);
  });

  test("skips names that already match the target and reports merges", () => {
    const merged = buildTagTree([
      { id: "m1", tags: ["a"] },
      { id: "m2", tags: ["b"] },
    ]);
    const plan = planTagRename(merged[0], "b", { mergeTarget: { count: 1 } });
    expect(plan.ok).toBe(true);
    expect(plan.operations).toEqual([{ from: "a", to: "b" }]);
    expect(plan.mergesInto).toEqual({ count: 1 });
    expect(planTagRename(merged[0], "a").operations).toEqual([]);
  });

  test("removal lists every subtree name", () => {
    const plan = planTagRemoval(node);
    expect(plan.names).toEqual(["a", "a/b", "a/b/c"]);
    expect(plan.count).toBe(3);
  });
});

describe("tag tree selection helpers", () => {
  const tree = buildTagTree([
    { id: "m1", tags: ["📚读书/人文/历史"] },
    { id: "m2", tags: ["📚读书/小说/科幻"] },
    { id: "m3", tags: ["Topic/Kernel"] },
  ]);

  test("names a node after its stored spelling, falling back to the tree key", () => {
    const reading = tree.find((node) => node.key === "📚读书");
    expect(reading.names).toEqual([]);
    expect(tagNodeToggleName(reading)).toBe("📚读书");
    const history = findTagNode(tree, "📚读书/人文/历史");
    expect(tagNodeToggleName(history)).toBe("📚读书/人文/历史");
    const kernel = findTagNode(tree, "topic/kernel");
    expect(tagNodeToggleName(kernel)).toBe("Topic/Kernel");
  });

  test("matches a selected tag against every stored spelling of a node", () => {
    const kernel = findTagNode(tree, "topic/kernel");
    expect(tagNodeIsSelected(kernel, new Set(["topic/kernel"]))).toBe(true);
    expect(tagNodeIsSelected(kernel, new Set(["other"]))).toBe(false);
    const reading = tree.find((node) => node.key === "📚读书");
    expect(tagNodeIsSelected(reading, new Set(["📚读书"]))).toBe(true);
  });

  test("keeps ancestors of a search hit and drops the rest", () => {
    const filtered = filterTagTree(tree, "科幻");
    expect(filtered.map((node) => node.key)).toEqual(["📚读书"]);
    expect(filtered[0].children.map((node) => node.key)).toEqual(["📚读书/小说"]);
    expect(filtered[0].children[0].children.map((node) => node.key)).toEqual(["📚读书/小说/科幻"]);
    expect(filterTagTree(tree, "读书").map((node) => node.key)).toEqual(["📚读书"]);
    // The lowercase tree key and the stored spelling both match.
    expect(filterTagTree(tree, "topic").map((node) => node.key)).toEqual(["topic"]);
    expect(filterTagTree(tree, "Topic").map((node) => node.key)).toEqual(["topic"]);
    expect(filterTagTree(tree, "  ")).toEqual(tree);
    expect(filterTagTree(tree, "没有这个标签")).toEqual([]);
  });

  test("reports whether a name already exists anywhere in the tree", () => {
    expect(tagTreeHasName(tree, "📚读书/人文/历史")).toBe(true);
    expect(tagTreeHasName(tree, "topic/kernel")).toBe(true);
    expect(tagTreeHasName(tree, "📚读书")).toBe(false);
  });
});
