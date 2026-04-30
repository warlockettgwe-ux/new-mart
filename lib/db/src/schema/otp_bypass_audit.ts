import { pgTable, text, timestamp, varchar, json, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const otpBypassAuditTable = pgTable("otp_bypass_audit", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  userId: text("user_id"),
  adminId: text("admin_id"),
  phone: varchar("phone", { length: 20 }),
  email: varchar("email", { length: 255 }),
  bypassReason: varchar("bypass_reason", { length: 100 }),
  expiresAt: timestamp("expires_at"),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: varchar("user_agent", { length: 500 }),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("otp_bypass_audit_user_id_created_at_idx").on(t.userId, t.createdAt),
  index("otp_bypass_audit_admin_id_created_at_idx").on(t.adminId, t.createdAt),
  index("otp_bypass_audit_event_type_created_at_idx").on(t.eventType, t.createdAt),
]);

export const insertOtpBypassAuditSchema = createInsertSchema(otpBypassAuditTable).omit({
  createdAt: true,
});

export type InsertOtpBypassAudit = z.infer<typeof insertOtpBypassAuditSchema>;
export type OtpBypassAudit = typeof otpBypassAuditTable.$inferSelect;
