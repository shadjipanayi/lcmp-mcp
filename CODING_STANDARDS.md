# Coding standards

Judgement calls for reviewing a diff. Mechanical rules (read-only tools, no `TerminateSessionToken`, nothing on stdout) are enforced by `test/invariants.test.ts` and CI, so they aren't repeated here. Module layout: [docs/architecture.md](docs/architecture.md).

- **One source per fact.** Subscription facts (CSP model, end date, days left, urgency, stored and effective end-date action) come from `describeSubscription`; account lookups, VAT lookups, roles and the parent chain from `Accounts`. A tool that re-derives one of these, even partly, is a finding.
- **Glossary names in tool output.** Output fields and tool descriptions use the terms in `GLOSSARY.md` (`cspModel`, `daysLeft`, `urgency`, `effectiveEndDateAction`, root/reseller/customer). A new domain term goes into the glossary in the same change.
- **Lane fits the caller.** A lookup someone is waiting on stays on the quick lane; only review fan-outs and the directory crawl use `bulk`; reports and big lists are `heavy`. Ask: can this call end up queued behind a colleague's review?
- **Not found means "not in this marketplace" only.** Errors pass through `lookup()`/`optional()`; a timeout or outage must reach the user as itself, never as "not found" or "no match".
- **Independent parts fail independently.** A tool with several independent reports or lists uses `settle` and returns what worked with `errors`; it fails only when every part failed.
- **Shared reports get a reader.** When a second tool starts reading a report, its column names move into a typed reader like `src/seats.ts`.
- **Runbook ports say what differs.** A `review_*` tool that deliberately departs from its runbook (e.g. the literal "(NCE)" match) says so in a comment or note.
- **Tests at the module's interface.** New behaviour is tested through the module's interface or the MCP tool, with the fake `LcmpPort`; tests that only exercise private helpers are a finding.
