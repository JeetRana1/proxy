# Elysia Backup

This is a backup of the Elysia-based local dev server. It wraps the shared `handler.ts` logic with Elysia's routing.

## Usage

```bash
bun run elysia-backup/proxy.ts
```

## Why this exists

Elysia was removed from the main proxy.ts in favor of pure `Bun.serve()` for portability (Vercel, Cloudflare). This backup is kept in case we want to revisit Elysia for features like:

- Type-safe route validation
- Plugin ecosystem (rate limiting, caching, swagger)
- Lifecycle hooks (logging, metrics middleware)
- WebSocket support

## Note

This still depends on `elysia` in the root `package.json`.
