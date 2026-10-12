import { describe, expect, it } from "vitest";
import {
  batchTargets,
  buildOrQuery,
  matchTargetNames,
  planCountryBatches,
  quoteSearchTerm,
} from "../src/batching";

describe("query batching", () => {
  it("quotes phrases and operator words, and leaves simple tokens bare", () => {
    expect(quoteSearchTerm("Ada Lovelace")).toBe('"Ada Lovelace"');
    expect(quoteSearchTerm("from:example")).toBe("from:example");
    expect(quoteSearchTerm("OR")).toBe('"OR"');
    expect(quoteSearchTerm("  Tokyo  ")).toBe("Tokyo");
    expect(buildOrQuery(["Ada Lovelace", "from:example"])).toBe('"Ada Lovelace" OR from:example');
  });

  it("splits on the term cap and keeps order", () => {
    const targets = ["a", "b", "c", "d", "e"].map((query, index) => ({ id: index + 1, query }));
    const batches = batchTargets(targets, { maxTerms: 2, maxQueryChars: 500 });

    expect(batches.map((batch) => batch.map((target) => target.query))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits before the OR clause exceeds the character budget", () => {
    const targets = [
      { id: 1, query: "alpha" },
      { id: 2, query: "beta" },
    ];
    expect(buildOrQuery(["alpha", "beta"])).toBe("alpha OR beta");
    const batches = batchTargets(targets, { maxTerms: 10, maxQueryChars: 12 });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.map((target) => target.id)).toEqual([1]);
    expect(batches[1]?.map((target) => target.id)).toEqual([2]);
  });

  it("keeps one overlong term in its own batch", () => {
    const targets = [{ id: 7, query: "x".repeat(50) }];
    const batches = batchTargets(targets, { maxTerms: 3, maxQueryChars: 10 });
    expect(batches).toEqual([targets]);
  });

  it("returns no batches for an empty list", () => {
    expect(batchTargets([], { maxTerms: 5, maxQueryChars: 100 })).toEqual([]);
  });

  it("plans one OR group per provider without dropping targets", () => {
    let sequence = 0;
    const planned = planCountryBatches(
      [
        {
          id: 1,
          targets: [
            { id: 11, query: "alpha" },
            { id: 12, query: "beta" },
            { id: 13, query: "gamma" },
          ],
        },
        { id: 2, targets: [] },
      ],
      [
        { id: "twitterapi_io", source: "x" },
        { id: "google_news", source: "web" },
      ],
      { maxTerms: 2, maxQueryChars: 500 },
      () => `b${(sequence += 1)}`,
    );

    expect(planned.map((batch) => [batch.id, batch.providerId, batch.targetIds])).toEqual([
      ["b1", "twitterapi_io", [11, 12]],
      ["b2", "twitterapi_io", [13]],
      ["b3", "google_news", [11, 12]],
      ["b4", "google_news", [13]],
    ]);
    expect(planned.every((batch) => batch.countryId === 1)).toBe(true);
  });

  it("attributes a hit to the names that appear, otherwise to the whole batch", () => {
    const targets = [
      { name: "Ada Lovelace", query: "Ada Lovelace" },
      { name: "Example Org", query: "Example Org" },
    ];
    expect(matchTargetNames("A note about Ada Lovelace today", targets)).toBe("Ada Lovelace");
    expect(matchTargetNames("no overlap here", targets)).toBe("Ada Lovelace | Example Org");
  });
});
