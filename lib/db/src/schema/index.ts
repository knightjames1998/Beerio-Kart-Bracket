import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// A live spectator session. `state` holds the full serialized bracket
// (playerCount, names, results, series, format) pushed by the host.
export const sessionsTable = pgTable("sessions", {
  code: text("code").primaryKey(),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SessionRow = typeof sessionsTable.$inferSelect;
export type InsertSession = typeof sessionsTable.$inferInsert;
