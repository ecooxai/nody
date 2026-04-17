# Cloudflare Deployment

This project has two deployable parts:

- Cloudflare Worker API: `worker/src/index.ts`, deployed with `worker/wrangler.jsonc`.
- Next.js frontend: `app/` and `components/`, deployed with root `wrangler.jsonc` and OpenNext.

The Worker API is deployed separately from the frontend. Keep the frontend's `WORKER_API_BASE_URL` pointed at the Worker API URL with `/v1` appended.

## Quick Deployment Summary

Deployment has four phases:

1. Confirm `.env.local` has the Cloudflare and Clerk values listed below.
2. Create or reuse Cloudflare D1 and R2 resources, then update `worker/wrangler.jsonc`.
3. Apply D1 migrations and deploy the Worker API.
4. Deploy the Next.js frontend with OpenNext, then set the frontend Worker runtime secrets.

Current production URLs:

```text
Next.js app: https://nody.ecooxai.workers.dev
Worker API:  https://nody-worker.ecooxai.workers.dev/v1
```

Minimum command flow after env vars and Cloudflare resources are ready:

```bash
set -a
. ./.env.local
set +a

npm run typecheck
npm run test
npm run worker:check
npm run worker:migrate:remote
npm run worker:deploy
npm run deploy
```

After the first frontend deploy, set the frontend Worker runtime secrets:

```bash
printf '%s' "$CLERK_SECRET_KEY" | npx wrangler secret put CLERK_SECRET_KEY --config wrangler.jsonc
printf '%s' "$WORKER_API_BASE_URL" | npx wrangler secret put WORKER_API_BASE_URL --config wrangler.jsonc
printf '%s' "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" | npx wrangler secret put NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY --config wrangler.jsonc
```

Important note: run commands from the repo root. The frontend Worker uses root `wrangler.jsonc`; the API Worker uses `worker/wrangler.jsonc`.

## API Keys And Env Vars

These are the deploy-relevant variables currently expected from `.env.local`. Secret values must stay out of git.

| Env var | Required for deploy | Secret | Purpose | How to get it |
| --- | --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | No | Tells Wrangler which Cloudflare account owns Workers, D1, and R2. | Cloudflare dashboard > select account > copy Account ID from the account overview/sidebar. |
| `CLOUDFLARE_API_TOKEN` | Yes | Yes | Lets Wrangler create resources, apply D1 migrations, and deploy Workers. | Cloudflare dashboard > My Profile > API Tokens > Create Token. Use a custom token or Workers edit template with Workers Scripts edit, D1 edit, R2 edit, and account read access for the target account. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes for live auth | No, but public | Enables Clerk in the browser and at build time. | Clerk Dashboard > select application > Configure/API keys > copy Publishable key. |
| `CLERK_SECRET_KEY` | Yes for live auth | Yes | Lets server routes verify Clerk auth. | Clerk Dashboard > select application > Configure/API keys > copy Secret key. Store it as a Cloudflare Worker secret for the frontend Worker. |
| `WORKER_API_BASE_URL` | Yes | No | Frontend proxy target for API requests. | Use the deployed API Worker URL with `/v1`, currently `https://nody-worker.ecooxai.workers.dev/v1`. |
| `D1_DATABASE_NAME` | Yes | No | Human-readable D1 name used by scripts. | Use existing Cloudflare D1 database name or create one with `npx wrangler d1 create nody-db`. |
| `D1_DATABASE_ID` | Yes | No | D1 UUID used in `worker/wrangler.jsonc`. | `npx wrangler d1 list --json` or the output from `npx wrangler d1 create nody-db`. |
| `R2_BUCKET_NAME` | Yes | No | R2 bucket used by media uploads. | Cloudflare dashboard > R2 object storage, or `npx wrangler r2 bucket list`; create with `npx wrangler r2 bucket create nody-media` if missing. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Recommended | No | Clerk sign-in route. | Usually `/sign-in` for this app. |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Recommended | No | Clerk sign-up route. | Usually `/sign-up` for this app. |
| `OPENAI_API_URL`, `OPENAI_MODEL`, `GEMINI_API_URL`, `GEMINI_MODEL` | No | No | Default provider URLs/models shown in settings. | Keep defaults unless changing provider endpoints/models. |
| `TEST_GEMINI_KEY` | No | Yes | Local/manual test key only. | Google AI Studio or Google Cloud, only if you need local Gemini tests. Do not deploy as an app secret unless a future feature explicitly uses it. |

Important note: this app does not require `OPENAI_API_KEY` or `GEMINI_API_KEY` as deployment env vars. End users save AI provider keys inside the app's provider settings.

## Current Cloudflare Resources

Use these names when checking the Cloudflare dashboard:

| Resource | Env var | Value | Binding |
| --- | --- | --- | --- |
| D1 database | `D1_DATABASE_NAME` | `nody-db` | `DB` |
| D1 database ID | `D1_DATABASE_ID` | `381c67c7-23c8-48d4-b41b-57dec0d0608e` | `DB` |
| R2 bucket | `R2_BUCKET_NAME` | `nody-media` | `MEDIA_BUCKET` |
| Worker API | `WORKER_API_BASE_URL` | `https://nody-worker.ecooxai.workers.dev/v1` | n/a |
| Next.js app | n/a | `https://nody.ecooxai.workers.dev` | n/a |

Important note: keep the Worker binding names as `DB` and `MEDIA_BUCKET`. The Worker code and `worker/src/env.ts` expect those exact bindings.

## 1. Confirm Local Environment

Check `.env.local` has these deployment values:

```bash
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
D1_DATABASE_NAME=nody-db
D1_DATABASE_ID=381c67c7-23c8-48d4-b41b-57dec0d0608e
R2_BUCKET_NAME=nody-media
```

Important note: `.env.local` contains secrets and local deployment values. Do not commit it.

## 2. Get Any Missing Cloudflare Values

If `CLOUDFLARE_ACCOUNT_ID` is missing:

1. Open the Cloudflare dashboard.
2. Select the target account.
3. Copy the Account ID from the account overview or right sidebar.
4. Add it to `.env.local` as `CLOUDFLARE_ACCOUNT_ID=...`.

If `CLOUDFLARE_API_TOKEN` is missing:

1. Open Cloudflare dashboard.
2. Go to My Profile > API Tokens.
3. Create a custom token.
4. Include permissions for Workers deployment, D1 edit access, and R2 edit access on the target account.
5. Add it to `.env.local` as `CLOUDFLARE_API_TOKEN=...`.

For this project, the token must be able to:

- Deploy Worker scripts, for example `Workers Scripts:Edit`.
- Read the target account, so Wrangler can resolve the account during deploy.
- Edit D1, so it can create databases and apply migrations.
- Edit R2, so it can create buckets.

Important note: if D1/R2 commands work but `npm run worker:deploy` fails with Cloudflare auth code `10000`, recreate or edit the token with Worker script deploy permissions. The variable name is still `CLOUDFLARE_API_TOKEN`.

Important note: this app does not require `OPENAI_API_KEY` or `GEMINI_API_KEY` as deployment env vars. AI keys are saved by users inside the app's provider settings.

## 3. Check Or Create D1

List existing D1 databases:

```bash
set -a
. ./.env.local
set +a
npx wrangler d1 list --json
```

If `nody-db` exists, reuse it and copy its UUID into `D1_DATABASE_ID`. If it does not exist, create it:

```bash
npx wrangler d1 create nody-db
```

Then update `worker/wrangler.jsonc`:

```json
{
  "binding": "DB",
  "database_name": "nody-db",
  "database_id": "the-d1-uuid"
}
```

Important note: `wrangler d1 create` creates a remote production D1 database. Local dev still uses Wrangler's local persisted D1 state when commands include `--local`.

## 4. Check Or Create R2

List existing R2 buckets:

```bash
set -a
. ./.env.local
set +a
npx wrangler r2 bucket list
```

If `nody-media` exists, reuse it. If it does not exist, create it:

```bash
npx wrangler r2 bucket create nody-media
```

Then confirm `worker/wrangler.jsonc` contains:

```json
{
  "binding": "MEDIA_BUCKET",
  "bucket_name": "nody-media"
}
```

Important note: R2 bucket names are account-level names. Reuse the bucket if Cloudflare already shows `nody-media` under the same account.

## 5. Validate The Worker

Run the type and Worker checks:

```bash
npm run typecheck
npm run test
npm run worker:check
```

Important note: `worker:check` validates the Worker build and Cloudflare bindings, but it does not apply D1 migrations.

## 6. Apply Remote D1 Migrations

Apply schema migrations to the remote D1 database:

```bash
set -a
. ./.env.local
set +a
npm run worker:migrate:remote
```

Important note: remote migrations change the production Cloudflare D1 database. Confirm the account and database name before running this command.

## 7. Deploy The Worker API

Deploy the Worker API:

```bash
set -a
. ./.env.local
set +a
npm run worker:deploy
```

After deploy, Wrangler prints the Worker URL. The frontend must use that URL with `/v1` appended:

```text
WORKER_API_BASE_URL=https://<worker-subdomain>.workers.dev/v1
```

Important note: the frontend proxy route reads `WORKER_API_BASE_URL`. If it still points to `http://127.0.0.1:8787/v1`, the deployed frontend will try to call a local machine instead of Cloudflare.

## 8. Deploy The Next.js Frontend

Deploy the frontend Worker:

```bash
set -a
. ./.env.local
set +a
npm run deploy
```

After the first deploy, set the runtime secrets on the frontend Worker:

```bash
set -a
. ./.env.local
set +a
printf '%s' "$CLERK_SECRET_KEY" | npx wrangler secret put CLERK_SECRET_KEY --config wrangler.jsonc
printf '%s' "$WORKER_API_BASE_URL" | npx wrangler secret put WORKER_API_BASE_URL --config wrangler.jsonc
printf '%s' "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" | npx wrangler secret put NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY --config wrangler.jsonc
```

Important note: do not put `CLERK_SECRET_KEY` into a public `NEXT_PUBLIC_*` variable. Only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is browser-visible.

Important note: `open-next.config.ts` disables the adapter's `workerd` build condition for this app. With Next.js `15.5.15` and `@opennextjs/cloudflare` `1.19.1`, the default condition pulled Next source map files into the server bundle and broke deployment.

## 9. Smoke Test Production

After both the Worker API and frontend are deployed:

1. Open the frontend URL.
2. Sign in with Clerk.
3. Create or edit a document.
4. Confirm sync succeeds.
5. Upload an image or audio file to confirm R2 writes.
6. Refresh the page and confirm the saved content returns from D1.

Important note: media routes are public-read through the Worker media endpoint, but writes still require the authenticated frontend proxy path.

## Useful References

- Cloudflare D1 Wrangler commands: https://developers.cloudflare.com/d1/wrangler-commands/
- Cloudflare R2 Wrangler commands: https://developers.cloudflare.com/r2/reference/wrangler-commands/
- Cloudflare Next.js on Workers: https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
