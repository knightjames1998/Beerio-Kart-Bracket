# Beerio Kart Bracket

A double-elimination tournament bracket for Beerio Kart (Mario Kart + drinks),
with live spectator view, QR sharing, match history, and Best-of-N formats.

## Run & Operate

### Production (single server — recommended for game night)
The API server serves both the built front end and the `/api` routes on one port.
- `pnpm run prod` — build web + api, then start the server (uses `PORT`)
- On Replit: set the Run/Deploy command to `pnpm run prod`

### Live spectator sync requires the API server to be running
The 📺 share button creates a live "room"; spectators open `/?s=CODE` and poll it.
If the API server is not running, sharing falls back to a one-time snapshot link.

### Database (durable rooms)
- Provision Postgres (Replit: add the PostgreSQL tool → sets `DATABASE_URL`)
- `pnpm --filter @workspace/db run push` — create the `sessions` table
- Without `DATABASE_URL` the server uses an in-memory store: fine for a single
  dev instance, but rooms are lost on restart and won't work across autoscale.

### Dev (two processes, hot reload)
- Terminal 1: `pnpm run dev:api`  (Express on :5000, in-memory unless DATABASE_URL set)
- Terminal 2: `pnpm run dev:web`  (Vite on :3000, proxies `/api` → :5000)

### Other
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/beerio-kart run build` — front end only (needs PORT, BASE_PATH)

## Stack
- pnpm workspaces, Node.js 24, TypeScript 5.9
- Front end: React + Vite + Tailwind v4 (artifacts/beerio-kart)
- API: Express 5 (artifacts/api-server) — serves the SPA + `/api` in production
- DB: PostgreSQL + Drizzle ORM (lib/db) — `sessions` table for live rooms

## Where things live
- Bracket app + engine: `artifacts/beerio-kart/src/App.tsx`
- Live session store (pg + in-memory fallback): `artifacts/api-server/src/lib/store.ts`
- Session routes (POST/PUT/GET): `artifacts/api-server/src/routes/sessions.ts`
- DB schema: `lib/db/src/schema/index.ts`

## Architecture decisions
- The bracket engine is pure and 1v1 at every node (verified: 2-16 players each
  crown a real champion with exactly 2N-2 playable matches). "4-Kart Heat" is a
  scoring/format option layered on top, not a structural change to the bracket.
- Live sync is snapshot-push + poll (host PUTs on change, spectators GET every 3s),
  which needs no websockets and survives the Replit autoscale model when backed by
  Postgres.
- The API server also serves the built SPA so host and spectators share one origin
  (no CORS surprises, one deploy).
