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
  const incomingOrigin = requestHeaders.get("X-Forward-Origin") ?? requestHeaders.get("Origin");
  const incomingReferer = requestHeaders.get("X-Forward-Referer") ?? requestHeaders.get("Referer");

  const forwardHeaders: Record<string, string> = {
    "User-Agent": requestHeaders.get("User-Agent") ?? "BunProxy/1.0",
    ...(incomingOrigin ? { Origin: incomingOrigin } : {}),
    ...(incomingReferer ? { Referer: incomingReferer } : {}),
    ...(template.forwardHeaders ?? {}),
  };

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
  if (etag) responseHeaders["ETag"] = etag;
  if (lastModified) responseHeaders["Last-Modified"] = lastModified;
  if (cacheControl) responseHeaders["Cache-Control"] = cacheControl;

  return responseHeaders;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};