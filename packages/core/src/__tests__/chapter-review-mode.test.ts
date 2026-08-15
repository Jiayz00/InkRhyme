import { describe, expect, it } from "vitest";
import { resolveChapterReviewMode } from "../models/book.js";

describe("resolveChapterReviewMode", () => {
  it("book-level reviewMode overrides project-level reviewMode", () => {
    expect(resolveChapterReviewMode(
      { writing: { reviewMode: "manual" } },
      { reviewMode: "auto" },
    )).toBe("manual");

    expect(resolveChapterReviewMode(
      { writing: { reviewMode: "auto" } },
      { reviewMode: "manual" },
    )).toBe("auto");
  });

  it("falls back to project-level reviewMode when book does not set one", () => {
    expect(resolveChapterReviewMode({}, { reviewMode: "manual" })).toBe("manual");
    expect(resolveChapterReviewMode(
      { writing: {} },
      { reviewMode: "manual" },
    )).toBe("manual");
  });

  it("defaults to auto when neither book nor project sets a reviewMode", () => {
    // Default kept as "auto" for quality: the audit→revise loop catches
    // continuity/length issues before the chapter is marked ready. For faster
    // single-chapter generation without audit, use the "fast-write" workflow
    // target or set `writing.reviewMode: "manual"` per book.
    expect(resolveChapterReviewMode({})).toBe("auto");
    expect(resolveChapterReviewMode({ writing: {} }, {})).toBe("auto");
  });
});
