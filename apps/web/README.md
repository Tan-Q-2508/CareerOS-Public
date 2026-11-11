# @careeros/web

CareerOS frontend — a Vite + React SPA (Phase 1, Session 7). Wires the existing
REST API (`apps/server`) with Supabase Auth. Implements the locked "verdict stamp"
design system (spec Section 3).

## Views

- **Auth** — email/password + Google OAuth (Supabase JS).
- **Onboarding** — first-run gate: upload a `.docx` master résumé before scanning.
- **Dashboard** — past scans (selector), verdict-filtered job cards, New Scan modal
  (spec 4.1 fields), résumé-staleness flag (4.5).
- **Job Detail** — 3 headline scores, note, risk tags, tiered keyword analysis (5.3),
  Generate Résumé / Cover Letter with async polling + pending-skill confirmation, and
  the "Open in Copilot" / "Continue in Copilot" entry point (7.14.2).
- **Copilot Mode** — interactive resume editing (7.14): Workbench + live-preview Canvas,
  drag/keyboard reorder, variant cycling, AI rewrite/keyword-inject, Missing Keywords
  pane + Live ATS Scoreboard (7.14.12/7.14.13), Resume Vault + Custom Bullet Injector
  (7.14.11/7.14.14).
- **Settings** — real pre-filter profile edit (`PATCH /api/profile`), master-résumé
  re-upload, sourcing actor management, and Google Drive connect/disconnect (11.3).
  BYOK AI-provider UI is present but temporarily disabled (Phase 3 §17 — hard-routed
  through CAI; re-enabled at public launch (build order item 33, Phase 6), with
  credentials and adapters untouched in the meantime).
- **Buy COS** — full purchase experience, fully disabled ("not open yet", spec 0.1).
- **Tracker** — 5-stage application board (Applied → Accepted/Rejected), Gmail-based
  status checking (9.1).

## Run locally

```sh
cp .env.example .env.local     # fill in the three VITE_* values
npm install                    # from the repo root (npm workspaces)
npm run dev -w @careeros/web    # http://localhost:5173
```

`VITE_API_BASE_URL` points at the API. It defaults to `http://localhost:3000`, and a
local dev server should be left there: pointed at the deployed Render host it renders
PRODUCTION data, so a local server change appears to have had no effect and the two
servers look like they disagree about the same number. Point it at Render only to verify
an already-deployed change through the local UI, and put it back afterwards. The deployed
bundle never reads `.env.local` — `render.yaml` sets this at build time.

All `VITE_*` values are embedded in the built bundle — only ever use the **publishable**
Supabase key, never the secret/service key.

## Build

```sh
npm run build -w @careeros/web  # → apps/web/dist
```

Deployed as a Render static site (`careeros-web` in `render.yaml`) with an SPA
rewrite so react-router deep links resolve.
