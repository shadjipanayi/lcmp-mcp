import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LcmpPort, Workload } from "../client.js";
import { type Marketplace, type MarketplaceRegistry, runInMarketplace } from "../marketplaces.js";

/** Responses larger than this are truncated so a big list does not flood the model's context. */
export const MAX_RESPONSE_CHARS = 100_000;

export interface ReadToolSpec {
  /** MCP tool name (snake_case). */
  name: string;
  /** API operation name, i.e. the path without the leading slash. */
  operation: string;
  title: string;
  description: string;
  input?: z.ZodRawShape;
  /** Optional reshaping of the API response before it is returned to the model. */
  transform?: (data: unknown) => unknown;
  /** "heavy" for reports and big lists that take minutes; the client picks the timeout and lane. */
  workload?: Workload;
}

export interface CompositeToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input?: Shape;
  /** Chains read calls against one marketplace and returns the data to show the model (undefined = not found). */
  run: (args: z.infer<z.ZodObject<Shape>>, client: LcmpPort, marketplace: Marketplace) => Promise<unknown>;
}

/** The `marketplace` input every tool gets: required when several marketplaces are configured. */
function marketplaceInput(registry: MarketplaceRegistry) {
  const field = z
    .enum(registry.codes)
    .describe(`Country marketplace to query (one per call): ${registry.describe()}.`);
  return registry.single ? field.optional() : field;
}

// Reusable field definitions.
export const accountId = (what = "account") => z.number().int().describe(`The ${what} Account ID.`);
export const resellerContext = z
  .number()
  .int()
  .optional()
  .describe("Optional reseller context Account ID, used to determine purchase prices. Defaults to the caller's reseller.");
export const serviceFilters = z
  .object({
    OwnerAccountIds: z.array(z.number().int()).optional(),
    ServiceCategories: z.array(z.string()).optional(),
    ServiceTags: z.array(z.string()).optional(),
    ServiceGroups: z.array(z.string()).optional(),
    PriceableItemIds: z.array(z.number().int()).optional(),
  })
  .describe("Optional filters to narrow the service list.");

/** Drops undefined values: the API wants unused optional fields left out of the payload. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/**
 * Field names whose values must never reach the model: product fields carry provisioning secrets such as the
 * tenant InitialPassword. Matches both object keys and {Name, Value} product-field entries.
 */
const SECRET_NAME = /pass(word)?|secret|token|apikey|api_key|privatekey|validationcode|credential/i;

/** Replaces secret values with "[redacted]" anywhere in an API response. */
export function redactSecrets(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(redactSecrets);
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  // Product field entry: { Name: "InitialPassword", Value: "..." }
  if (typeof obj.Name === "string" && (typeof obj.Value === "string" || typeof obj.Value === "number") && SECRET_NAME.test(obj.Name)) {
    return { ...obj, Value: "[redacted]" };
  }
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, SECRET_NAME.test(k) && (typeof v === "string" || typeof v === "number") ? "[redacted]" : redactSecrets(v)]),
  );
}

export function formatResult(data: unknown): string {
  if (data === null || data === undefined) return "Success (the API returned no content).";
  const text = typeof data === "string" ? data : JSON.stringify(redactSecrets(data));
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return (
    text.slice(0, MAX_RESPONSE_CHARS) +
    `\n\n[Truncated: response was ${text.length.toLocaleString()} characters; showing the first ${MAX_RESPONSE_CHARS.toLocaleString()}. Narrow the query to see more.]`
  );
}

/** Who is calling, as set by the HTTP transport's Entra ID check (absent over stdio). */
interface CallContext {
  authInfo?: { clientId?: string; extra?: Record<string, unknown> };
}

/**
 * Runs one tool call against the chosen marketplace and writes one JSON usage line to stderr (tool, marketplace,
 * caller, duration, outcome). Arguments are not logged: they can contain customer names and VAT IDs.
 */
async function handle(
  tool: string,
  registry: MarketplaceRegistry,
  args: Record<string, unknown> | undefined,
  ctx: CallContext | undefined,
  fn: (m: Marketplace, rest: Record<string, unknown>) => Promise<unknown>,
) {
  const started = Date.now();
  const { marketplace, ...rest } = args ?? {};
  const user = ctx?.authInfo?.extra?.user ?? ctx?.authInfo?.clientId;
  let error: string | undefined;
  try {
    const data = await runInMarketplace(registry, marketplace as string | undefined, (m) => fn(m, rest));
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text" as const, text: error }] };
  } finally {
    console.error(
      JSON.stringify({
        event: "tool_call",
        tool,
        marketplace: marketplace ?? registry.single?.code ?? null,
        user: user ?? null,
        ms: Date.now() - started,
        ok: error === undefined,
        ...(error ? { error: error.slice(0, 300) } : {}),
      }),
    );
  }
}

/** Registers a read-only tool that forwards its arguments as the JSON body of one API operation. */
export function registerReadTool(server: McpServer, registry: MarketplaceRegistry, spec: ReadToolSpec): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: { ...spec.input, marketplace: marketplaceInput(registry) },
      annotations: { title: spec.title, readOnlyHint: true, openWorldHint: true },
    },
    (args: Record<string, unknown>, ctx: CallContext) =>
      handle(spec.name, registry, args, ctx, async (m, rest) => {
        const raw = await m.client.call(spec.operation, compact(rest), spec.workload);
        return spec.transform ? spec.transform(raw) : raw;
      }),
  );
}

/** Registers a read-only tool that runs a multi-step workflow (several API calls plus business rules). */
export function registerCompositeTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  registry: MarketplaceRegistry,
  spec: CompositeToolSpec<Shape>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: { ...spec.input, marketplace: marketplaceInput(registry) },
      annotations: { title: spec.title, readOnlyHint: true, openWorldHint: true },
    },
    // The SDK has already validated args against the input schema.
    (args: Record<string, unknown>, ctx: CallContext) =>
      handle(spec.name, registry, args, ctx, (m, rest) => spec.run(rest as z.infer<z.ZodObject<Shape>>, m.client, m)),
  );
}

export function registerReadTools(server: McpServer, registry: MarketplaceRegistry, specs: ReadToolSpec[]): void {
  for (const spec of specs) registerReadTool(server, registry, spec);
}
