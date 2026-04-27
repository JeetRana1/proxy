import { Elysia } from "elysia";
import { handleRequest } from "../handler";
import { corsHeaders } from "../headers";

const app = new Elysia();

app.get("/", () => {
  return handleRequest(new Request("http://localhost:3000/"));
});

app.get("/proxy", async (c) => {
  return handleRequest(c.request);
});

app.options("/proxy", () =>
  new Response(null, {
    status: 204,
    headers: corsHeaders,
  })
);

app.listen(3000, () => {
  console.log("Proxy running at http://localhost:3000 (Elysia)");
});

export default app;
