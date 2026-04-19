# AGENTS.md

This file gives coding agents the project-specific context needed to work in this repo without rediscovering the basics.

## Deploy

- Do not use `.env.local` in this repo. Local development uses `.env.dev`; Cloudflare deployment uses `.env.deploy`.
- `npm run dev` and `./dev.sh` load `.env.dev` before starting Next.js and the local Worker.
- Deploy-related npm scripts load `.env.deploy` themselves: `npm run worker:check`, `npm run worker:migrate:remote`, `npm run worker:deploy`, `npm run deploy`, `npm run preview`, and `npm run upload`.
- Keep `.env.dev`, `.env.deploy`, and every other `.env*` file out of git. Only `.env.example` may be tracked.
- For redeploys, prefer: `npm run typecheck`, `npm run test`, `npm run worker:check`, `npm run worker:migrate:remote`, `npm run worker:deploy`, then `npm run deploy`.

## Project Overview

Nody is a full-stack writing app scaffold built with:

- Next.js 15 App Router, React 19, TypeScript, and Tailwind CSS.
- Clerk for authentication, with build-safe fallbacks when Clerk env vars are missing.
- A Cloudflare Worker API backed by D1 for records and R2 for media.
- Vitest for shared logic tests.

Core product features include a rich Markdown-backed editor, media uploads, cloud sync, per-user AI provider settings, AI chat/editing, prompt templates, offline service worker caching, and local document cache/device identity.

## Repository Map

- `app/`: Next.js app routes, auth pages, workspace page, proxy route, global styles, and root layout.
- `components/`: UI, editor, chat, sync, settings, layout, and notification components.
- `lib/`: Frontend helpers for API calls, auth config, editor behavior, provider defaults, local storage, and service worker registration.
- `shared/`: Types and pure shared helpers used by both frontend and Worker code.
- `worker/`: Cloudflare Worker source, D1/R2 bindings, and SQL migrations.
- `tests/`: Vitest test coverage for shared logic and schema behavior.
- `doc/`: Project docs, task history, common mistakes, and the user-owned task file.
- `public/sw.js`: Service worker used by the frontend.

## Setup

Use Node/npm with the checked-in `package-lock.json`.

```bash
npm install
cp .env.example .env.dev
```

For local full-stack development, the default worker URL is:

```text
http://127.0.0.1:8787/v1
```

Clerk keys are optional for builds. Without Clerk env vars, the app should stay build-safe and show setup guidance instead of live auth UI.

## Common Commands

```bash
npm run dev
npm run build
npm run start
npm run typecheck
npm run test
npm run test:watch
npm run worker:migrate:local
npm run worker:check
npm run worker:types
```

Project scripts:

- `./dev.sh`: Starts Next.js dev mode. It also starts the local Worker when `WORKER_API_BASE_URL` points to localhost.
- `./dev.sh --check`: Runs `./test.sh` before dev startup.
- `./dev.sh --no-worker`: Starts only the Next.js dev server.
- `./run.sh`: Builds and serves the production app, optionally with the local Worker.
- `./run.sh --full`: Runs checks, applies local D1 migrations, starts Worker, builds, and serves.
- `./test.sh`: Runs `npm run typecheck` and `npm run test`.
- `./req.sh`: Installs system dependencies through `req/install-system-deps.sh`.

## Verification

Before claiming a code task is complete, prefer at least:

```bash
npm run typecheck
npm run test
```

For Worker changes, also run:

```bash
npm run worker:check
```

For migrations or schema changes, run:

```bash
npm run worker:migrate:local
npm run test
```

For production/runtime-sensitive changes, run:

```bash
npm run build
```

## Environment

Important environment variables are documented in `.env.example`.

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` enable live Clerk auth.
- `WORKER_API_BASE_URL` controls the Next.js proxy target and defaults locally to `http://127.0.0.1:8787/v1`.
- `OPENAI_*` and `GEMINI_*` variables provide optional defaults for provider settings; users can override settings in the app.
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`, and `R2_BUCKET_NAME` are deployment/runtime values for Cloudflare.
- Put local development values in `.env.dev` and deployment values in `.env.deploy`; do not recreate `.env.local`.

## Coding Conventions

- Keep TypeScript strict and avoid `any` unless there is a clear boundary reason.
- Use the `@/` path alias for repo-root imports in app/frontend code.
- Keep shared pure logic in `shared/` when both the frontend and Worker need it.
- Keep browser-only code behind client components or hooks marked with `"use client"`.
- Do not use browser `alert()` or `prompt()`; use in-app UI feedback.
- Keep modules small and focused. Prefer local helpers over broad abstractions.
- Keep user-facing error handling copyable or actionable where possible, following existing notification patterns.
- Preserve the build-safe no-Clerk behavior unless the task explicitly changes auth setup.

## Worker And Data Notes

- Worker routes live primarily in `worker/src/index.ts`.
- D1 query helpers live in `worker/src/db.ts`.
- AI provider adapters live in `worker/src/ai.ts`.
- Worker environment bindings are typed in `worker/src/env.ts`; regenerate with `npm run worker:types` when bindings change.
- Add new D1 migrations under `worker/migrations/` using the next numeric prefix.
- Apply local migrations before testing features that depend on new tables or columns.
- R2 media URLs are served through Worker media routes and proxied through Next.js where appropriate.

## Frontend Notes

- The main workspace orchestration is in `components/workspace-client.tsx`.
- API calls should go through `lib/api/client.ts` unless there is a strong reason to bypass it.
- Editor command behavior lives in `lib/editor/`.
- Local persistence and device identity live in `lib/storage/`.
- Provider defaults live in `lib/providers/defaults.ts`; keep tests aligned when defaults change.
- Service worker registration lives in `lib/hooks/use-service-worker.ts`, and the worker file is `public/sw.js`.

## Documentation Rules

- Keep project docs in `doc/`.
- Do not edit `doc/vibetask.md` unless the user explicitly permits a specific section.
- Update `doc/overview.md` when architecture, major commands, or the file map changes materially.
- Update `doc/common_mistakes.md` when a repeated project-specific pitfall is discovered.
- `doc/update.md` is the task history; update it only when the user expects task-log maintenance.

## Git And Editing Rules

- The worktree may contain user changes. Do not revert changes you did not make unless the user explicitly asks.
- Keep edits scoped to the requested task.
- Do not churn generated files or lockfiles unless dependency changes require it.
- Respect the existing formatting style. There is no separate lint script in `package.json`; use typecheck/tests/build for validation.
