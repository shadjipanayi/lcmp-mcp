import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarketplaceRegistry } from "../marketplaces.js";
import { HEAVY_TIMEOUT_MS } from "../reports.js";
import { accountId, registerReadTools, resellerContext } from "./helpers.js";

export function registerSubscriptionTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerReadTools(server, registry, [
    {
      name: "get_subscription",
      operation: "GetSubscription",
      title: "Get subscription",
      description: "Get a subscription by its subscription Account ID.",
      input: { accountId: accountId("subscription"), resellerContext },
    },
    {
      name: "get_subscriptions",
      operation: "GetSubscriptions",
      title: "List subscriptions",
      description:
        "List all subscriptions under a parent (company) Account ID, one compact row each (ID, service, state, " +
        "provisioning status, error). Use get_subscription or get_subscription_status for fields and end dates.",
      timeoutMs: HEAVY_TIMEOUT_MS,
      transform: (data) =>
        Array.isArray(data)
          ? {
              count: data.length,
              subscriptions: data.map((s: Record<string, unknown>) => ({
                accountId: s.AccountId,
                service: s.ServiceDisplayName ?? s.ServiceName,
                serviceName: s.ServiceName,
                vendor: s.VendorDisplayName ?? null,
                state: s.AccountState,
                provisioningStatus: s.ProvisioningStatus ?? s.Status ?? null,
                errorDetails: s.ErrorDetails || null,
                billingStartDate: s.BillingStartDate ?? null,
                vendorReferenceId: s.VendorReferenceId ?? null,
              })),
            }
          : data,
      input: {
        parentAccountId: accountId("parent"),
        resellerContext,
        excludeUserLevel: z.boolean().optional().describe("If true, user-level subscriptions are excluded."),
      },
    },
    {
      name: "get_subscription_with_addons",
      operation: "GetSubscriptionWithAddons",
      title: "Get subscription with add-ons",
      description: "Get a subscription by Account ID, including its add-ons.",
      input: { accountId: accountId("subscription"), resellerContext },
    },
    {
      name: "get_subscription_dependencies",
      operation: "GetSubscriptionDependencies",
      title: "Get subscription dependencies",
      description: "List the subscription dependency accounts for an Account ID.",
      input: { accountId: accountId(), resellerContext },
    },
    {
      name: "get_possible_services_for_parent",
      operation: "GetPossibleServicesForParent",
      title: "List services available to a parent",
      description: "List all services that can be subscribed to under the given parent (e.g. company) account.",
      input: { parentAccountId: accountId("parent") },
    },
    {
      name: "get_fields_for_service",
      operation: "GetFieldsForService",
      title: "Get fields for a service",
      description:
        "Get the fields (with drop-down and default values) needed to create a subscription to a service under a parent account.",
      input: {
        parentAccountId: accountId("parent"),
        productName: z.string().describe("Internal name of the service."),
        secondaryParentId: z
          .number()
          .int()
          .optional()
          .describe("Secondary parent subscription Account ID, required by some services."),
      },
    },
    {
      name: "get_remote_enums",
      operation: "GetRemoteEnums",
      title: "Get remote enum values",
      description:
        "Get enum values for a field that must be fetched from the service provider's backend (used when preparing a subscription).",
      input: {
        remoteEnumRequest: z.object({
          FieldName: z.string(),
          AccountViewName: z.string(),
          ParentAccountId: z.number().int(),
          AccountId: z.number().int().optional(),
          DependencyAccountId: z.number().int().optional(),
          ContextValues: z.record(z.string(), z.unknown()).optional(),
        }),
      },
    },
    {
      name: "get_account_custom_actions_with_fields",
      operation: "GetAccountCustomActionsWithFields",
      title: "List custom actions for a subscription",
      description: "List the custom actions (with their fields) available for a product subscription account.",
      input: { accountId: accountId("subscription") },
    },
    {
      name: "get_possible_services_for_upgrade",
      operation: "GetPossibleServicesForUpgrade",
      title: "List upgrade options",
      description: "List the services a subscription account can be upgraded to.",
      input: { accountId: accountId("subscription") },
    },
    {
      name: "get_subscription_fields_for_upgrade",
      operation: "GetSubscriptionFieldsForUpgrade",
      title: "Get upgrade fields",
      description: "Get the fields needed to upgrade a subscription account to a target product.",
      input: {
        accountId: accountId("subscription"),
        targetProductName: z.string().describe("Technical product name of the destination service."),
      },
    },
    {
      name: "get_subscription_fields_for_renew",
      operation: "GetSubscriptionFieldsForRenew",
      title: "Get renewal fields",
      description: "Get the renewal fields and values configured for a subscription account.",
      input: { accountId: accountId("subscription") },
    },
  ]);
}
