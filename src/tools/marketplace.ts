import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarketplaceRegistry } from "../marketplaces.js";
import { registerReadTools, serviceFilters } from "./helpers.js";

const marketplaceId = z.number().int().describe("The marketplace ID (see get_marketplaces).");

export function registerMarketplaceTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerReadTools(server, registry, [
    {
      name: "get_marketplaces",
      operation: "GetMarketplaces",
      title: "List marketplaces",
      description: "List the marketplaces owned by the authenticated user's company.",
    },
    {
      name: "list_marketplace_services",
      operation: "ListMarketplaceServices",
      title: "List marketplace services",
      description: "List all services in a marketplace.",
      input: { marketplaceId },
    },
    {
      name: "get_available_services_for_marketplace",
      operation: "GetAvailableServicesForMarketplace",
      title: "List services that can be added to a marketplace",
      description: "List the services that are available to add to a marketplace.",
      input: { marketplaceId, filters: z.array(serviceFilters).optional() },
    },
    {
      name: "get_marketplace_service_charges",
      operation: "GetMarketplaceServiceCharges",
      title: "Get marketplace prices",
      description: "Get the services in a marketplace and the prices currently set for them.",
      input: { marketplaceId, filters: serviceFilters.optional() },
    },
    {
      name: "get_service_information",
      operation: "GetServiceInformation",
      title: "Get service information",
      description: "Get information about a service by its service name.",
      input: { serviceName: z.string().describe("The service name.") },
    },
    {
      name: "get_special_product_terms_for_service",
      operation: "GetSpecialProductTermsForService",
      title: "Get service terms and conditions",
      description: "List a service's terms and conditions, with the related products.",
      input: { productName: z.string().describe("The product name.") },
    },
  ]);
}
