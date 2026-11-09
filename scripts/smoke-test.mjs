// Smoke test: starts the built server over stdio and calls a few tools.
// Defaults to the SwaggerHub mock server, which returns example data and ignores credentials.
// Usage: npm run build && node scripts/smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = {
  ...process.env,
  LCMP_BASE_URL:
    process.env.LCMP_BASE_URL ?? "https://virtserver.swaggerhub.com/MarketplaceSimpleAPI/MarketplaceSimpleAPI/1.0.0",
  LCMP_USERNAME: process.env.LCMP_USERNAME ?? "mock-user",
  LCMP_PASSWORD: process.env.LCMP_PASSWORD ?? "mock-password",
};

const usingMock = env.LCMP_BASE_URL.includes("virtserver.swaggerhub.com");
// The mock answers 406 for operations whose documented response has no body (e.g. PingPong).
const mockGaps = new Set(["ping"]);

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "inherit" }));

const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "));

const calls = [
  ["ping", {}],
  ["get_company", {}],
  ["get_companies", { parentAccountId: 100001 }],
  ["get_subscriptions", { parentAccountId: 100001 }],
  ["get_invoice_aggregation_report", {}],
  ["get_marketplaces", {}],
  ["get_marketplace_service_charges", { marketplaceId: 2 }],
  ["execute_report", { reportName: "MSCSPSeatChanges", parameters: { startdate: "2026-01-01", enddate: "2026-01-31" } }],
  ["find_account", { query: "Example" }],
  ["get_customer_overview", { accountId: 100006 }],
  ["review_provisioning_requests", {}],
  ["review_credit_health", {}],
];
let failed = 0;
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const expected = usingMock && mockGaps.has(name);
  if (res.isError && !expected) failed++;
  console.log(`\n--- ${name} ${res.isError ? (expected ? "ERROR (expected on mock)" : "ERROR") : "ok"}\n${text.slice(0, 300)}${text.length > 300 ? " ..." : ""}`);
}
await client.close();
process.exit(failed ? 1 : 0);
