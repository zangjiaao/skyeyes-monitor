import { describe, expect, it, vi } from "vitest";
import type { SearchDiagnostic, SearchRequest } from "../src/domain/types";
import { googleNewsProvider } from "../src/sources/google-news";
import { gdeltProvider } from "../src/sources/gdelt";
import { xProvider } from "../src/sources/x";

const providers = [xProvider, googleNewsProvider, gdeltProvider];
function request(fetchImpl: typeof fetch, events: SearchDiagnostic[]): SearchRequest {
  return {
    targets: [{ id: "new-target", name: "新目标", kind: "keyword", query: "ProbeKeyword" }],
    countryName: "新分组", apiKey: "private-api-key", googleNewsEditions: "en-US",
    window: { start: new Date("2026-10-13T00:00:00Z"), end: new Date("2026-10-14T00:00:00Z") },
    fetchImpl, onDiagnostic: (event) => { events.push(event); },
  };
}

describe.each(providers)("$id query diagnostics", (provider) => {
  it("reports a successful empty response, including target and checkpoint context", async () => {
    const events: SearchDiagnostic[] = [];
    const onPage = vi.fn();
    await provider.search({
      ...request(async () => provider.id === "google_news"
        ? new Response("<rss><channel></channel></rss>")
        : Response.json({ tweets: [], articles: [] }), events),
      onPage,
    });
    expect(events.map((event) => event.event)).toEqual(["request", "response", "result"]);
    expect(events[2]).toMatchObject({ targetId: "new-target", terms: ["ProbeKeyword"], rawItems: 0, matchedItems: 0 });
    expect(onPage.mock.calls[0][0]).toMatchObject({ diagnostic: { targetId: "new-target", step: 0, page: 0 } });
    expect(JSON.stringify(events)).not.toContain("private-api-key");
  });

  it("reports HTTP failure against the exact target before retry handling", async () => {
    const events: SearchDiagnostic[] = [];
    await expect(provider.search(request(async () => new Response("unavailable", { status: 500 }), events)))
      .rejects.toThrow(/500/);
    expect(events.map((event) => event.event)).toEqual(["request", "response"]);
    expect(events[1]).toMatchObject({ targetId: "new-target", status: 500 });
  });

  it("reports network failure without leaking error URLs or credentials", async () => {
    const events: SearchDiagnostic[] = [];
    await expect(provider.search(request(async () => {
      throw new TypeError("private-api-key in sensitive network URL");
    }, events))).rejects.toThrow(TypeError);
    expect(events.map((event) => event.event)).toEqual(["request", "error"]);
    expect(events[1]).toMatchObject({ targetId: "new-target", error: "TypeError" });
    expect(JSON.stringify(events)).not.toContain("private-api-key");
  });

  it("does not claim an upstream request was sent when pacing deferred it", async () => {
    const events: SearchDiagnostic[] = [];
    const fetchImpl = vi.fn();
    await expect(provider.search({
      ...request(fetchImpl, events), beforeRequest: async () => { throw new Error("deferred"); },
    })).rejects.toThrow("deferred");
    expect(events).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
