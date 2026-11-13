// Calls one MCP tool in-process against the live API configured in .env (read-only) and prints its result.
// Build first. Arguments are key=value pairs (values parsed as JSON when they can be), so no shell quoting is needed:
//   node --env-file=.env scripts/live-call.mjs CYMA get_subscription_status accountId=277615
//   node --env-file=.env scripts/live-call.mjs CYMA review_nce_trials maxSubscriptions=10
// Mind the platform's busy windows for heavy reports (00:00-02:50 and 05:30-06:30 UTC).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MarketplaceRegistry, loadMarketplaces } from "../dist/marketplaces.js";
import { createServer } from "../dist/server.js";

const [marketplace, tool, ...pairs] = process.argv.slice(2);
if (!marketplace || !tool) {
  console.error("Usage: node --env-file=.env scripts/live-call.mjs <MARKETPLACE> <tool> [key=value ...]");
  process.exit(2);
}
const args = { marketplace };
for (const pair of pairs) {
  const i = pair.indexOf("=");
  const [key, raw] = [pair.slice(0, i), pair.slice(i + 1)];
  try {
    args[key] = JSON.parse(raw);
  } catch {
    args[key] = raw;
  }
}

// The server logs one tool_call line per call to stderr; keep stdout for the result.
const registry = new MarketplaceRegistry(loadMarketplaces());
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createServer(registry).connect(serverSide);
const client = new Client({ name: "live-call", version: "0" });
await client.connect(clientSide);

const started = Date.now();
// Reviews run several heavy reports (300 s each), far past the MCP client's 60 s default.
const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 15 * 60_000 });
console.error(`${tool} ${result.isError ? "ERROR" : "ok"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(result.content[0]?.text ?? "");
// Let the process end on its own: process.exit() while sockets close crashes Node on Windows (UV_HANDLE_CLOSING).
await client.close();
process.exitCode = result.isError ? 1 : 0;
