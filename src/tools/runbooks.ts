/**
 * Composite read-only tools that reproduce the checks of the CloudBUAA-New Azure Automation runbooks
 * (LogicomCloudBU/CloudBUAA-New/runbooks), one country marketplace per call.
 * They return the findings the runbooks email, and never perform the write steps some runbooks take (those are reported as
 * "suggestedAction" instead).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LcmpClient } from "../client.js";
import { PRODUCT_CODES } from "../knowledge.js";
import type { MarketplaceRegistry } from "../marketplaces.js";
import {
  HEAVY_TIMEOUT_MS,
  type Rec,
  daysUntil,
  isNce,
  isTrial,
  isoDay,
  mapLimit,
  num,
  parseDate,
  pick,
  runReport,
  str,
  subscriptionTerm,
  todayIn,
} from "../reports.js";
import { registerCompositeTool } from "./helpers.js";

/** Parallel GetSubscription calls per tool run; the API times out under heavy load, so stay gentle. */
const SUBSCRIPTION_CONCURRENCY = 4;

const bool = (v: unknown) => v === true || /^true$/i.test(str(v));

/**
 * Monthly-term subscriptions renew every month: NCE billing types end in "P1M" (e.g. "Monthly (with 1-month
 * commitment) - P1M"), and legacy CSP licences without advance payment are month-to-month.
 */
function isMonthlyTerm(billingType: unknown, nce: boolean, hasAdvancePayment: boolean): boolean {
  if (/P1M|1-month commitment/i.test(str(billingType))) return true;
  return !nce && !hasAdvancePayment;
}

interface SubscriptionTerm {
  endDate: string | null;
  daysUntilEnd: number | null;
  endDateAction: string | null;
}

/**
 * End date (shared subscriptionTerm precedence) and end-date action of a subscription.
 * Legacy subscriptions without advance payment always renew monthly.
 */
async function getSubscriptionTerm(client: LcmpClient, accountId: number, legacyMonthly: boolean): Promise<SubscriptionTerm> {
  const sub = (await client.call("GetSubscription", { accountId })) as Rec | null;
  if (!sub) return { endDate: null, daysUntilEnd: null, endDateAction: null };
  const { endDate, daysUntilEnd } = subscriptionTerm(sub);
  return { endDate, daysUntilEnd, endDateAction: legacyMonthly ? "Renew" : str(sub.AdvancePeriodEndAction) || null };
}

/**
 * Parses the forecast text the platform writes into Azure Plan / AWS Account fields, e.g.
 * "Forecast: 1234.50 EUR. Change of 23.4% in comparison to last invoice of 1000.00 EUR. Review Consumption".
 */
export function parseForecast(text: string) {
  const [head = "", tail = ""] = text.split(". ");
  const f = /:\s*(-?[\d.,]+)\s*([A-Za-z]{3})?/.exec(head);
  const c = /Change of\s+(\S+)/.exec(tail);
  const l = /last invoice of\s+(-?[\d.,]+)/.exec(tail);
  const rawChange = c?.[1]?.replace(/%$/, "") ?? "";
  const changePercent = rawChange.includes("∞") ? Infinity : num(rawChange);
  return {
    forecast: num(f?.[1]),
    currency: f?.[2] ?? null,
    lastInvoice: num(l?.[1]),
    changePercent: changePercent ?? null,
    flaggedByPlatform: /Review Consumption/i.test(text),
  };
}

/** Product field values come back either as a name -> value map or as a [{Name, Value}] list. */
function fieldMap(fields: unknown): Rec {
  if (Array.isArray(fields)) return Object.fromEntries((fields as Rec[]).map((f) => [str(f.Name), f.Value]));
  return fields && typeof fields === "object" ? (fields as Rec) : {};
}

export function registerRunbookTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerCompositeTool(server, registry, {
    name: "review_provisioning_requests",
    title: "Review waiting and failed provisioning",
    description:
      "Daily ops check (runbook AllMarketplacesWaitingAndFailedProvisionings). Runs the 'Waiting provisioning requests' and " +
      "'Failed provisioning details' reports and classifies waiting requests by age: 'stuck_renewal' = RENEW action still " +
      "WAITING after 1+ day; 'overdue' = any request waiting 2+ days; 'recent' otherwise. Failed requests list the target " +
      "account, product, action, CSP and the vendor error. If one report fails, the other half is still returned.",
    run: async (_args, client) => {
      // The runbook's 'Failed provisioning requests' report isn't granted to the MCP users; 'Failed provisioning
      // details' is (columns Target, ProductName, Action, CSP, ErrorDetails). The halves run independently.
      const [waitingResult, failedResult] = await Promise.allSettled([
        runReport(client, "Waiting provisioning requests"),
        runReport(client, "Failed provisioning details"),
      ]);
      const errors: string[] = [];
      if (waitingResult.status === "rejected") errors.push(`waiting requests: ${String(waitingResult.reason?.message ?? waitingResult.reason)}`);
      if (failedResult.status === "rejected") errors.push(`failed requests: ${String(failedResult.reason?.message ?? failedResult.reason)}`);
      if (errors.length === 2) throw new Error(errors.join(" | "));
      const waiting = waitingResult.status === "fulfilled" ? waitingResult.value : undefined;
      const failed = failedResult.status === "fulfilled" ? failedResult.value : undefined;

      const waitingItems = (waiting ?? []).map((r) => {
        const created = parseDate(pick(r, "createdate"));
        const ageDays = created ? -daysUntil(created) : null;
        const action = str(pick(r, "action")).toUpperCase();
        const status = str(pick(r, "status")).toUpperCase();
        const severity: "stuck_renewal" | "overdue" | "recent" =
          ageDays !== null && ageDays >= 1 && action === "RENEW" && status === "WAITING"
            ? "stuck_renewal"
            : ageDays !== null && ageDays >= 2
              ? "overdue"
              : "recent";
        return {
          severity,
          ageDays,
          accountId: pick(r, "AccountID"),
          companyAccountId: pick(r, "Company AccountId"),
          product: pick(r, "Product Display Name", "Product Name"),
          cspName: pick(r, "CSP Name"),
          action,
          status,
          createDate: pick(r, "createdate"),
          lastUpdateDate: pick(r, "lastupdatedate"),
        };
      });
      const order = { stuck_renewal: 0, overdue: 1, recent: 2 } as const;
      waitingItems.sort((a, b) => order[a.severity] - order[b.severity] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
      const failedItems = (failed ?? []).map((r) => ({
        target: pick(r, "Target"),
        product: pick(r, "ProductName"),
        action: pick(r, "Action"),
        csp: pick(r, "CSP"),
        // Vendor errors are long, escaped JSON blobs; the first 300 characters carry the code and description.
        errorDetails: str(pick(r, "ErrorDetails")).replace(/\s+/g, " ").trim().slice(0, 300) || null,
      }));
      const failedByProduct = Object.entries(
        failedItems.reduce<Record<string, number>>((acc, f) => {
          const key = str(f.product) || "(unknown)";
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([product, count]) => ({ product, count }));
      return {
        summary: {
          ...(waiting ? {
            waiting: waitingItems.length,
            stuckRenewals: waitingItems.filter((w) => w.severity === "stuck_renewal").length,
            overdue: waitingItems.filter((w) => w.severity === "overdue").length,
          } : {}),
          ...(failed ? { failed: failedItems.length, failedByProduct } : {}),
        },
        ...(errors.length ? { errors } : {}),
        suggestedAction:
          "Investigate stuck/overdue items and failed requests with get_subscription_status. Retrying a failed provisioning " +
          "(RetryLastFailedProvisioning) is a write operation and must be done in the Marketplace UI.",
        ...(waiting ? { waiting: waitingItems } : {}),
        ...(failed ? { failed: failedItems } : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_credit_health",
    title: "Review reseller credit limits and credit orders",
    description:
      "Credit-control check (runbooks AllResellersCreditLimits, CountriesResellersCreditLimitNotSet, " +
      "AllMarketplacesCreditOrdersReviewStatus). Runs the 'Credit Limits' report and lists resellers with no credit limit " +
      "set and resellers whose remaining limit is negative (over limit), then lists credit-check orders pending approval " +
      "and the most recent completed ones.",
    input: {
      recentCompletedOrders: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("How many recently completed credit orders to include (default 20)."),
    },
    run: async ({ recentCompletedOrders = 20 }, client) => {
      // The two halves need different permissions; report a failure in one without losing the other.
      const [limitsResult, ordersResult] = await Promise.allSettled([
        runReport(client, "Credit Limits"),
        client.call("ListCreditCheckOrdersForApproval", {}, HEAVY_TIMEOUT_MS) as Promise<Rec[] | null>,
      ]);
      const errors: string[] = [];
      if (limitsResult.status === "rejected") errors.push(`credit limits: ${String(limitsResult.reason?.message ?? limitsResult.reason)}`);
      if (ordersResult.status === "rejected") errors.push(`credit orders: ${String(ordersResult.reason?.message ?? ordersResult.reason)}`);
      if (errors.length === 2) throw new Error(errors.join(" | "));
      const limits = limitsResult.status === "fulfilled" ? limitsResult.value : undefined;
      const orders = ordersResult.status === "fulfilled" ? ordersResult.value : undefined;
      const resellers = (limits ?? []).map((r) => ({
        rootOrganization: pick(r, "Root Organization"),
        accountId: pick(r, "AccountId"),
        displayName: pick(r, "DisplayName"),
        vatId: pick(r, "VATID"),
        country: pick(r, "Country"),
        createDate: pick(r, "CreateDate"),
        limit: num(pick(r, "Limit")) ?? null,
        currency: pick(r, "Currency"),
        currentInvoiceAmount: num(pick(r, "current invoice amount")) ?? null,
        remainingLimit: num(pick(r, "Remaining Limit")) ?? null,
        totalRemainingCommitment: num(pick(r, "TotalRemainingCommitment")) ?? null,
      }));
      const noLimit = resellers.filter((r) => r.limit === null);
      const overLimit = resellers
        .filter((r) => r.remainingLimit !== null && r.remainingLimit < 0)
        .sort((a, b) => (a.remainingLimit ?? 0) - (b.remainingLimit ?? 0));

      const orderFields = (o: Rec) => ({
        requestId: o.RequestId,
        hierarchy: o.Hierarchy,
        createdBy: o.CreatedByDisplayName,
        creationDate: o.CreationDate,
        payer: o.PayerCompanyName,
        payerCurrency: o.PayerCurrency,
        endCustomer: o.EndCustomerName,
        product: o.ProductDisplayName,
        billableFields: o.BillableFields,
        currentLimit: o.CurrentLimit,
        projectedInvoice: o.ProjectedInvoice,
        dailyTransactions: o.DailyTransactions,
        transactionValue: o.TransactionValue,
        approvalStatus: o.ApprovalStatus,
        statusDate: o.StatusDate,
        statusUpdatedBy: o.StatusUpdatedByDisplayName,
        comment: o.Comment,
      });
      const allOrders = Array.isArray(orders) ? orders : [];
      const pending = allOrders.filter((o) => str(o.ApprovalStatus).toUpperCase() === "PENDING").map(orderFields);
      const completed = allOrders
        .filter((o) => str(o.ApprovalStatus).toUpperCase() !== "PENDING")
        .sort((a, b) => (parseDate(b.StatusDate)?.getTime() ?? 0) - (parseDate(a.StatusDate)?.getTime() ?? 0))
        .map(orderFields);

      return {
        summary: {
          ...(limits ? { resellers: resellers.length, noCreditLimitSet: noLimit.length, overCreditLimit: overLimit.length } : {}),
          ...(orders !== undefined ? { pendingCreditOrders: pending.length, completedCreditOrders: completed.length } : {}),
        },
        ...(errors.length ? { errors } : {}),
        suggestedAction:
          "Policy: resellers without a credit limit get it set to 0 (the CountriesResellersCreditLimitNotSet runbook does this " +
          "daily) and Finance reviews them. Over-limit resellers block new orders through credit-check approval. " +
          "Setting limits and approving/declining orders are write operations and are not available in this server.",
        ...(limits ? { noCreditLimitSet: noLimit, overCreditLimit: overLimit } : {}),
        ...(orders !== undefined
          ? { pendingCreditOrders: pending, recentCompletedCreditOrders: completed.slice(0, recentCompletedOrders) }
          : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_upcoming_renewals",
    title: "Review upcoming Microsoft CSP renewals",
    description:
      "Renewal check (runbook AllMarketplacesCSPSubscriptionsEndDateAction). Combines the 'Price Protected Services', " +
      "'MSCSPSeats' and 'Scheduled Terminations' reports: shortlists non-trial CSP subscriptions whose term ends within " +
      "`withinDays`, then calls GetSubscription for each to get the end date and end-date action (Renew/Terminate). " +
      "Urgency: 'past_end_date' (<0 days, check why it is still active), 'urgent' (0-31), 'soon' (32-60), 'later'. " +
      "By default only subscriptions with a term of a year or more are listed: monthly terms (NCE P1M, legacy monthly) " +
      "renew every month and would swamp the list (thousands per country). " +
      "Makes one GetSubscription call per shortlisted subscription, so it can take a few minutes.",
    input: {
      withinDays: z.number().int().min(1).max(366).optional().describe("Look-ahead window in days (default 60, as in the runbook)."),
      maxSubscriptions: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Cap on GetSubscription calls (default 150); the soonest-ending subscriptions are checked first."),
      includeMonthlyTerms: z
        .boolean()
        .optional()
        .describe("Also list monthly-term subscriptions (NCE P1M, legacy monthly), which renew every month (default false)."),
    },
    run: async ({ withinDays = 60, maxSubscriptions = 150, includeMonthlyTerms = false }, client) => {
      const [priceProtected, seats, scheduled] = await Promise.all([
        runReport(client, "Price Protected Services"),
        runReport(client, "MSCSPSeats"),
        runReport(client, "Scheduled Terminations"),
      ]);
      const scheduledIds = new Set(scheduled.map((r) => str(pick(r, "Subscription account Id"))));
      const seatsById = new Map(seats.map((r) => [str(pick(r, "accountId")), r]));

      // The report has one row per priceable item, so a subscription can appear several times: keep its earliest end.
      const earliest = new Map<string, Rec>();
      for (const r of priceProtected) {
        const id = str(pick(r, "AccountId"));
        const end = parseDate(pick(r, "EndDate"));
        const prevEnd = earliest.has(id) ? parseDate(pick(earliest.get(id)!, "EndDate")) : undefined;
        if (!earliest.has(id) || (end && (!prevEnd || end < prevEnd))) earliest.set(id, r);
      }
      const shortlist = [...earliest.values()]
        .map((r) => {
          const end = parseDate(pick(r, "EndDate"));
          return { r, days: end ? daysUntil(end) : undefined };
        })
        .filter((x): x is { r: Rec; days: number } => x.days !== undefined && x.days <= withinDays)
        .filter((x) => {
          const s = seatsById.get(str(pick(x.r, "AccountId")));
          return s !== undefined && !isTrial(pick(s, "BillingType"));
        })
        .sort((a, b) => a.days - b.days);
      const monthly = (x: { r: Rec }) => {
        const s = seatsById.get(str(pick(x.r, "AccountId")))!;
        return isMonthlyTerm(pick(s, "BillingType"), isNce(pick(s, "ProductDisplayName")), bool(pick(s, "hasAdvancePayment")));
      };
      const monthlyCount = shortlist.filter(monthly).length;
      const listed = includeMonthlyTerms ? shortlist : shortlist.filter((x) => !monthly(x));

      const toCheck = listed.slice(0, maxSubscriptions);
      const errors: { accountId: string; error: string }[] = [];
      const renewals = await mapLimit(toCheck, SUBSCRIPTION_CONCURRENCY, async ({ r }) => {
        const accountId = str(pick(r, "AccountId"));
        const s = seatsById.get(accountId)!;
        const nce = isNce(pick(s, "ProductDisplayName"));
        const advance = bool(pick(s, "hasAdvancePayment"));
        // Fallback if GetSubscription fails: the report's own end date.
        const reportEnd = parseDate(pick(r, "EndDate"));
        let term: SubscriptionTerm = {
          endDate: isoDay(reportEnd),
          daysUntilEnd: reportEnd ? daysUntil(reportEnd) : null,
          endDateAction: null,
        };
        try {
          term = await getSubscriptionTerm(client, Number(accountId), !nce && !advance);
        } catch (err) {
          errors.push({ accountId, error: err instanceof Error ? err.message : String(err) });
        }
        const days = term.daysUntilEnd;
        return {
          urgency: days === null ? "unknown" : days < 0 ? "past_end_date" : days <= 31 ? "urgent" : days <= 60 ? "soon" : "later",
          daysUntilEnd: days,
          endDate: term.endDate,
          endDateAction: term.endDateAction,
          scheduledTermination: scheduledIds.has(accountId),
          accountId: Number(accountId),
          reseller: pick(s, "reseller"),
          customer: pick(s, "companyName"),
          product: pick(s, "ProductDisplayName"),
          model: nce ? "NCE" : "Legacy",
          seats: pick(s, "seats"),
          billingType: pick(s, "BillingType"),
          hasAdvancePayment: advance,
        };
      });
      renewals.sort((a, b) => (a.daysUntilEnd ?? 1e9) - (b.daysUntilEnd ?? 1e9));

      return {
        summary: {
          withinDays,
          endingInWindow: shortlist.length,
          monthlyTermsInWindow: monthlyCount,
          listed: listed.length,
          checked: toCheck.length,
          urgent: renewals.filter((x) => x.urgency === "urgent").length,
          soon: renewals.filter((x) => x.urgency === "soon").length,
          pastEndDate: renewals.filter((x) => x.urgency === "past_end_date").length,
          willTerminate: renewals.filter((x) => x.scheduledTermination || /terminate/i.test(str(x.endDateAction))).length,
        },
        notes: [
          "Model is NCE when the product name contains '(NCE)', otherwise Legacy.",
          "Legacy monthly (no advance payment) subscriptions always renew; for others the action comes from the subscription.",
          ...(includeMonthlyTerms
            ? []
            : [`${monthlyCount} monthly-term subscriptions in the window are left out (they renew every month); set includeMonthlyTerms to list them.`]),
          ...(listed.length > toCheck.length
            ? [`Only the ${toCheck.length} soonest-ending of ${listed.length} subscriptions were checked; raise maxSubscriptions to see more.`]
            : []),
        ],
        renewals,
        errors,
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_nce_trials",
    title: "Review NCE trial subscriptions",
    description:
      "Trial check (runbook AllMarketplacesNCETrialsSetToBeTerminated). Finds NCE trial subscriptions in the 'MSCSPSeats' " +
      "report and reads each one's end-date action. Trials still set to 'Renew' will convert to paid subscriptions at the " +
      "end of the trial; company policy (applied daily by the runbook) is to switch them to 'Terminate'.",
    input: {
      maxSubscriptions: z.number().int().min(1).max(1000).optional().describe("Cap on GetSubscription calls (default 150)."),
    },
    run: async ({ maxSubscriptions = 150 }, client) => {
      const seats = await runReport(client, "MSCSPSeats");
      const trials = seats.filter((r) => isTrial(pick(r, "BillingType")) && isNce(pick(r, "ProductDisplayName")));
      const toCheck = trials.slice(0, maxSubscriptions);
      const errors: { accountId: string; error: string }[] = [];
      const items = await mapLimit(toCheck, SUBSCRIPTION_CONCURRENCY, async (r) => {
        const accountId = str(pick(r, "accountId"));
        let term: SubscriptionTerm = { endDate: null, daysUntilEnd: null, endDateAction: null };
        try {
          term = await getSubscriptionTerm(client, Number(accountId), false);
        } catch (err) {
          errors.push({ accountId, error: err instanceof Error ? err.message : String(err) });
        }
        return {
          willConvertToPaid: /renew/i.test(str(term.endDateAction)),
          endDateAction: term.endDateAction,
          trialEndDate: term.endDate,
          daysLeft: term.daysUntilEnd,
          accountId: Number(accountId),
          reseller: pick(r, "reseller"),
          customer: pick(r, "companyName"),
          product: pick(r, "ProductDisplayName"),
          seats: pick(r, "seats"),
        };
      });
      items.sort((a, b) => Number(b.willConvertToPaid) - Number(a.willConvertToPaid) || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
      return {
        summary: {
          nceTrials: trials.length,
          checked: toCheck.length,
          setToRenew: items.filter((i) => i.willConvertToPaid).length,
        },
        suggestedAction:
          "Trials set to 'Renew' should be switched to 'Terminate' unless the reseller confirmed the conversion. " +
          "Changing the end-date action is a write operation and is not available in this server.",
        trials: items,
        errors,
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_seat_changes",
    title: "Review Microsoft CSP seat changes",
    description:
      "Seat movement check (runbooks *SeatChangesDaily, DailyManagementReport). Runs the 'MSCSPSeatDelta' report for a date " +
      "range, totals seats added and removed (trials excluded), and lists the individual changes whose absolute delta is at " +
      "least `threshold` (country reports use 1, the management report uses 100).",
    input: {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD (default today, in the marketplace's local time zone)."),
      endDate: z.string().optional().describe("End date YYYY-MM-DD, exclusive (default the day after startDate)."),
      threshold: z.number().int().min(1).optional().describe("Minimum absolute seat delta to list a change (default 1)."),
    },
    run: async ({ startDate, endDate, threshold = 1 }, client, m) => {
      const start = parseDate(startDate ?? todayIn(m.timeZone));
      if (!start) throw new Error(`Invalid startDate: ${startDate}`);
      const end = endDate ? parseDate(endDate) : new Date(start.getTime() + 86_400_000);
      if (!end) throw new Error(`Invalid endDate: ${endDate}`);
      const params = { StartDate: isoDay(start), EndDate: isoDay(end) };
      const rows = (await runReport(client, "MSCSPSeatDelta", params)).filter((r) => !isTrial(pick(r, "BillingType")));

      let added = 0;
      let removed = 0;
      for (const r of rows) {
        const d = num(pick(r, "SeatDelta")) ?? 0;
        if (d > 0) added += d;
        else removed += d;
      }
      const changes = rows
        .filter((r) => Math.abs(num(pick(r, "SeatDelta")) ?? 0) >= threshold)
        .map((r) => ({
          seatDelta: num(pick(r, "SeatDelta")),
          seatsAtStart: num(pick(r, "SeatsAtStart")),
          seatsAtEnd: num(pick(r, "SeatsAtEnd")),
          reseller: pick(r, "Reseller"),
          resellerCountry: pick(r, "Country"),
          customer: pick(r, "CompanyName"),
          product: pick(r, "ProductDisplayName"),
          model: isNce(pick(r, "ProductDisplayName")) ? "NCE" : "Legacy",
          billingType: pick(r, "BillingType"),
          accountId: pick(r, "AccountID"),
        }))
        .sort((a, b) => Math.abs(b.seatDelta ?? 0) - Math.abs(a.seatDelta ?? 0));

      return {
        period: params,
        summary: { seatsAdded: added, seatsRemoved: removed, netDelta: added + removed, changesListed: changes.length, threshold },
        changes,
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_consumption_forecast",
    title: "Review Azure Plan / AWS consumption forecasts",
    description:
      "Consumption forecast check (runbooks AllMarketplacesAzurePlanswithHighForecastedGrowth, " +
      "AllMarketplacesAzurePlansWithDeclinedGrowth, AllMarketplacesAWSAccountswithHighForecastedGrowth, " +
      "AllMarketplacesAzurePlanUnmanagedResources). Reads every Azure Plan or AWS Account with its forecast field " +
      "(GetAllProductAccountsWithFieldsReport) and returns: 'growth' = forecast >= minForecast and change >= " +
      "minChangePercent (or infinite change from zero); 'decline' = forecast below last invoice or negative change. " +
      "For Azure it also lists plans with unmanaged resources. Amounts are SRP in the marketplace currency. " +
      "This report is slow (it has timed out at 300 s on large marketplaces).",
    input: {
      product: z.enum(["azure_plan", "aws_account"]).optional().describe("Which product to analyse (default azure_plan)."),
      mode: z.enum(["growth", "decline"]).optional().describe("Which accounts to list (default growth)."),
      minForecast: z.number().optional().describe("Growth mode: minimum current-month forecast (default 1000)."),
      minChangePercent: z.number().optional().describe("Growth mode: minimum % change vs last invoice (default 20)."),
    },
    run: async ({ product = "azure_plan", mode = "growth", minForecast = 1000, minChangePercent = 20 }, client) => {
      const productName = product === "aws_account" ? PRODUCT_CODES.awsAccount : PRODUCT_CODES.azurePlan;
      const data = (await client.call("GetAllProductAccountsWithFieldsReport", { productName }, HEAVY_TIMEOUT_MS)) as Rec | null;
      const accounts = Array.isArray(data?.AllProductAccountsWithFields) ? (data!.AllProductAccountsWithFields as Rec[]) : [];

      const rows = accounts.map((a) => {
        const fields = fieldMap(a.Fields);
        const text = str(product === "aws_account" ? fields.ComparisonForecastCurrentMonth : fields.MonthlybillforecastEndcustomer);
        const parsed = text && !/n\/a/i.test(text) ? parseForecast(text) : undefined;
        return {
          reseller: a.ResellerName,
          customer: a.CompanyName,
          accountId: a.AccountId,
          name: product === "aws_account" ? fields.AWSAccountName : fields.Azureplanname,
          lastMonthUsage: parsed?.lastInvoice ?? null,
          currentMonthForecast: parsed?.forecast ?? null,
          changePercent: parsed?.changePercent === Infinity ? "∞" : (parsed?.changePercent ?? null),
          currency: parsed?.currency ?? null,
          flaggedByPlatform: parsed?.flaggedByPlatform ?? false,
          _change: parsed?.changePercent ?? null,
          _unmanaged: num(fields.Unmanagedresources) ?? 0,
          _managed: num(fields.Managedresources) ?? null,
        };
      });

      const selected =
        mode === "growth"
          ? rows
              .filter(
                (r) =>
                  r.currentMonthForecast !== null &&
                  r.currentMonthForecast >= minForecast &&
                  r._change !== null &&
                  (r._change === Infinity || r._change >= minChangePercent),
              )
              .sort((a, b) => (b.currentMonthForecast ?? 0) - (a.currentMonthForecast ?? 0))
          : rows
              .filter(
                (r) =>
                  r.currentMonthForecast !== null &&
                  ((r.lastMonthUsage !== null && r.currentMonthForecast < r.lastMonthUsage) || (r._change !== null && r._change < 0)),
              )
              .sort((a, b) => (a._change ?? 0) - (b._change ?? 0));

      const strip = ({ _change, _unmanaged, _managed, ...rest }: (typeof rows)[number]) => rest;
      const unmanaged =
        product === "azure_plan"
          ? rows
              // ALSO's own internal tenant is excluded, as in the runbook.
              .filter((r) => r._unmanaged > 0 && str(r.customer) !== "ALSO International Services GmbH")
              .map((r) => ({ ...strip(r), managedResources: r._managed, unmanagedResources: r._unmanaged }))
          : undefined;

      return {
        product: productName,
        mode,
        summary: {
          accounts: rows.length,
          withForecast: rows.filter((r) => r.currentMonthForecast !== null).length,
          listed: selected.length,
          ...(unmanaged ? { plansWithUnmanagedResources: unmanaged.length } : {}),
        },
        rule:
          mode === "growth"
            ? `currentMonthForecast >= ${minForecast} and changePercent >= ${minChangePercent}% (or ∞). changePercent = (forecast - lastMonthUsage) / lastMonthUsage; the forecast comes from Azure Cost Management / AWS.`
            : "currentMonthForecast < lastMonthUsage or changePercent < 0.",
        accounts: selected.map(strip),
        ...(unmanaged ? { plansWithUnmanagedResources: unmanaged } : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "review_inactive_resellers",
    title: "Review inactive resellers",
    description:
      "Reseller activity check (runbook AllMarketplacesInactiveResellers). Uses the 'MSCSP Resellers' report (last month's " +
      "billing per reseller) and the 'All Products with billable fields' report. A non-terminated reseller is inactive when " +
      "its last-month TOTAL is 0; it is then split into resellers that still own billable (non-trial) products and those " +
      "with none, which are candidates for clean-up or re-engagement.",
    run: async (_args, client) => {
      const [resellers, products] = await Promise.all([
        runReport(client, "MSCSP Resellers"),
        runReport(client, "All Products with billable fields"),
      ]);
      const withProducts = new Set(
        products.filter((p) => !/trial/i.test(str(pick(p, "Billable_Fields")))).map((p) => str(pick(p, "Reseller"))),
      );
      const active = resellers.filter((r) => str(pick(r, "accountstate")) !== "Terminated");
      const inactive = active
        .filter((r) => (num(pick(r, "TOTAL")) ?? 0) === 0)
        .map((r) => ({
          accountId: pick(r, "accountid"),
          reseller: pick(r, "resellername"),
          accountState: pick(r, "accountstate"),
          createdOn: pick(r, "createdOn"),
          termsAccepted: pick(r, "TCAccepted"),
          hasBillableProducts: withProducts.has(str(pick(r, "resellername"))),
        }));
      return {
        summary: {
          resellers: active.length,
          inactiveLastMonth: inactive.length,
          inactiveWithoutProducts: inactive.filter((r) => !r.hasBillableProducts).length,
          inactiveWithProducts: inactive.filter((r) => r.hasBillableProducts).length,
        },
        inactiveWithoutProducts: inactive.filter((r) => !r.hasBillableProducts),
        inactiveWithProducts: inactive.filter((r) => r.hasBillableProducts),
      };
    },
  });
}
