import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarketplaceRegistry } from "../marketplaces.js";
import { HEAVY_TIMEOUT_MS } from "../reports.js";
import { accountId, registerReadTools } from "./helpers.js";

/**
 * List calls return full account records (addresses, bank details, contacts...): a country's reseller list is
 * ~200k characters. Lists return one compact row per account; get_company / get_reseller give the full record.
 */
export function compactAccounts(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return {
    count: data.length,
    accounts: data.map((a: Record<string, unknown>) => ({
      accountId: a.AccountId,
      name: a.CompanyName,
      type: a.AccountType ?? null,
      state: a.AccountState ?? null,
      vatId: a.VATID ?? null,
      country: a.Country ?? null,
      currency: a.Currency ?? null,
      billingStartDate: a.BillingStartDate ?? null,
    })),
  };
}

export function registerAccountTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerReadTools(server, registry, [
    {
      name: "get_reseller",
      operation: "GetReseller",
      title: "Get reseller",
      description: "Get a reseller by Account ID. If accountId is omitted, returns the current session user's reseller.",
      input: { accountId: accountId("reseller").optional() },
    },
    {
      name: "get_resellers",
      operation: "GetResellers",
      title: "List resellers",
      description: "List the first-level resellers under a parent Account ID."+" Returns compact rows (ID, name, type, state, VAT ID, country, currency, billing start); use get_company for full details.",
      transform: compactAccounts,
      timeoutMs: HEAVY_TIMEOUT_MS,
      input: { parentAccountId: accountId("parent") },
    },
    {
      name: "get_reseller_by_vat_id",
      operation: "GetResellerByVatId",
      title: "Get reseller by VAT ID",
      description: "Look up a reseller by its VAT ID.",
      input: { vatId: z.string().describe("The reseller's VAT ID.") },
    },
    {
      name: "get_company",
      operation: "GetCompany",
      title: "Get company",
      description: "Get a company by Account ID. If accountId is omitted, returns the current session user's company.",
      input: { accountId: accountId("company").optional() },
    },
    {
      name: "get_companies",
      operation: "GetCompanies",
      title: "List companies",
      description:
        "List the first-level companies under a parent Account ID. Under the country root account these are the resellers; " +
        "under a reseller, its customers."+" Returns compact rows (ID, name, type, state, VAT ID, country, currency, billing start); use get_company for full details.",
      transform: compactAccounts,
      timeoutMs: HEAVY_TIMEOUT_MS,
      input: { parentAccountId: accountId("parent") },
    },
    {
      name: "get_company_by_vat_id",
      operation: "GetCompanyByVatId",
      title: "Get company by VAT ID",
      description: "Look up a company by its VAT ID.",
      input: { vatId: z.string().describe("The company's VAT ID.") },
    },
    {
      name: "get_department",
      operation: "GetDepartment",
      title: "Get department",
      description: "Get a department by its Account ID.",
      input: { accountId: accountId("department") },
    },
    {
      name: "get_departments",
      operation: "GetDepartments",
      title: "List departments",
      description: "List the first-level departments under a parent (company) Account ID."+" Returns compact rows (ID, name, type, state, VAT ID, country, currency, billing start); use get_department for full details.",
      transform: compactAccounts,
      timeoutMs: HEAVY_TIMEOUT_MS,
      input: { parentAccountId: accountId("parent") },
    },
    {
      name: "get_user",
      operation: "GetUser",
      title: "Get user",
      description: "Get a user by Account ID. If accountId is omitted, returns the current session user.",
      input: { accountId: accountId("user").optional() },
    },
    {
      name: "get_users",
      operation: "GetUsers",
      title: "List users",
      description: "List all users under a company Account ID.",
      input: { companyAccountId: accountId("company") },
    },
    {
      name: "get_security_roles",
      operation: "GetSecurityRoles",
      title: "Get security roles",
      description: "Get the security roles (and their users) for a company or reseller account.",
      input: { accountId: accountId("company or reseller").optional() },
    },
  ]);
}
