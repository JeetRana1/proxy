import { handleRequest } from "./handler";

Bun.serve({
  port: Number(Bun.env.PORT || 3001),
  fetch: handleRequest,
});

console.log(`Proxy running at http://localhost:${Bun.env.PORT || 3001}`);
