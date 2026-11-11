# CareerOS

A resume-centric job-search platform: it finds postings, scores them against *your* résumé, generates tailored résumés and cover letters under strict formatting rules, tracks applications, and autofills application forms from a browser extension.

> **This is the public showcase of a private, deployed product.** It is the real application code, published so the engineering can be reviewed. Credentials, personal data, internal build notes and production configuration are not included, so it will not run end-to-end without your own Supabase project and API keys. The code is shown for review; all rights reserved.

~65k lines of JavaScript · 23 test suites (plain Node + `assert`, no network) · 74 SQL migrations · multi-tenant from day one.

---

## What it does

| Area | What's in the code |
|---|---|
| **Job sourcing, three paths** | A licensed aggregator (JSearch) as the always-on default; a bring-your-own-scraper runtime (Apify and others, user keys encrypted at rest); and **ATS Direct**, which reads company job boards straight from the applicant-tracking systems' public APIs. |
| **ATS Direct** | A company registry of ~18k mapped employers and adapters for 24 platforms (Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, iCIMS, Taleo, SuccessFactors, Oracle, Eightfold, Phenom, Avature and more), plus custom adapters for proprietary career sites. Includes platform detection, slug mining, streaming parsers with memory caps, and a contract-check canary that flags API drift. |
| **Scoring** | A zero-cost deterministic pre-filter runs before any paid AI call, then a two-call AI scorer (JD extraction, then résumé fit) with a cached JD profile so re-scanning an unchanged posting cannot change its keywords. Scoring is calibrated against recruiter-judged bands. |
| **Résumé & cover-letter generation** | Tailored `.docx` output built from a master résumé under locked formatting rules, with a grounding check so every claim traces back to the source résumé (no fabricated experience), keyword placement scoring, page-budget fitting, and a humanizer pass. |
| **Copilot mode** | An interactive résumé workbench: drag-and-drop layout, a keyword gap pane, a live ATS scoreboard, and a résumé vault. |
| **Application autofill** | A Manifest V3 Chrome extension with per-platform adapters (Greenhouse, Lever, Ashby, Workable, Workday, generic). Deterministic field matching, no AI round-trip for standard fields, a per-user answer bank for screening questions, and it never submits for the user. |
| **Visa-sponsorship intelligence** | DOL/OFLC LCA disclosure data aggregated per employer, joined to the registry by normalized name, and fed into scoring as a grounded fact. |
| **Sector classification** | A versioned, resumable AI pipeline that classifies the registry into a sector taxonomy, which drives subscribable system "tracklists". |
| **Automation** | Scheduled scans driven by a GitHub Actions cron that calls a protected endpoint, with wall-clock auto-continue and a self-ping keep-alive for a free-tier host. |
| **Billing model** | A single internal currency with a cost ledger (`cos_transactions`) and balance enforcement; the AI layer is a provider-agnostic router (Gemini, OpenAI-compatible, Anthropic). |

## Architecture

```
┌────────────────────┐      ┌─────────────────────────────┐      ┌───────────────────┐
│ apps/web (React +  │ REST │ apps/server (Node + Express)│ SQL  │ Supabase          │
│ Vite SPA)          ├─────►│  routes → scan / scoring /  ├─────►│ Postgres + Auth + │
│                    │      │  generation / companies     │      │ Storage (RLS)     │
└────────────────────┘      └───────┬──────────────┬──────┘      └───────────────────┘
┌────────────────────┐              │              │
│ apps/extension     │  REST        │              └──► AI router ──► Gemini (Vertex) /
│ (Chrome MV3        ├──────────────┘                                 OpenAI-compatible / Anthropic
│  autofill)         │                       ▲
└────────────────────┘                       │ imports
                              ┌──────────────┴───────────────┐
                              │ packages/shared              │
                              │  sourcing + ATS adapters,    │
                              │  prefilter, ATS scoring,     │
                              │  AI adapters, humanizer      │
                              └──────────────────────────────┘
```

- **Monorepo** with npm workspaces: `apps/server`, `apps/web`, `apps/extension`, `packages/shared`.
- **`packages/shared`** holds the pure, heavily tested logic (ATS adapters, pre-filter, keyword pipeline, AI adapters) so the server, scripts and extension share one implementation. A sync check fails the build if the extension's copy drifts.
- **Multi-tenancy:** every user-scoped table carries `user_id` with row-level security. The company registry, sector tables and visa data are deliberately global.
- **Provider seams:** sourcing adapters share one contract; AI adapters sit behind `aiRouter.js`, which resolves house AI or a user's own key per call. The Gemini adapter switches between Vertex and the Developer API through config.
- **Secrets:** user-supplied keys are AES-256-GCM encrypted at rest behind a single seam (`secretCrypto.js`), built so a managed KMS can replace it later.
- **Cost discipline:** deterministic checks run before any paid AI call, and every action is logged to a cost ledger.

## Engineering notes worth a look

- [`packages/shared/src/sourcing/ats/`](packages/shared/src/sourcing/ats): the ATS adapter layer, with a dispatcher, retry/backoff, platform detection and a drift canary.
- [`apps/server/src/scan/atsDirectPipeline.js`](apps/server/src/scan/atsDirectPipeline.js): a concurrent producer/consumer pipeline that sources and scores at the same time.
- [`apps/server/src/generation/`](apps/server/src/generation): résumé generation, fill pass, grounding checks and renderers.
- [`apps/extension/src/core/`](apps/extension/src/core): a deterministic form matcher with a large fixture-based test suite.
- [`supabase/migrations/`](supabase/migrations): the schema history, including the RLS posture for global tables.
- [`docs/ops-workflows/`](docs/ops-workflows): the cron workflows that run the production scheduler. They are parked here so they don't run on a fork.

## Running the tests

No database, network or API keys are needed.

```bash
npm ci
npm test
```

## Running it for real

You need your own Supabase project (apply `supabase/migrations/` in order) and the variables listed in [`.env.example`](.env.example) and [`apps/web/.env.example`](apps/web/.env.example).

```bash
npm run dev:server        # API on :3000
npm run dev -w @careeros/web
```

## What is intentionally not in this repo

Production credentials and deploy configuration, personal data and real user records, the private product spec and build history, and the recruiter-calibration set (built from a real user's scans).

---

Built by [@Tan-Q-2508](https://github.com/Tan-Q-2508).
