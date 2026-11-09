# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only MCP server (stdio for Claude Code/Desktop, Streamable HTTP for Azure/Copilot Studio) for the Logicom Cloud Marketplace SimpleAPI, used by internal and support staff so they don't have to log in to each country marketplace separately. It must stay read-only. `openapi.json` is the local copy of the API spec — consult it for operation names, request body fields and response shapes when adding or changing tools. The spec differs from the live API (verified on CYMA):

- Report rows are `Rows[{Cells}]`.
- Subscriptions have `ProvisioningStatus` (not `Status`).
- Only `GetSubscription` returns the term dates (`PriceProtectionEndDate`, `AdvancePeriodEndAction`, `ContractEndDate`); the `GetSubscriptions` list doesn't.
- The country root account (`GetCompany({})`) has `AccountType: "Reseller"`, like the resellers under it.
- Microsoft products' technical names start with `156469_`.
- Product fields include secrets such as the tenant `InitialPassword`: `redactSecrets` in `helpers.ts` blanks them in every tool result. Keep it on the output path of any new tool.

## Commands

- `npm run build` — compile `src/` to `dist/` with `tsc`
- `npm run typecheck` — type-check only
- `npm test` — offline tests in `test/` (node:test via tsx; the API client is faked, Entra tokens are signed locally). Run one: `node --import tsx --test --test-name-pattern="VAT" test/core.test.ts`
- `npm run dev` — run the server from source with `tsx`
- `npm run smoke` — end-to-end check: spawns `dist/index.js` (so build first) and calls a handful of tools. Defaults to the SwaggerHub mock server with dummy credentials; set `LCMP_BASE_URL`/`LCMP_USERNAME`/`LCMP_PASSWORD` to hit a real instance. `ping` failing on the mock is expected (the mock can't answer operations with empty response bodies).
- `npm run inspect` — open the MCP Inspector against `dist/index.js`

There is no linter. To exercise a tool against the mock API, add an entry to the `calls` array in `scripts/smoke-test.mjs`, or use the Inspector.

Config is via env vars: `LCMP_BASE_URL`, `LCMP_MARKETPLACES` (codes) and `LCMP_<CODE>_USERNAME`/`_PASSWORD` per marketplace, or `LCMP_USERNAME`/`LCMP_PASSWORD` for a single marketplace; see `.env.example`. API users must not have MFA enabled.

## Architecture

- **Entry points**: `src/index.ts` picks the transport (stdio by default; `--http` or `MCP_TRANSPORT=http` for HTTP). `src/server.ts` `createServer(registry)` registers all tools; `src/http.ts` serves stateless `POST /mcp` (a fresh `McpServer` per request; sessions and caches live in the registry/module scope) and `GET /health`. `src/auth.ts` validates Entra ID tokens (tenant JWKS, v1/v2 issuer, audience, required app role `LCMP.Read`); HTTP mode won't start without `ENTRA_TENANT_ID`/`ENTRA_AUDIENCE` unless `MCP_AUTH=none` on a loopback host. The `Dockerfile` builds the hosted image.
- **API shape**: every operation is `POST {baseUrl}/{OperationName}` with a JSON body. Success responses are JSON (or empty); error responses are usually XML.
- **`src/client.ts` (`LcmpClient`)**: lazily logs in via `GetSessionToken` on first call, sends `Authenticate: CCPSessionId <token>`, de-duplicates concurrent logins, and on a session error re-logs in and retries once. Two FIFO queues per marketplace user cap requests in flight: quick calls (`LCMP_MAX_CONCURRENCY`, default 3) and heavy calls (any `timeoutMs` above the default, i.e. reports and big lists: 2), so a long report never blocks quick lookups or the token check. A token is trusted for `TOKEN_TTL_MS` (3.5 h) after login or its last check; after that it is verified with `PingPong` and replaced only if invalid. Never call `TerminateSessionToken`: each marketplace's MCP API user is shared by the whole team, so ending a session could log out a colleague.
- **`src/marketplaces.ts`**: one `LcmpClient` per country marketplace (same base URL, a dedicated MCP API user per country) in a `MarketplaceRegistry`. **Every call targets exactly one marketplace — never fan out across countries.** Each tool gets an injected `marketplace` input (an enum of configured codes, required unless only one is configured); `runInMarketplace` resolves it, runs the call and labels the result. A lookup that returns `undefined` or throws `NotFoundError` becomes a "not found in this marketplace" error. Each marketplace has a local time zone (`KNOWN_MARKETPLACES`), used for "today" in date-based reports.
- **Support tools (`src/tools/support.ts`)**: `find_account`, `get_customer_overview`, `get_subscription_status`, `get_customer_invoices`. Hierarchy: distributor root (`GetCompany({})`) → resellers (`GetCompanies(root)`) → customers (`GetCompanies(reseller)`). Name search uses a 6 h in-memory directory per marketplace; concurrent builds are shared. `lookup()` turns only the API's "not in this marketplace" errors (`NOT_FOUND` in `support.ts`: "Invalid account id", "Not enough permissions to get account details", ...) into `NotFoundError` (carrying the API's wording, because the API says the same for a wrong ID and a missing permission) and rethrows everything else; `optional()` turns `NotFoundError` into `undefined` for secondary lookups. A VAT ID shared by several accounts is an error listing them, never "the first one". End dates come from the shared `subscriptionTerm` in `reports.ts`; don't copy that logic. Invoices go to resellers; customer lines are matched by subscription `AccountId` or `EndCustomerName`.
- **`src/errors.ts`**: `LcmpApiError` plus `extractErrorMessage`, which digs a readable message out of XML/JSON/text error bodies. `isSessionError` drives the retry in the client.
- **`src/tools/*.ts`**: tools are declared as data (`ReadToolSpec`: `name`, `operation`, `title`, `description`, zod `input` shape) grouped by domain (accounts, subscriptions, billing, marketplace) and registered via `registerReadTools` in `src/tools/helpers.ts`. Zod input keys are sent verbatim as the request body, so they must match the API's field names; undefined optional args are stripped before sending. Shared field schemas (`accountId`, `resellerContext`, `serviceFilters`, …) live in `helpers.ts`.
- **Results**: `formatResult` redacts secrets, serialises compact JSON (no indentation, to save context) and truncates at `MAX_RESPONSE_CHARS` (100k). List tools (`get_companies`, `get_resellers`, `get_departments`, `get_subscriptions`) use a `transform` to return compact rows; a country's full reseller records are ~200k chars. Give new list tools the same treatment. Tool errors are returned as `isError` content, not thrown. `handle()` in `helpers.ts` wraps every tool call and writes one JSON `tool_call` line to stderr (tool, marketplace, Entra user, duration, outcome; never arguments).
- **Composite `review_*` tools (`src/tools/runbooks.ts`)** port the business rules of the PowerShell runbooks in `C:\Users\s.hadjipanayi\Documents\LogicomCloudBU\CloudBUAA-New\runbooks` (thresholds, NCE vs Legacy, end-date precedence). Each one names its source runbook in its description; when a runbook's logic changes, update the matching tool. They're registered with `registerCompositeTool` (`run(args, client, marketplace)`) and must stay read-only: report a runbook's write step as `suggestedAction` instead of doing it.
- **`src/reports.ts`**: `runReport` + `reportToRecords` turn the `ExecuteReport` table (`Columns[{Name,CellIndex}]`, `Rows[{Cells}]`) into records and drop `ZZ_Total` summary rows; `pick` does case-insensitive column lookup (column casing varies by report). Report calls use `HEAVY_TIMEOUT_MS` (300 s).
- **`src/knowledge.ts`**: report names and technical product codes (`productName`) used in production, embedded in tool descriptions.
- `ping` (checks every marketplace login) is the only tool registered directly in `src/index.ts`; the server's `instructions` string there tells the model which tools to start with — update it when adding tools.

## Conventions

- stdout is the MCP transport: never `console.log` in server code; log to stderr (`console.error`).
- ESM with `NodeNext` resolution: relative imports must use the `.js` extension.
- All tools are read-only (`readOnlyHint: true`); don't add write operations.
