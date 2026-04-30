import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const authAuditLogTable = pgTable("auth_audit_log", {
  id:        text("id").primaryKey(),
  userId:    text("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  event:     text("event").notNull(),
  ip:        text("ip").notNull().default("unknown"),
  userAgent: text("user_agent"),
  metadata:  text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("auth_audit_log_event_created_at_idx").on(t.event, t.createdAt),
  index("auth_audit_log_user_id_created_at_idx").on(t.userId, t.createdAt),
]);

export type AuthAuditLog = typeof authAuditLogTable.$inferSelect;
