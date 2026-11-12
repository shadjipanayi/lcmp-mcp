# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only MCP server (stdio for Claude Code/Desktop, Streamable HTTP for Azure/Copilot Studio) for the Logicom Cloud Marketplace SimpleAPI, used by internal and support staff so they don't have to log in to each country marketplace separately.

Read [docs/architecture.md](docs/architecture.md) before changing `src/`: modules, client lanes and workloads, and where the live API differs from `openapi.json`. Domain terms are in [GLOSSARY.md](GLOSSARY.md); reviews check [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Invariants

`test/invariants.test.ts` enforces these; keep it green:

- Every tool is read-only (`readOnlyHint: true`) and only calls read operations. A runbook's write step becomes a `suggestedAction`.
- Never call `TerminateSessionToken`: each marketplace's API user is shared by the whole team.
- stdout is the MCP transport: log to stderr (`console.error`).

Also: every call targets exactly one marketplace (never fan out across countries), and tool results go through `formatResult`, which redacts secrets such as the tenant `InitialPassword`.

## Commands

- `npm run build` / `npm run typecheck`
- `npm test`: offline tests in `test/` (fake API client, locally signed Entra tokens). One test: `node --import tsx --test --test-name-pattern="VAT" test/core.test.ts`
- `npm run smoke`: spawns `dist/index.js` (build first) against the SwaggerHub mock; `ping` failing there is expected.
- `npm run live -- <MARKETPLACE> <tool> [key=value ...]`: one tool against the live API in `.env` (build first), e.g. `npm run live -- CYMA get_subscription_status accountId=277615`. The project `.mcp.json` also exposes the local build as the `lcmp-dev` MCP server.
- `npm run dev` (from source), `npm run inspect` (MCP Inspector)

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every PR. There is no linter.

Config is via env vars (see `.env.example`): `LCMP_BASE_URL`, `LCMP_MARKETPLACES` and `LCMP_<CODE>_USERNAME`/`_PASSWORD` per marketplace (API users without MFA). `dev`, `start`, `inspect` and `live` load a git-ignored `.env`. Against the live API, avoid heavy reports during the billing run (00:00-02:50 UTC) and Azure sync (05:30-06:30 UTC): they time out.

The runbooks the `review_*` tools port, `C:\Users\s.hadjipanayi\Documents\LogicomCloudBU\CloudBUAA-New\runbooks`, are read-only reference: read them for business rules, change only this repo.

`.claude/skills/` is vendored from `mattpocock/skills` and pinned in `skills-lock.json`; update it with `npx skills update`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `shadjipanayi/lcmp-mcp`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created only when needed. See `docs/agents/domain.md`.
