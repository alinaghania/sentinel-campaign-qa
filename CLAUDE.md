# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

Sentinel: automated QA of campaign emails before sending. Takes a campaign brief plus test emails from a mailbox and returns a GO / GO_AVEC_RESERVES / NO_GO verdict per language variant. Next.js 16 (App Router, `proxy.ts` replaces middleware), React 19, strict TypeScript, Tailwind v4, Vitest. The README and code comments are in French; follow that convention. Each file has a header comment explaining *why* it exists — read it before editing.

## Commands

```bash
npm run dev                       # http://localhost:3000 (no auth locally)
npm run build / npm start
npm run lint
npx tsc --noEmit                  # strict typecheck
npm test                          # vitest run (global testTimeout 20 s, see vitest.config.ts)
npx vitest run lib/__tests__/aggregate.test.ts        # single file
npx vitest run -t "partial test name"                 # single test
npm run seed                      # demo data into .data/
npm run extract:template[:check]  # regenerate / verify lib/brief-template.data.ts from the workbook
```

Setup: `cp .env.example .env.local`. Only `FOUNDRY_API_KEY` is required for LLM agents; without it the app runs degraded (deterministic rules only, agents reported as unavailable). The `@/*` alias maps to the repo root (configured in both tsconfig and vitest).

## Architecture

All business logic lives in `lib/`; `components/` and `app/` are presentation and thin API routes (`app/api/**/route.ts`, one per resource). Start with `lib/types.ts` (domain vocabulary), then `lib/analyze.ts` (orchestrator, emits SSE progress events).

Analysis pipeline (`lib/analyze.ts`): `parseEmailFacts` → `checkLinks` → `runCodeChecks` (deterministic) → 7 LLM agents in parallel (`lib/agents.ts`; `anomalies` runs last as a sweeper) → `aggregate` → judge writes the executive summary. Results are cached by content hash and replayed as identical events.

Invariants that span multiple files — don't break them:

- **The LLM never sees raw HTML.** `lib/parse-email.ts` extracts compact JSON facts (classified links, final URLs, UTM, alts, conditionals, visible text); agents reason only on those.
- **Verdict is deterministic.** `lib/aggregate.ts` decides: an unarbitrated CRITIQUE finding = NO_GO. The LLM only drafts the summary. The verdict has three states; only `NO_GO` blocks, so use `isBlocking()` rather than `verdict !== "GO"`.
- **Every LLM finding must cite evidence.** `lib/structured.ts` substring-matches `evidence` against the extracted facts; unmatched findings are downgraded to "à vérifier". Agents use forced tool use with strict Zod schemas and one self-correction retry.
- **Rules are an overlay.** Code is the source of truth (`lib/rule-registry.ts` assembles `rule-catalog.ts`, `llm-rule-catalog.ts`, `peripheral-rule-catalog.ts`); stored config (`lib/rule-config.ts`, `/rules` page) holds only diffs from the code catalog. No stored config must behave identically to the code. Don't copy catalog defaults into stored config.
- **Prompt-injection defence.** User-entered editorial rules and email content are passed as data (e.g. in `<editorial_rules>`), never as instructions.
- **Link checking** (`lib/check-links.ts`): four verdicts (`ok`, `casse`, `suspect`, `non_verifiable`) — a bot-blocked 403 is not a dead link. SSRF guard re-evaluated on each redirect. Unsubscribe links are never requested.
- **Brief workbook parsing** is deterministic (`lib/brief-grid.ts`, `brief-template*.ts`); `lib/brief-template.data.ts` is generated from the workbook — regenerate with `extract:template`, don't hand-edit.

Persistence (`lib/store.ts`): local JSON under `DATA_DIR` (`.data/`) in dev, Azure Tables when `AZURE_TABLES_CONNECTION_STRING` is set. LLM calls go through `lib/foundry.ts` (Azure AI Foundry, Anthropic-compatible; separate worker and judge deployments). Inbox ingestion: IMAP (`imap.ts`), Gmail (`gmail.ts`), Outlook (`outlook.ts`), matched to campaigns by `match-campaign.ts`.

Access control: `proxy.ts` guards everything with a single key (`SENTINEL_ACCESS_KEY`, cookie holds its SHA-256). Production without a key fails closed with 503; local dev passes through.

## Testing notes

Tests live in `lib/__tests__/` (fixtures include real `.xlsx`/`.xlsm` briefs in `fixtures/`); `pipeline.test.ts` exercises the whole chain end to end. Route handlers are testable thanks to the `@/` alias in the vitest config.

## Deployment

Azure Container Apps (Dockerfile, `infra/azure/*.bicep`, `scripts/azure/`). Rotating a Key Vault secret requires a new Container App revision. Real Gmail rendering needs a local authenticated browser (`render:login`, then `push:renders`); it is disabled in containers (`RENDER_REAL=0`).
