import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { adminAccountsTable } from "./admin_accounts";

export const whitelistUsersTable = pgTable("whitelist_users", {
  id:          text("id").primaryKey(),
  identifier:  text("identifier").notNull().unique(),
  label:       text("label"),
  bypassCode:  text("bypass_code").notNull().default("000000"),
  isActive:    boolean("is_active").notNull().default(true),
  expiresAt:   timestamp("expires_at"),
  createdBy:   text("created_by").references(() => adminAccountsTable.id, { onDelete: "set null" }),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

export const insertWhitelistUserSchema = createInsertSchema(whitelistUsersTable).omit({ createdAt: true, updatedAt: true });
export type InsertWhitelistUser = z.infer<typeof insertWhitelistUserSchema>;
export type WhitelistUser = typeof whitelistUsersTable.$inferSelect;
