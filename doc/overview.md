# Nody Overview

## Status

Nody is now a working full-stack scaffold for a cloud-synced writing app built with Next.js, TypeScript, Tailwind, Clerk, and a Cloudflare Worker backed by D1 and R2.

Current feature set:
- Rich text editor with formatting commands and media insertion for image, audio, and video.
- Cloud sync with revision-aware updates for multi-device editing.
- Clerk-ready auth flow for email, Google, and Apple sign-in/sign-up.
- AI chat panel that sends the whole editor content to OpenAI or Gemini and can apply returned text substitutions.
- Per-user provider settings for API URL, API key, and model.
- Service worker registration for offline-first HTML/CSS/JS caching plus delayed update refresh.
- Bottom error notifications with copyable error codes.
- Typecheck, test, production build, and Worker config validation scripts.
- Cloudflare frontend deployment through OpenNext plus a separate Worker API deployment.

Runtime note:
- If Clerk environment variables are missing, the app falls back to a build-safe setup mode and shows auth configuration guidance instead of mounting live Clerk UI.

## Structure

- `app/`: Next.js app router pages, auth routes, proxy route, workspace page, and global styles.
- `components/`: UI building blocks for the editor, AI chat, sync status, settings, layout, and notifications.
- `lib/`: Frontend helpers for auth config, API calls, editor commands, provider defaults, local cache, device identity, and service worker registration.
- `shared/`: Shared types plus substitution and sync helpers used by both frontend and Worker code.
- `worker/`: Cloudflare Worker source, Wrangler config, and D1 schema migration.
- `tests/`: Vitest coverage for shared substitution and sync logic.
- `doc/`: Deployment notes, task log, overview, common mistakes, and the user-owned vibetask file.

## File Tree

```text
.
├── .env.example
├── .gitignore
├── app
│   ├── (auth)
│   │   ├── sign-in/[[...sign-in]]/page.tsx         # Clerk sign-in page with setup fallback
│   │   └── sign-up/[[...sign-up]]/page.tsx         # Clerk sign-up page with setup fallback
│   ├── api/proxy/[...path]/route.ts                # Authenticated proxy from Next.js to Worker APIs
│   ├── globals.css                                 # Tailwind base styles and editor media styles
│   ├── layout.tsx                                  # Root layout with optional ClerkProvider
│   ├── page.tsx                                    # Landing page
│   └── workspace/page.tsx                          # Main editor workspace route
├── components
│   ├── chat/ai-chat-panel.tsx                      # AI chat UI and substitution apply action
│   ├── editor/editor-toolbar.tsx                   # Formatting toolbar
│   ├── editor/media-actions.tsx                    # Media upload action menu
│   ├── editor/rich-editor.tsx                      # Contenteditable editor shell
│   ├── layout/app-shell.tsx                        # Shared page shell and top nav
│   ├── notifications/error-toast.tsx               # Bottom error notification provider
│   ├── settings/provider-settings-form.tsx         # Provider settings editor
│   ├── sync/sync-status-card.tsx                   # Cloud sync status UI
│   ├── ui/button.tsx                               # Shared button component
│   ├── ui/panel.tsx                                # Shared panel container
│   └── workspace-client.tsx                        # Workspace orchestration and sync loop
├── dev.sh                                          # Low-RAM dev launcher; add --worker/--check for heavier flows
├── run.sh                                          # Production-mode runner with file watching and automatic restart
├── doc
│   ├── common_mistakes.md                          # Guardrails for future edits
│   ├── deploy.md                                   # Cloudflare deployment steps and resource notes
│   ├── overview.md                                 # Project overview and file tree
│   ├── update.md                                   # Task history with timing and verification
│   └── vibetask.md                                 # User-owned task prompt file
├── lib
│   ├── api/client.ts                               # Frontend API wrapper for proxy endpoints
│   ├── auth/config.ts                              # Clerk configuration flag
│   ├── editor/commands.ts                          # Browser rich text commands
│   ├── editor/html.ts                              # Editor starter HTML helpers
│   ├── editor/media.ts                             # Media markup generation
│   ├── hooks/use-service-worker.ts                 # Service worker registration and update refresh
│   ├── providers/defaults.ts                       # Default OpenAI and Gemini settings
│   ├── storage/device.ts                           # Stable per-device ID
│   └── storage/local-cache.ts                      # Local document cache
├── middleware.ts                                   # Clerk route protection
├── next-env.d.ts                                   # Next.js type shim
├── next.config.ts                                  # Next.js config
├── open-next.config.ts                             # OpenNext Cloudflare adapter config
├── package-lock.json                               # Locked dependencies
├── package.json                                    # Scripts and dependencies
├── postcss.config.js                               # PostCSS config
├── public
│   └── sw.js                                       # Offline cache service worker
├── shared
│   ├── substitutions.ts                            # Shared substitution helpers
│   ├── sync.ts                                     # Shared sync helpers
│   └── types.ts                                    # Shared app types
├── tailwind.config.ts                              # Tailwind theme config
├── test.sh                                         # Typecheck and test runner
├── tests
│   └── substitutions.test.ts                       # Shared logic tests
├── tsconfig.json                                   # TypeScript config
├── vitest.config.ts                                # Vitest config with alias mapping
├── wrangler.jsonc                                  # Frontend Cloudflare Worker config for OpenNext
└── worker
    ├── migrations/0001_initial.sql                 # D1 schema for documents, assets, settings, sync events
    ├── src/ai.ts                                   # OpenAI and Gemini provider adapter
    ├── src/db.ts                                   # D1 query helpers
    ├── src/env.ts                                  # Worker binding types
    ├── src/index.ts                                # Worker HTTP router
    ├── src/json.ts                                 # Worker JSON response helper
    └── wrangler.jsonc                              # Wrangler config for D1, R2, and observability
```
