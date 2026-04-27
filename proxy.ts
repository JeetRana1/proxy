import { handleRequest } from "./handler";

Bun.serve({
  port: 3000,
  fetch: handleRequest,
});

console.log("Proxy running at http://localhost:3000");
