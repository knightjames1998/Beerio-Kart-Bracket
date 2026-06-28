import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import { sessionsTable } from "@workspace/db/schema";
import { logger } from "./logger";

export interface SessionData { state: unknown; updatedAt: string; }
export interface Store {
  create(code: string, state: unknown): Promise<void>;
  update(code: string, state: unknown): Promise<void>;
  get(code: string): Promise<SessionData | null>;
}

// In-memory fallback so the app runs before a database is provisioned.
// Not durable and single-instance only — fine for a dev run, not autoscale.
function memoryStore(): Store {
  const map = new Map<string, SessionData>();
  return {
    async create(code, state) { map.set(code, { state, updatedAt: new Date().toISOString() }); },
    async update(code, state) { map.set(code, { state, updatedAt: new Date().toISOString() }); },
    async get(code) { return map.get(code) ?? null; },
  };
}

// Durable Postgres-backed store (used when DATABASE_URL is set).
function pgStore(url: string): Store {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema: { sessionsTable } });
  const upsert = async (code: string, state: unknown) => {
    await db
      .insert(sessionsTable)
      .values({ code, state })
      .onConflictDoUpdate({ target: sessionsTable.code, set: { state, updatedAt: new Date() } });
  };
  return {
    async create(code, state) { await upsert(code, state); },
    async update(code, state) { await upsert(code, state); },
    async get(code) {
      const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.code, code)).limit(1);
      const r = rows[0];
      return r ? { state: r.state, updatedAt: (r.updatedAt as Date).toISOString() } : null;
    },
  };
}

const url = process.env["DATABASE_URL"];
export const store: Store = url
  ? pgStore(url)
  : (logger.warn("DATABASE_URL not set — using in-memory session store (not durable, single instance only)"), memoryStore());
