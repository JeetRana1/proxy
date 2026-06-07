import { domainRules, type DomainRule } from "./domain";

export interface DomainTemplate {
  forwardHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** Find the first rule whose patterns match the given hostname, or null. */
function matchRule(hostname: string): DomainRule | null {
  return domainRules.find((rule) => rule.patterns.some((p) => p.test(hostname))) ?? null;
}

/** Convert a DomainRule into the DomainTemplate shape the rest of the code expects. */
function ruleToTemplate(rule: DomainRule): DomainTemplate {
  return {
    forwardHeaders: {
      Origin: rule.origin,
      Referer: rule.referer,
      ...(rule.customHeaders ?? {}),
    },
    responseHeaders: {},
  };
}

const defaultTemplate: DomainTemplate = {
  forwardHeaders: {},
  responseHeaders: {},
};

export function getDomainTemplate(url: string): DomainTemplate {
  try {
    const hostname = new URL(url).hostname;
    const rule = matchRule(hostname);
    return rule ? ruleToTemplate(rule) : defaultTemplate;
  } catch {
    return defaultTemplate;
  }
}

export function buildForwardHeaders(
  requestHeaders: Headers,
  template: DomainTemplate
): Record<string, string> {
  // Strip client-specific headers that would expose the proxy
  const incomingOrigin = requestHeaders.get("X-Forward-Origin") ?? requestHeaders.get("Origin");
  const incomingReferer = requestHeaders.get("X-Forward-Referer") ?? requestHeaders.get("Referer");
  const incomingRange = requestHeaders.get("Range");

  // Build clean headers for outbound request
  const forwardHeaders: Record<string, string> = {
    // Use a clean, browser-like User-Agent to avoid detection
    "User-Agent": requestHeaders.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: requestHeaders.get("Accept") || "*/*",
    "Accept-Language": requestHeaders.get("Accept-Language") || "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    // Include Origin/Referer from domain template or incoming request
    ...(incomingOrigin ? { Origin: incomingOrigin } : {}),
    ...(incomingReferer ? { Referer: incomingReferer } : {}),
    ...(incomingRange ? { Range: incomingRange } : {}),
    // Domain-specific headers override generic ones
    ...(template.forwardHeaders ?? {}),
  };

  // Preserve conditional request headers for caching efficiency
  const ifNoneMatch = requestHeaders.get("If-None-Match");
  const ifModifiedSince = requestHeaders.get("If-Modified-Since");
  if (ifNoneMatch) forwardHeaders["If-None-Match"] = ifNoneMatch;
  if (ifModifiedSince) forwardHeaders["If-Modified-Since"] = ifModifiedSince;

  return forwardHeaders;
}

export function buildResponseHeaders(
  upstream: Response,
  template: DomainTemplate,
  contentType: string | null
): Record<string, string> {
  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": contentType ?? "application/octet-stream",
    ...(template.responseHeaders ?? {}),
  };

  const etag = upstream.headers.get("ETag");
  const lastModified = upstream.headers.get("Last-Modified");
  const cacheControl = upstream.headers.get("Cache-Control");
  const contentLength = upstream.headers.get("Content-Length");
  const contentRange = upstream.headers.get("Content-Range");
  const acceptRanges = upstream.headers.get("Accept-Ranges");
  if (etag) responseHeaders["ETag"] = etag;
  if (lastModified) responseHeaders["Last-Modified"] = lastModified;
  if (cacheControl) responseHeaders["Cache-Control"] = cacheControl;
  if (contentLength) responseHeaders["Content-Length"] = contentLength;
  if (contentRange) responseHeaders["Content-Range"] = contentRange;
  if (acceptRanges) responseHeaders["Accept-Ranges"] = acceptRanges;

  return responseHeaders;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
