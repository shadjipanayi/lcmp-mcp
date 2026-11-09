#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttp } from "./http.js";
import { MarketplaceRegistry, loadMarketplaces } from "./marketplaces.js";
import { createServer } from "./server.js";

// Over stdio, stdout carries the MCP protocol, so all diagnostics go to stderr.
const log = (...args: unknown[]) => console.error("[lcmp-mcp]", ...args);

/** Transport: stdio by default (Claude Code / Desktop), HTTP with `--http` or MCP_TRANSPORT=http (Azure / Copilot Studio). */
async function main(): Promise<void> {
  const registry = new MarketplaceRegistry(loadMarketplaces());

  // Sessions are deliberately not terminated on exit: each MCP API user is shared by the whole team.
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    await startHttp(registry, log);
    return;
  }

  process.stdin.on("close", shutdown);
  await createServer(registry).connect(new StdioServerTransport());
  log(`ready (${registry.codes.join(", ")})`);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});
