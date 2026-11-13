/**
 * Business knowledge taken from the production Azure Automation runbooks (CloudBUAA-New).
 * Shown to the model in tool descriptions so it can pick the right report or product without trial and error.
 */

/** Technical product names (for GetAllProductAccountsWithFieldsReport `productName`). */
export const PRODUCT_CODES = {
  azurePlan: "156469_AzurePlan_88587",
  azurePlanGranular: "156469_AzurePlansubscriptionforGranularmode_65641",
  msTenant: "156469_LGCMMicrosoftOrganizationtenant_12230",
  azureSubscriptionLegacy: "156469_LGCMMicrosoftAzureSubscription_72859",
  azureRiLegacy: "156469_AzureRI_76468",
  azurePlanRiMonthly: "156469_AzureReservedInstanceforAzurePlanMonthlyBilled_31967",
  azurePlanRi1YPrepaid: "156469_AzureReservedInstanceforAzurePlan1YearPrepaid_82976",
  azurePlanRi3YPrepaid: "156469_AzureReservedInstanceforAzurePlan3YearPrepaid_97757",
  awsAccount: "1061629_AWSAccount_64094",
  awsExchangeRate: "1061629_AWSExchangeRate_17937",
  goldSupport: "246400_GoldSupportforPartners_37586",
  goldSupportYearly: "246400_GoldSupportforPartnersYearly_39220",
  platinumSupport: "246400_PlatinumSupportforPartners_18838",
  platinumSupportYearly: "246400_PlatinumSupportforPartnersYearly_42311",
} as const;

export const PRODUCT_CATALOGUE = `Known productName values: Azure Plan ${PRODUCT_CODES.azurePlan} (fields Azureplanname, Managedresources, Unmanagedresources, MonthlybillforecastEndcustomer); Azure Plan granular ${PRODUCT_CODES.azurePlanGranular}; Microsoft tenant ${PRODUCT_CODES.msTenant} (MicrosoftTenantId); legacy Azure subscription ${PRODUCT_CODES.azureSubscriptionLegacy}; legacy Azure RI ${PRODUCT_CODES.azureRiLegacy}; Azure Plan RI monthly ${PRODUCT_CODES.azurePlanRiMonthly}, 1Y prepaid ${PRODUCT_CODES.azurePlanRi1YPrepaid}, 3Y prepaid ${PRODUCT_CODES.azurePlanRi3YPrepaid}; AWS account ${PRODUCT_CODES.awsAccount} (AWSAccountName, TotalUsageForecastCurrentMonth, ComparisonForecastCurrentMonth); AWS exchange rate ${PRODUCT_CODES.awsExchangeRate}; CCC support plans Gold ${PRODUCT_CODES.goldSupport} / yearly ${PRODUCT_CODES.goldSupportYearly}, Platinum ${PRODUCT_CODES.platinumSupport} / yearly ${PRODUCT_CODES.platinumSupportYearly}.`;

export const REPORT_CATALOGUE = `Reports used in production (names are exact): "MSCSPSeats" (current Microsoft CSP seats per subscription: reseller, companyName, accountId, ProductDisplayName, BillingType, seats, hasAdvancePayment); "MSCSPSeatDelta" and "MSCSPSeatChanges" (seat changes, parameters {"StartDate","EndDate"} as YYYY-MM-DD); "MSCSPSoftware"; "MSCSP Resellers" (last-month billing per reseller: MS_Licences, MS_NCE, MS_Azure, MS_Software, TOTAL); "Resellers"; "Reseller information"; "Credit Limits" (Limit, current invoice amount, Remaining Limit per reseller); "Price Protected Services" (term end dates); "Scheduled Terminations"; "Renewal Overview"; "Waiting provisioning requests"; "Failed provisioning details" (Target, ProductName, Action, CSP, ErrorDetails); "Failed provisioning resolutions" (history, parameters {"StartDate","EndDate"}); "Termination reasons"; "Invoice Aggregation"; "All Products with billable fields"; "SpecialDealDiscounts". Products whose display name contains "(NCE)" are New Commerce; the rest are Legacy CSP. Rows with "ZZ_Total" are summary rows.`;

/**
 * Reports execute_report refuses to run: they take minutes and load the platform (e.g. "Failed provisioning statistics"
 * was still running after 60 s on CYMA). Matched case-insensitively. Add a name here to disable another report.
 */
export const BLOCKED_REPORTS = ["Failed provisioning statistics"];

/**
 * How long a report's result is reused (ms). Reports on a closed period (last month's billing, billable product
 * fields) change little in a day; provisioning and credit data change by the minute. Others get the default.
 */
const DEFAULT_REPORT_TTL_MS = 15 * 60 * 1000;
const REPORT_TTL_MS: Record<string, number> = {
  "mscsp resellers": 6 * 60 * 60 * 1000,
  "all products with billable fields": 6 * 60 * 60 * 1000,
  "waiting provisioning requests": 5 * 60 * 1000,
  "failed provisioning details": 5 * 60 * 1000,
  "credit limits": 5 * 60 * 1000,
};

export const reportTtlMs = (name: string) => REPORT_TTL_MS[name.trim().toLowerCase()] ?? DEFAULT_REPORT_TTL_MS;

export const isBlockedReport = (name: string) =>
  BLOCKED_REPORTS.some((blocked) => blocked.toLowerCase() === name.trim().toLowerCase());
