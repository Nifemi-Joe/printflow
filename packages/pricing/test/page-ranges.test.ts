import { describe, expect, it } from "vitest";
import { PageRangeError, parsePageRanges } from "../src/index.js";

describe("parsePageRanges", () => {
  it("selects all pages when empty", () => {
    expect(parsePageRanges(undefined, 3)).toEqual([1, 2, 3]);
    expect(parsePageRanges("   ", 2)).toEqual([1, 2]);
  });

  it("parses ranges and singles, sorted", () => {
    expect(parsePageRanges("9-10, 1-3,5", 10)).toEqual([1, 2, 3, 5, 9, 10]);
    expect(parsePageRanges("4 - 4", 4)).toEqual([4]);
  });

  it.each([
    ["0", "numbered from 1"],
    ["3-1", "reversed"],
    ["1-11", "beyond"],
    ["1-3,2", "more than once"],
    ["1,,2", "empty segment"],
    ["1-2-3", "invalid"],
    ["a-b", "may only contain"],
    ["1;DROP TABLE", "may only contain"],
  ])("rejects %s", (input, message) => {
    expect(() => parsePageRanges(input, 10)).toThrow(PageRangeError);
    expect(() => parsePageRanges(input, 10)).toThrow(message);
  });

  it("rejects absurd input length", () => {
    expect(() => parsePageRanges("1,".repeat(400) + "1", 10)).toThrow("too long");
  });

  it("rejects invalid document page counts", () => {
    expect(() => parsePageRanges("", 0)).toThrow(PageRangeError);
    expect(() => parsePageRanges("", 2.5)).toThrow(PageRangeError);
  });
});
