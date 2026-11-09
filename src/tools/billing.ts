import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarketplaceRegistry } from "../marketplaces.js";
import { PRODUCT_CATALOGUE, REPORT_CATALOGUE } from "../knowledge.js";
import { HEAVY_TIMEOUT_MS, reportToRecords } from "../reports.js";
import { accountId, registerReadTools, resellerContext } from "./helpers.js";

const year = z.number().int().min(2000).max(2100).describe("Four-digit year, e.g. 2026.");
const month = z.number().int().min(1).max(12).describe("Month number, 1-12.");

// The raw GetLatestInvoices / GetLatestInvoicesForPeriod / GetPreviewInvoices calls return a whole country's invoices
// (minutes to download, far over the response cap); get_customer_invoices wraps them with caching and totals.
export function registerBillingTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerReadTools(server, registry, [
    {
      name: "get_invoice_aggregation_report",
      operation: "GetInvoiceAggregationReport",
      title: "Get invoice aggregation report",
      description:
        "Get invoice aggregation lines for a billing month. If year and month are omitted, the current billing interval is used. " +
        "For one customer's or reseller's invoice lines, use get_customer_invoices.",
      input: { year: year.optional(), month: month.optional(), resellerContext },
      timeoutMs: HEAVY_TIMEOUT_MS,
    },
    {
      name: "get_reports",
      operation: "GetReports",
      title: "List reports",
      description: "List the reports available to the user, with the parameters and columns each one accepts.",
    },
    {
      name: "execute_report",
      operation: "ExecuteReport",
      title: "Run a report",
      description:
        "Run a report and return its rows as {column: value} records. Call get_reports to confirm a report's parameters " +
        "and columns. Prefer the review_* tools for routine checks; they run these reports and apply the business rules. " +
        REPORT_CATALOGUE,
      timeoutMs: HEAVY_TIMEOUT_MS,
      transform: (data) => {
        const records = reportToRecords(data);
        return records ? { rowCount: records.length, rows: records } : data;
      },
      input: {
        reportName: z.string().describe("Report name, as returned by get_reports."),
        parameters: z
          .record(z.string(), z.unknown())
          .describe('Report parameters, e.g. {"startdate": "2026-01-01", "enddate": "2026-01-31"}.'),
        columns: z.array(z.string()).optional().describe("Optional subset of columns to return."),
      },
    },
    {
      name: "get_all_product_accounts_with_fields_report",
      operation: "GetAllProductAccountsWithFieldsReport",
      title: "Product accounts with fields report",
      description:
        "List all accounts of a product, with their dynamic product fields (rows under AllProductAccountsWithFields, " +
        "product data under Fields). Slow on large marketplaces. " +
        PRODUCT_CATALOGUE,
      timeoutMs: HEAVY_TIMEOUT_MS,
      input: {
        productName: z.string().describe("Technical product name."),
        createdBefore: z.string().optional().describe("Only accounts created before this past date (YYYY-MM-DD)."),
        resellerContext,
      },
    },
    {
      name: "get_credit_limit",
      operation: "GetCreditLimit",
      title: "Get credit limit",
      description: "Get the credit limit for a company.",
      input: { accountId: accountId("company") },
    },
    {
      name: "list_credit_check_orders_for_approval",
      operation: "ListCreditCheckOrdersForApproval",
      title: "List credit check orders awaiting approval",
      description: "List all credit check orders waiting for approval.",
    },
    {
      name: "get_special_deal",
      operation: "GetSpecialDeal",
      title: "Get special deal discounts",
      description: "Get the special deal discounts set for an account.",
      input: { accountId: accountId() },
    },
  ]);
}
