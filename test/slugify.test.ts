import { describe, expect, it } from "vitest";
import { slugify } from "../extensions/llm-wiki/lib/utils.js";

describe("slugify", () => {
  it("should keep Unicode letters and numbers", () => {
    expect(slugify("中文标题")).toBe("中文标题");
    expect(slugify("Hello 世界")).toBe("hello-世界");
    expect(slugify("中文 标题")).toBe("中文-标题");
  });

  it("should fall back when slug is empty", () => {
    expect(slugify("！！！")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
  });
});
