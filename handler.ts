import { getDomainTemplate, buildForwardHeaders, buildResponseHeaders, corsHeaders } from "./headers";

function rewriteM3u8(content: string, baseUrl: string, proxyBase: string): string {
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
        const newUrl = absolute.startsWith(proxyBase)
          ? absolute
          : `${proxyBase}${encodeURIComponent(absolute)}`;

        const quoteChar = quote || "";
        return `${key}=${quoteChar}${newUrl}${quoteChar}`;
      });
    }

    // Segment or sub-playlist lines
    if (!trimmed.startsWith("#")) {
      const absolute = toAbsolute(trimmed, base);
      if (absolute.startsWith(proxyBase)) return absolute;
      return `${proxyBase}${encodeURIComponent(absolute)}`;
    }

    return line;
  }).join("\n");
}

function toAbsolute(uri: string, base: URL): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return new URL(uri, base).toString();
}

function isM3u8(contentType: string | null, url: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("m3u")) return true;
  }
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes(".m3u8") || lowerUrl.includes(".m3u") || lowerUrl.includes("/m3u8");
}

const TEXT_LIKE_TYPES = ["text/", "application/javascript", "application/json", "application/octet-stream"];

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
  // Extract all content after `src=` to support unencoded URLs with `&` query parameters
  const match = req.url.match(/[?&]src=(.*)/);
  let src = match ? match[1] : reqUrl.searchParams.get("src");

  if (src && src.includes("%")) {
    try {
      src = decodeURIComponent(src);
    } catch { }
  }

  if (!src) {
    return new Response("Missing src parameter", { status: 400, headers: corsHeaders });
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return new Response("Invalid URL", { status: 400, headers: corsHeaders });
  }

  const urlStr = url.toString();
  const proxyBase = `${reqUrl.origin}/proxy?src=`;
  const template = getDomainTemplate(urlStr);
  const forwardHeaders = buildForwardHeaders(req.headers, template);

  let upstream: Response;
  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: forwardHeaders,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req.body;
      // Also need to set duplex to 'half' for node fetch in edge environment sometimes, but standard edge fetch should be fine.
      // @ts-ignore - Some edge environments require this for streaming bodies
      fetchOptions.duplex = 'half';
    }
    upstream = await fetch(urlStr, fetchOptions);
  } catch (e) {
    console.error("Fetch error:", e);
    return new Response("Failed to fetch upstream", { status: 502, headers: corsHeaders });
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
    const rewritten = rewriteM3u8(text, urlStr, proxyBase);
    responseHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
    return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
  }

  // Sniff text-like responses for hidden M3U8
  if (couldBeTextContent(contentType)) {
    const buf = new Uint8Array(await upstream.arrayBuffer());
    if (sniffM3u8(buf)) {
      const text = new TextDecoder().decode(buf);
      const rewritten = rewriteM3u8(text, urlStr, proxyBase);
      responseHeaders["Content-Type"] = "application/vnd.apple.mpegurl";
      return new Response(rewritten, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(buf, { status: upstream.status, headers: responseHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
