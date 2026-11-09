import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarketplaceRegistry } from "./marketplaces.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerCompositeTool } from "./tools/helpers.js";
import { registerMarketplaceTools } from "./tools/marketplace.js";
import { registerRunbookTools } from "./tools/runbooks.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerSupportTools } from "./tools/support.js";

export const SERVER_VERSION = "0.3.0";

/**
 * Builds an MCP server with every tool. Cheap to call: state worth keeping (API sessions, the customer directory
 * cache) lives in the registry and module scope, so the HTTP transport can build one server per request.
 */
export function createServer(registry: MarketplaceRegistry): McpServer {
  const server = new McpServer(
    { name: "lcmp-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to the Logicom Cloud Marketplace (LCMP) SimpleAPI for internal and support staff, for the country " +
        `marketplaces ${registry.describe()}. Every call targets exactly one marketplace via the \`marketplace\` input; ` +
        "there is no cross-country search. If the user hasn't said which country, ask them before calling a tool. " +
        "Hierarchy per marketplace: distributor -> reseller -> customer company -> users / subscriptions. Invoices are issued " +
        "to resellers; each line names the end customer. " +
        "For support questions start with: find_account (by name, VAT or ID), get_customer_overview, " +
        "get_subscription_status, get_customer_invoices. Products with '(NCE)' in the name are New Commerce; others are Legacy CSP. " +
        "For operational checks use the review_* tools (provisioning, credit, renewals, NCE trials, seat changes, " +
        "consumption forecast, inactive resellers); they mirror the team's automation runbooks. " +
        "Use get_reports before execute_report. Avoid heavy reports during the platform's billing run " +
        "(00:00-02:50 UTC) and Azure sync (05:30-06:30 UTC): they time out.",
    },
  );

  registerCompositeTool(server, registry, {
    name: "ping",
    title: "Check connection",
    description: "Log in to a marketplace and validate the session, to check the URL and that marketplace's credentials.",
    run: async (_args, client) => {
      await client.call("PingPong", {});
      return "Connected: the session is valid.";
    },
  });

  registerSupportTools(server, registry);
  registerAccountTools(server, registry);
  registerSubscriptionTools(server, registry);
  registerBillingTools(server, registry);
  registerMarketplaceTools(server, registry);
  registerRunbookTools(server, registry);
  return server;
}
