import { describe, expect, test } from "bun:test";
import { padAsBlock } from "./jot-editor-commands.ts";

describe("padAsBlock", () => {
  test("separates a reference from surrounding text with blank lines", () => {
    expect(padAsBlock("text", 4, 4, "![a](u)")).toBe("\n\n![a](u)");
    expect(padAsBlock("ab", 1, 1, "![a](u)")).toBe("\n\n![a](u)\n\n");
    expect(padAsBlock("text\n", 5, 5, "![a](u)")).toBe("\n![a](u)");
  });

  test("adds nothing where a paragraph break already exists", () => {
    expect(padAsBlock("", 0, 0, "![a](u)")).toBe("![a](u)");
    expect(padAsBlock("text\n\n", 6, 6, "![a](u)")).toBe("![a](u)");
    expect(padAsBlock("\n\nnext", 0, 0, "![a](u)")).toBe("![a](u)");
  });
});
