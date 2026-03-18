type PluginApi = {
  config?: any;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
  registerTool?: (tool: any, opts?: { name?: string; optional?: boolean }) => void;
};

type PluginConfig = {
  enabled: boolean;
  baseUrl: string;
  defaultLanguage: string;
  safeSearch: 0 | 1 | 2;
  defaultMaxResults: number;
  timeoutMs: number;
  engines: string[];
};

type SearxItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published_at?: string;
  engine?: string;
  score?: number;
};

const DEFAULTS: PluginConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8888",
  defaultLanguage: "en-US",
  safeSearch: 1,
  defaultMaxResults: 8,
  timeoutMs: 10_000,
  engines: ["duckduckgo", "brave", "qwant"],
};

function cfg(api: PluginApi): PluginConfig {
  const raw = api?.config?.plugins?.entries?.["searx-search"]?.config ?? {};
  const safeRaw = Number(raw.safeSearch ?? DEFAULTS.safeSearch);
  const safeSearch = safeRaw === 0 || safeRaw === 2 ? safeRaw : 1;
  const engines = Array.isArray(raw.engines)
    ? raw.engines.map((x: any) => String(x || "").trim()).filter(Boolean)
    : DEFAULTS.engines;
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    baseUrl: String(raw.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, ""),
    defaultLanguage: String(raw.defaultLanguage ?? DEFAULTS.defaultLanguage),
    safeSearch,
    defaultMaxResults: Math.max(1, Math.min(25, Number(raw.defaultMaxResults ?? DEFAULTS.defaultMaxResults))),
    timeoutMs: Math.max(500, Math.min(30_000, Number(raw.timeoutMs ?? DEFAULTS.timeoutMs))),
    engines: engines.length ? engines : DEFAULTS.engines,
  };
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeResults(payload: any, limit: number): SearxItem[] {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const seen = new Set<string>();
  const out: SearxItem[] = [];
  for (const row of rows) {
    const rawUrl = String(row?.url || row?.link || "").trim();
    const url = canonicalUrl(rawUrl);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = String(row?.title || row?.name || "").trim();
    const snippet = String(row?.content || row?.snippet || row?.description || "").trim();
    const source = String(row?.source || row?.engine || hostOf(url) || "").trim();
    const published = String(row?.publishedDate || row?.published_date || row?.published_at || "").trim();
    const scoreNum = Number(row?.score);
    out.push({
      title,
      url,
      snippet,
      source,
      published_at: published || undefined,
      engine: String(row?.engine || "").trim() || undefined,
      score: Number.isFinite(scoreNum) ? scoreNum : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function searxQuery(config: PluginConfig, params: any) {
  const query = String(params?.query || "").trim();
  if (!query) throw new Error("query is required");
  const maxResults = Math.max(1, Math.min(25, Number(params?.maxResults ?? config.defaultMaxResults)));
  const language = String(params?.language || config.defaultLanguage);
  const safeSearch = [0, 1, 2].includes(Number(params?.safeSearch)) ? Number(params.safeSearch) : config.safeSearch;
  const category = String(params?.category || "").trim();
  const timeRange = String(params?.timeRange || "").trim();
  const engines = Array.isArray(params?.engines)
    ? params.engines.map((x: any) => String(x || "").trim()).filter(Boolean)
    : config.engines;

  const u = new URL(`${config.baseUrl}/search`);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  u.searchParams.set("language", language);
  u.searchParams.set("safesearch", String(safeSearch));
  if (category) u.searchParams.set("categories", category);
  if (timeRange) u.searchParams.set("time_range", timeRange);
  if (engines.length) u.searchParams.set("engines", engines.join(","));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`searx request failed: ${res.status}`);
    }
    const json = await res.json();
    const results = normalizeResults(json, maxResults);
    return {
      query,
      count: results.length,
      results,
      provider: "searxng",
      endpoint: config.baseUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

function registerToolCompat(api: PluginApi, def: any, name: string) {
  if (typeof api?.registerTool !== "function") return;
  try {
    api.registerTool(def, { name, optional: true });
  } catch {
    api.registerTool(def);
  }
}

export default function searxSearchPlugin(api: PluginApi) {
  const config = cfg(api);

  registerToolCompat(
    api,
    {
      name: "searx_status",
      label: "SearX: status",
      description: "Check local SearXNG plugin health and config",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: async () => {
        const status: any = {
          enabled: config.enabled,
          baseUrl: config.baseUrl,
          defaultLanguage: config.defaultLanguage,
          safeSearch: config.safeSearch,
          defaultMaxResults: config.defaultMaxResults,
          timeoutMs: config.timeoutMs,
          engines: config.engines,
          healthy: false,
        };
        if (!config.enabled) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
            details: status,
          };
        }
        try {
          const h = await fetch(`${config.baseUrl}/healthz`, { method: "GET" });
          status.healthy = h.ok;
          status.healthStatus = h.status;
        } catch (e: any) {
          status.error = String(e?.message || e);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
          details: status,
        };
      },
    },
    "searx_status",
  );

  registerToolCompat(
    api,
    {
      name: "searx_search",
      label: "SearX: search",
      description: "Search web via local SearXNG and return normalized results",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 25 },
          language: { type: "string" },
          safeSearch: { type: "integer", enum: [0, 1, 2] },
          category: { type: "string" },
          timeRange: { type: "string", enum: ["day", "month", "year"] },
          engines: { type: "array", items: { type: "string" } },
        },
      },
      execute: async (_toolCallId: string, params: any) => {
        if (!config.enabled) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "searx-search plugin disabled" }) }],
            details: { error: "searx-search plugin disabled" },
          };
        }
        try {
          const payload = await searxQuery(config, params);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
            details: payload,
          };
        } catch (e: any) {
          const err = { error: String(e?.message || e), provider: "searxng" };
          api?.logger?.warn?.("[searx-search] search failed", err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(err) }],
            details: err,
          };
        }
      },
    },
    "searx_search",
  );

  api?.logger?.info?.("[searx-search] loaded", {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    engines: config.engines,
  });
}
