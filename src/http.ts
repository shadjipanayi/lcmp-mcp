import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type RequestHandler } from "express";
import { createEntraVerifier, loadEntraConfig } from "./auth.js";
import type { MarketplaceRegistry } from "./marketplaces.js";
import { SERVER_VERSION, createServer } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Streamable HTTP transport for hosted use (Azure, Copilot Studio):
 *   POST /mcp    MCP endpoint, stateless (a fresh MCP server per request), protected by Entra ID
 *   GET /health  liveness probe, no auth
 * Config: PORT (default 3000), HOST (default 127.0.0.1; use 0.0.0.0 in a container), ENTRA_* (see auth.ts).
 * MCP_AUTH=none skips authentication, and is only allowed on a loopback HOST, for local testing.
 */
export async function startHttp(registry: MarketplaceRegistry, log: (...a: unknown[]) => void): Promise<void> {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const entra = loadEntraConfig();

  let auth: RequestHandler;
  if (entra) {
    auth = requireBearerAuth({ verifier: createEntraVerifier(entra) });
    log(`Entra ID auth: tenant ${entra.tenantId}, role ${entra.requiredRole || "(any user)"}`);
  } else if (process.env.MCP_AUTH === "none" && LOOPBACK.has(host)) {
    auth = (_req, _res, next) => next();
    log("WARNING: authentication disabled (MCP_AUTH=none, loopback only)");
  } else {
    throw new Error("HTTP mode needs ENTRA_TENANT_ID and ENTRA_AUDIENCE (or MCP_AUTH=none with a loopback HOST for local tests).");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: SERVER_VERSION, marketplaces: registry.codes });
  });

  app.post("/mcp", auth, async (req, res) => {
    const server = createServer(registry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless server: no SSE stream to open and no session to delete.
  const notAllowed: RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve());
    httpServer.on("error", reject);
    // Heavy reports can run for minutes; don't let Node cut long requests off.
    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 60_000;
  });
  log(`listening on http://${host}:${port}/mcp (${registry.codes.join(", ")})`);
}
