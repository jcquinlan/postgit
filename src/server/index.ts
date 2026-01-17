import { initDb } from "../db";
import { createApiRoutes } from "./api";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
  console.log("Initializing database...");
  await initDb();
  console.log("Database initialized.");

  const routes = createApiRoutes();

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

      if (method === "GET" && url.pathname === "/api/workflows") {
        return routes["GET /api/workflows"]();
      }

      if (method === "POST" && url.pathname === "/api/workflows") {
        return routes["POST /api/workflows"](req);
      }

      if (method === "GET" && url.pathname.match(/^\/api\/workflows\/[^/]+$/) && !url.pathname.includes("/instances")) {
        return routes["GET /api/workflows/:name"](req);
      }

      if (method === "DELETE" && url.pathname.match(/^\/api\/workflows\/[^/]+$/)) {
        return routes["DELETE /api/workflows/:name"](req);
      }

      if (method === "POST" && url.pathname.match(/^\/api\/workflows\/[^/]+\/instances$/)) {
        return routes["POST /api/workflows/:name/instances"](req);
      }

      if (method === "GET" && url.pathname === "/api/instances") {
        return routes["GET /api/instances"](req);
      }

      if (method === "GET" && url.pathname.match(/^\/api\/instances\/[^/]+$/)) {
        return routes["GET /api/instances/:id"](req);
      }

      if (method === "DELETE" && url.pathname.match(/^\/api\/instances\/[^/]+$/)) {
        return routes["DELETE /api/instances/:id"](req);
      }

      if (method === "POST" && url.pathname.match(/^\/api\/instances\/[^/]+\/reset$/)) {
        return routes["POST /api/instances/:id/reset"](req);
      }

      if (method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  console.log(`🚀 Server running at http://localhost:${server.port}`);
}

main().catch(console.error);
