import { getDomainTemplate, buildForwardHeaders, buildResponseHeaders, corsHeaders } from "./headers";

function rewriteM3u8(content: string, baseUrl: string, proxyBase: string, proxyMedia: boolean): string {
  const base = new URL(baseUrl);
  const lines = content.split("\n");

  return lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed) return line;

    // Tags containing URI or URL attributes (e.g., #EXT-X-KEY, #EXT-X-MAP)
    if (trimmed.startsWith("#") && /(URI|URL)=/i.test(trimmed)) {
      const regex = /(URI|URL)=((["'])(.*?)\3|([^"',\s]+))/gi;

      return trimmed.replace(regex, (match, key, fullValue, quote, quotedContent, unquotedContent) => {
        const originalUri = quotedContent ?? unquotedContent;
        if (!originalUri) return match;

        const absolute = toAbsolute(originalUri, base);
        const newUrl = shouldProxyPlaylistUrl(absolute, proxyMedia)
          ? toProxyUrl(absolute, proxyBase, proxyMedia)
          : absolute;

        const quoteChar = quote || "";
        return `${key}=${quoteChar}${newUrl}${quoteChar}`;
      });
    }

    // Segment or sub-playlist lines
    if (!trimmed.startsWith("#")) {
      const absolute = toAbsolute(trimmed, base);
      if (!shouldProxyPlaylistUrl(absolute, proxyMedia)) return absolute;
      return toProxyUrl(absolute, proxyBase, proxyMedia);
    }

    return line;
  }).join("\n");
}

function toAbsolute(uri: string, base: URL): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return new URL(uri, base).toString();
}

function toProxyUrl(absoluteUrl: string, proxyBase: string, proxyMedia: boolean): string {
  if (absoluteUrl.startsWith(proxyBase)) return absoluteUrl;
  const base = proxyMedia
    ? proxyBase.replace("?src=", "?proxyMedia=1&src=")
    : proxyBase;
  return base + encodeURIComponent(absoluteUrl);
}

function shouldProxyPlaylistUrl(absoluteUrl: string, proxyMedia: boolean): boolean {
  if (proxyMedia) return true;
  const lowerUrl = absoluteUrl.toLowerCase();
  if (lowerUrl.includes("goldweather.net")) return true;

  // Keep sub-playlists proxied so their segment URLs can be rewritten too.
  if (lowerUrl.includes(".m3u8") || lowerUrl.includes(".m3u") || lowerUrl.includes("/m3u8")) {
    return true;
  }

  // Video bytes are what drive Vercel Fast Origin Transfer. Leave them direct by default.
  if (/\.(?:ts|m4s|mp4|m4v|aac|m4a|webm|vtt)(?:[?#]|$)/i.test(lowerUrl)) {
    return false;
  }

  // Unknown URI attributes are usually keys/tokens and are small enough to proxy.
  return true;
}

function isM3u8(contentType: string | null, url: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("m3u")) return true;
  }
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes(".m3u8") || lowerUrl.includes(".m3u") || lowerUrl.includes("/m3u8");
}

const TEXT_LIKE_TYPES = ["text/", "application/javascript", "application/json"];
const AXIOS_MODULE = "axios";
const SOCKS_PROXY_AGENT_MODULE = "socks-proxy-agent";

function getEnv(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
}

const TOR_PROXY_URL = getEnv("TOR_PROXY_URL") || "socks5h://127.0.0.1:9050";
const TOR_FETCH_TIMEOUT_MS = Number(getEnv("TOR_FETCH_TIMEOUT_MS") || 15000);

function isLocalRuntime(): boolean {
  return !getEnv("VERCEL") && getEnv("NODE_ENV") !== "production";
}

function shouldUseTorForUrl(url: URL): boolean {
  if (!isLocalRuntime()) return false;
  if (getEnv("ENABLE_TOR_PROXY") === "false") return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === "way.goldweather.net" || hostname.endsWith(".goldweather.net");
}

function buildJsonError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>
): Response {
  return new Response(JSON.stringify({ success: false, code, message, ...(details ?? {}) }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeFetchError(error: unknown): { code: string; message: string } {
  const err = error as { code?: string; message?: string; name?: string };
  const rawMessage = String(err?.message || "Upstream fetch failed");
  const rawCode = String(err?.code || err?.name || "UPSTREAM_FETCH_FAILED");

  if (/socks|tor|proxy|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout/i.test(`${rawCode} ${rawMessage}`)) {
    return {
      code: "TOR_UPSTREAM_UNAVAILABLE",
      message:
        "Tor proxy failed while fetching the upstream HLS resource. Make sure Tor is running locally on 127.0.0.1:9050, then retry.",
    };
  }

  return {
    code: rawCode,
    message: rawMessage,
  };
}

async function fetchUpstream(req: Request, url: URL, headers: Record<string, string>): Promise<Response> {
  if (!shouldUseTorForUrl(url)) {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = await req.arrayBuffer();
    }
    return fetch(url.toString(), fetchOptions);
  }

  const [{ default: axios }, { SocksProxyAgent }] = await Promise.all([
    import(AXIOS_MODULE),
    import(SOCKS_PROXY_AGENT_MODULE),
  ]);
  const agent = new SocksProxyAgent(TOR_PROXY_URL);
  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;
  const response = await axios.request({
    url: url.toString(),
    method: req.method,
    headers,
    data: body,
    responseType: "arraybuffer",
    timeout: TOR_FETCH_TIMEOUT_MS,
    validateStatus: () => true,
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
  });

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
    else if (typeof value !== "undefined") responseHeaders.set(key, String(value));
  }

  return new Response(response.data, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function couldBeTextContent(contentType: string | null): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return TEXT_LIKE_TYPES.some((t) => ct.includes(t));
}

const M3U8_SIG = [0x23, 0x45, 0x58, 0x54, 0x4D, 0x33, 0x55]; // #EXTM3U
const EXTX_SIG = [0x23, 0x45, 0x58, 0x54, 0x2D, 0x58, 0x2D]; // #EXT-X-

function sniffM3u8(buf: Uint8Array): boolean {
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0A || buf[i] === 0x0D)) i++;
  if (i + 7 > buf.length) return false;
  return M3U8_SIG.every((b, j) => buf[i + j] === b) || EXTX_SIG.every((b, j) => buf[i + j] === b);
}

const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shirna Proxy v2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .container { text-align: center; }
    .status { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: #22c55e; margin-bottom: 16px; }
    .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    h1 { font-size: 32px; font-weight: 600; margin-bottom: 8px; }
    p { color: #888; font-size: 14px; }
    .usage { margin-top: 24px; background: #141414; border: 1px solid #262626; border-radius: 8px; padding: 16px; text-align: left; }
    .usage code { color: #a78bfa; font-size: 13px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="status"><span class="dot"></span> Online</div>
    <h1>Shirna Proxy v2</h1>
    <p>HLS/M3U8 streaming proxy</p>
    <div class="usage">
      <code>GET /proxy?src=&lt;url&gt;</code>
    </div>
  </div>
</body>
</html>`;

export async function handleRequest(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  const path = reqUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Status page
  if (path === "/" || path === "") {
    return new Response(STATUS_HTML, { headers: { "Content-Type": "text/html" } });
  }

  // Proxy endpoint
  if (path === "/proxy") {
    return handleProxy(req, reqUrl);
  }

  return new Response("Not Found", { status: 404, headers: corsHeaders });
}

async function handleProxy(req: Request, reqUrl: URL): Promise<Response> {
  // Extract URL parameter - supports both 'url' and 'src' for compatibility
  // Also handles unencoded URLs with nested query parameters like ?type=hls&q=...
  let urlParam = reqUrl.searchParams.get("url") ?? reqUrl.searchParams.get("src");
  
  // If not found in params, try to extract from the full request URL to capture nested queries
  if (!urlParam) {
    const urlMatch = req.url.match(/[?&]url=(.*)/);
    const srcMatch = req.url.match(/[?&]src=(.*)/);
    urlParam = urlMatch ? urlMatch[1] : (srcMatch ? srcMatch[1] : null);
  }

  if (urlParam && urlParam.includes("%")) {
    try {
      urlParam = decodeURIComponent(urlParam);
    } catch { }
  }

  if (!urlParam) {
    return new Response("Missing url or src parameter", { status: 400, headers: corsHeaders });
  }

  let url: URL;
  try {
    url = new URL(urlParam);
  } catch {
    return new Response("Invalid URL", { status: 400, headers: corsHeaders });
  }

  const urlStr = url.toString();
  const proxyBase = `${reqUrl.origin}/proxy?url=`;
  const proxyMedia =
    reqUrl.searchParams.get("proxyMedia") === "1" ||
    /(?:^|\.)goldweather\.net$/i.test(url.hostname);
  const template = getDomainTemplate(urlStr);
  const forwardHeaders = buildForwardHeaders(req.headers, template);

  let upstream: Response;
  try {
    upstream = await fetchUpstream(req, url, forwardHeaders);
  } catch (e) {
    console.error("Fetch error:", e);
    const normalized = normalizeFetchError(e);
    return buildJsonError(502, normalized.code, normalized.message, {
      upstream: url.hostname,
      tor: shouldUseTorForUrl(url),
    });
  }

  if (upstream.status === 304) {
    return new Response(null, {
      status: 304,
      headers: {
        ...corsHeaders,
        ...(upstream.headers.get("ETag") ? { ETag: upstream.headers.get("ETag")! } : {}),
      },
    });
  }

  const contentType = upstream.headers.get("Content-Type");
  const responseHeaders = buildResponseHeaders(upstream, template, contentType);

  // Don't rewrite error responses — pass through as-is
  if (!upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }

  // Fast path: obvious M3U8 by content-type or URL extension
  if (isM3u8(contentType, urlStr)) {
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, urlStr, proxyBase, proxyMedia);
    responseHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
    delete responseHeaders["Content-Length"];
    return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
  }

  // Sniff text-like responses for hidden M3U8
  if (couldBeTextContent(contentType)) {
    const buf = new Uint8Array(await upstream.arrayBuffer());
    if (sniffM3u8(buf)) {
      const text = new TextDecoder().decode(buf);
      const rewritten = rewriteM3u8(text, urlStr, proxyBase, proxyMedia);
      responseHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
      delete responseHeaders["Content-Length"];
      return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(buf, { status: upstream.status, headers: responseHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
