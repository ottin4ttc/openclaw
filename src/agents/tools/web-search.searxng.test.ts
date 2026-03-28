import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";
import { createWebSearchTool } from "./web-search.js";

vi.mock("./web-guarded-fetch.js", () => ({
  withTrustedWebToolsEndpoint: vi.fn(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

const mockEndpoint = vi.mocked(withTrustedWebToolsEndpoint);

function makeConfig(baseUrl?: string) {
  return {
    tools: {
      web: {
        search: {
          provider: "searxng" as const,
          ...(baseUrl ? { searxng: { baseUrl } } : {}),
        },
      },
    },
  };
}

function mockJsonResponse(results: Array<{ title?: string; url?: string; content?: string }>) {
  mockEndpoint.mockImplementation(async (_params, run) =>
    run({
      response: {
        ok: true,
        headers: { get: (h: string) => (h === "content-type" ? "application/json" : null) },
        json: async () => ({ results }),
      } as unknown as Response,
    }),
  );
}

describe("web_search searxng: missing baseUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns missing_searxng_base_url error payload without making HTTP request", async () => {
    // provider=searxng but no baseUrl configured
    const tool = createWebSearchTool({
      config: makeConfig() as unknown as Parameters<typeof createWebSearchTool>[0]["config"],
    });
    const result = (await tool!.execute("id", { query: "test no baseurl abc" })) as {
      details: Record<string, unknown>;
    };
    expect(result.details).toMatchObject({ error: "missing_searxng_base_url" });
    expect(mockEndpoint).not.toHaveBeenCalled();
  });
});

describe("web_search searxng: successful search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps results to {title, url, description, siteName} format", async () => {
    mockJsonResponse([
      { title: "Hello World", url: "https://example.com/hello", content: "A description" },
      { title: "Second Result", url: "https://other.org/page", content: "Other" },
    ]);
    const tool = createWebSearchTool({
      config: makeConfig("http://localhost:8080") as unknown as Parameters<
        typeof createWebSearchTool
      >[0]["config"],
    });
    const result = (await tool!.execute("id", { query: "test map results" })) as {
      details: Record<string, unknown>;
    };
    const data = result.details as { provider: string; results: Array<{ url: string }> };
    expect(data.provider).toBe("searxng");
    expect(data.results).toHaveLength(2);
    expect(data.results[0].url).toBe("https://example.com/hello");
  });

  it("returns empty results array when SearXNG has no matches", async () => {
    mockJsonResponse([]);
    const tool = createWebSearchTool({
      config: makeConfig("http://localhost:8080") as unknown as Parameters<
        typeof createWebSearchTool
      >[0]["config"],
    });
    const result = (await tool!.execute("id", { query: "test empty results xyz" })) as {
      details: Record<string, unknown>;
    };
    expect(result.details).toMatchObject({ count: 0, results: [] });
  });
});

describe("web_search searxng: error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces HTTP error status code in thrown error", async () => {
    mockEndpoint.mockImplementation(async (_params, run) =>
      run({
        response: {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: { get: () => "text/html" },
          text: async () => "down for maintenance",
        } as unknown as Response,
      }),
    );
    const tool = createWebSearchTool({
      config: makeConfig("http://localhost:8080") as unknown as Parameters<
        typeof createWebSearchTool
      >[0]["config"],
    });
    await expect(tool!.execute("id", { query: "test http 503 error" })).rejects.toThrow("503");
  });

  it("surfaces JSON format setup instruction when SearXNG returns HTML", async () => {
    mockEndpoint.mockImplementation(async (_params, run) =>
      run({
        response: {
          ok: true,
          headers: { get: (h: string) => (h === "content-type" ? "text/html" : null) },
        } as unknown as Response,
      }),
    );
    const tool = createWebSearchTool({
      config: makeConfig("http://localhost:8080") as unknown as Parameters<
        typeof createWebSearchTool
      >[0]["config"],
    });
    await expect(tool!.execute("id", { query: "test html response" })).rejects.toThrow(
      "search.formats",
    );
  });
});

describe("web_search searxng: cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves second identical query from cache without a second HTTP request", async () => {
    mockJsonResponse([{ title: "Cached", url: "https://cached.example.com", content: "data" }]);
    const tool = createWebSearchTool({
      config: makeConfig("http://localhost:8080") as unknown as Parameters<
        typeof createWebSearchTool
      >[0]["config"],
    });
    const query = `test cache hit unique query ${Date.now()}`;
    await tool!.execute("id", { query });
    const second = (await tool!.execute("id", { query })) as { details: Record<string, unknown> };
    expect(second.details).toMatchObject({ cached: true });
    expect(mockEndpoint).toHaveBeenCalledTimes(1);
  });
});
