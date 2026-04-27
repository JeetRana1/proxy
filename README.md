# Shirna Proxy v2

A lightweight HLS/M3U8 streaming proxy built with [Bun](https://bun.sh). Deployable to Vercel, Cloudflare Workers, or run locally.

## What it does

- Proxies HTTP/HTTPS requests with CORS support
- Rewrites M3U8 playlists so all segment and sub-playlist URLs route back through the proxy
- Detects M3U8 content disguised as other formats (HTML, JS, octet-stream) via byte-level sniffing
- Forwards domain-specific headers (Origin, Referer, custom headers) based on configurable rules
- Supports HTTP caching (ETag, Last-Modified, 304 Not Modified)
- Streams non-M3U8 responses directly without buffering

## Requirements

- [Bun](https://bun.sh) v1.0+

## Setup

```bash
bun install
```

## Usage

```bash
bun run start
```

The proxy starts at `http://localhost:3000`.

### Proxy a URL

```
GET /proxy?src=<URL>
```

The `src` parameter accepts both encoded and raw URLs.

#### Examples

Proxy an M3U8 playlist:
```
/proxy?src=https://example.com/stream/index.m3u8
```

Proxy a video segment:
```
/proxy?src=https%3A%2F%2Fexample.com%2Fseg-1.ts
```

## Deployment

The core proxy logic lives in `handler.ts` as a pure `Request -> Response` function with no framework dependencies, making it portable across runtimes.

### Vercel (Edge Runtime)

Available on the `vercel` branch.

```bash
npm i -g vercel
vercel --prod
```

### Cloudflare Workers

Available on the `cloudflare` branch.

```bash
cd cloudflare
npx wrangler deploy
```

Set your `account_id` in `cloudflare/wrangler.toml` before deploying.

### Local (Bun)

Available on the `main` branch.

```bash
bun run proxy.ts
```

## Project Structure

```
handler.ts              - Core proxy logic (portable, no framework deps)
headers.ts              - Header building, CORS, and domain template resolution
domain.ts               - Domain rules (hostname patterns -> Origin/Referer/custom headers)
proxy.ts                - Local dev entry point (Bun.serve)
api/index.ts            - Vercel edge runtime entry point (vercel branch)
vercel.json             - Vercel routing config (vercel branch)
cloudflare/worker.ts    - Cloudflare Workers entry point (cloudflare branch)
cloudflare/wrangler.toml - Wrangler config (cloudflare branch)
elysia-backup/          - ElysiaJS version backup for future reference
```

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Core proxy + local Bun dev server |
| `vercel` | Vercel edge runtime deployment |
| `cloudflare` | Cloudflare Workers deployment |

## How M3U8 Rewriting Works

1. The proxy fetches the upstream URL
2. If the response is an M3U8 playlist (by content-type, URL extension, or content sniffing):
   - All segment URLs (relative and absolute) are rewritten to route through the proxy
   - `URI=` / `URL=` attributes in tags like `#EXT-X-KEY` and `#EXT-X-MAP` are also rewritten
   - The response is served with `application/vnd.apple.mpegurl` content type
3. Non-2xx responses pass through as-is (no rewriting of error pages)
4. Non-M3U8 responses are streamed through without buffering

## Domain Rules

Domain-specific headers are configured in `domain.ts`. Each rule has:

- `patterns` - Array of RegExp patterns matched against the upstream hostname
- `origin` - Origin header to forward
- `referer` - Referer header to forward
- `customHeaders` - Optional additional headers (e.g., cache-control, x-requested-with)

Rules are matched in order using `.find()`, so more specific patterns should come before general ones. A catch-all rule for weather-themed CDN hostnames is kept last.

## License

MIT
