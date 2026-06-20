import { env, isWebSearchUsable } from "../env.js";
import { logger } from "../lib/logger.js";
import type { WebSourceType } from "../../shared/types.js";

export interface WebSearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  isOfficialSource: boolean;
  sourceType: WebSourceType;
}

// Domény považované za oficiální zdroje výrobců (rozšiřitelné).
const OFFICIAL_DOMAINS: RegExp[] = [
  /(^|\.)loxone\.com$/i,
  /(^|\.)jablotron\.com$/i,
  /(^|\.)hikvision\.com$/i,
  /(^|\.)ui\.com$/i,
  /(^|\.)unifi\.com$/i,
  /(^|\.)schneider-electric\./i,
  /(^|\.)abb\.com$/i,
  /(^|\.)oez\.cz$/i,
  /(^|\.)eaton\.com$/i,
];

function classifyDomain(domain: string): {
  isOfficialSource: boolean;
  sourceType: WebSourceType;
} {
  if (OFFICIAL_DOMAINS.some((re) => re.test(domain))) {
    return { isOfficialSource: true, sourceType: "manufacturer_docs" };
  }
  if (/forum|community|reddit|diskuze/i.test(domain)) {
    return { isOfficialSource: false, sourceType: "forum" };
  }
  if (/shop|eshop|alza|mall|amazon|heureka/i.test(domain)) {
    return { isOfficialSource: false, sourceType: "ecommerce" };
  }
  return { isOfficialSource: false, sourceType: "other" };
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// --- Pluggable provideři ---

interface ProviderAdapter {
  search(query: string): Promise<WebSearchResult[]>;
}

function mapRaw(
  items: { title: string; url: string; snippet: string }[],
): WebSearchResult[] {
  return items.map((it) => {
    const domain = getDomain(it.url);
    const cls = classifyDomain(domain);
    return {
      title: it.title,
      url: it.url,
      domain,
      snippet: it.snippet,
      ...cls,
    };
  });
}

const braveAdapter: ProviderAdapter = {
  async search(query) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(env.webSearch.maxResults));
    const res = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": env.webSearch.apiKey,
      },
    });
    const data = (await res.json()) as any;
    const items = (data?.web?.results ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
    return mapRaw(items);
  },
};

const tavilyAdapter: ProviderAdapter = {
  async search(query) {
    const res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.webSearch.apiKey,
        query,
        max_results: env.webSearch.maxResults,
      }),
    });
    const data = (await res.json()) as any;
    const items = (data?.results ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
    return mapRaw(items);
  },
};

const bingAdapter: ProviderAdapter = {
  async search(query) {
    const url = new URL("https://api.bing.microsoft.com/v7.0/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(env.webSearch.maxResults));
    const res = await fetchWithTimeout(url.toString(), {
      headers: { "Ocp-Apim-Subscription-Key": env.webSearch.apiKey },
    });
    const data = (await res.json()) as any;
    const items = (data?.webPages?.value ?? []).map((r: any) => ({
      title: r.name ?? "",
      url: r.url ?? "",
      snippet: r.snippet ?? "",
    }));
    return mapRaw(items);
  },
};

const googleAdapter: ProviderAdapter = {
  async search(query) {
    // Google Programmable Search: WEB_SEARCH_API_KEY ve formátu "apiKey:cx".
    const [apiKey, cx] = env.webSearch.apiKey.split(":");
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", apiKey ?? "");
    url.searchParams.set("cx", cx ?? "");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.min(env.webSearch.maxResults, 10)));
    const res = await fetchWithTimeout(url.toString(), {});
    const data = (await res.json()) as any;
    const items = (data?.items ?? []).map((r: any) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
    return mapRaw(items);
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = {
  brave: braveAdapter,
  tavily: tavilyAdapter,
  bing: bingAdapter,
  google: googleAdapter,
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    env.webSearch.timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function webSearchAvailable(): boolean {
  return isWebSearchUsable() && Boolean(ADAPTERS[env.webSearch.provider]);
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
  if (!webSearchAvailable()) return [];
  const adapter = ADAPTERS[env.webSearch.provider];
  try {
    return await adapter.search(query);
  } catch (err) {
    logger.warn("Web search selhal", String(err));
    return [];
  }
}
