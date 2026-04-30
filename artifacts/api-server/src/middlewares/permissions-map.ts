/**
 * Central Permissions Map
 *
 * Defines the permission required for each sensitive admin route.
 * All /api/admin/* routes already require a valid JWT (enforced by the
 * global `adminAuth` middleware in admin.ts). This map adds *per-route*
 * RBAC on top so that only admins whose role grants the listed permission
 * can access a given endpoint.
 *
 * Permission strings follow the pattern: <domain>.<action>
 * Super-admins bypass all permission checks (handled in requirePermission).
 *
 * Usage — attach the middleware to a route:
 *   router.post('/path', requirePermission('domain.action'), handler);
 *
 * Definitions are grouped by domain for easy auditing.
 */

export const PERMISSIONS_MAP = {
  // ── Finance ─────────────────────────────────────────────────────────────
  "PATCH /vendors/:id/status":                    "finance.manage",
  "POST  /vendors/:id/payout":                    "finance.manage",
  "POST  /vendors/:id/credit":                    "finance.manage",
  "PATCH /vendors/:id/commission":                "finance.manage",
  "POST  /vendors/:id/override-suspension":       "finance.manage",
  "POST  /riders/:id/payout":                     "finance.manage",
  "POST  /riders/:id/bonus":                      "finance.manage",
  "POST  /riders/:id/credit":                     "finance.manage",
  "POST  /riders/:id/restrict":                   "finance.manage",
  "POST  /riders/:id/unrestrict":                 "finance.manage",
  "POST  /riders/:id/override-suspension":        "finance.manage",
  "PATCH /withdrawal-requests/:id/approve":       "finance.approve",
  "PATCH /withdrawal-requests/:id/reject":        "finance.approve",
  "PATCH /withdrawal-requests/batch-approve":     "finance.approve",
  "PATCH /withdrawal-requests/batch-reject":      "finance.approve",
  "PATCH /deposit-requests/:id/approve":          "finance.approve",
  "PATCH /deposit-requests/:id/reject":           "finance.approve",
  "POST  /deposit-requests/bulk-approve":         "finance.approve",
  "POST  /deposit-requests/bulk-reject":          "finance.approve",

  // ── Orders ───────────────────────────────────────────────────────────────
  "POST  /orders":                                "orders.manage",
  "PATCH /orders/:id/status":                     "orders.manage",
  "POST  /orders/:id/refund":                     "orders.manage",
  "PATCH /orders/:id/assign-rider":               "orders.manage",
  "PATCH /pharmacy-orders/:id/status":            "orders.manage",
  "PATCH /parcel-bookings/:id/status":            "orders.manage",

  // ── Users ────────────────────────────────────────────────────────────────
  "DELETE /users/:id":                            "users.delete",
  "PATCH  /users/bulk-ban":                       "users.ban",

  // ── System / RBAC ────────────────────────────────────────────────────────
  "POST   /system/rbac/roles":                    "system.roles.manage",
  "PATCH  /system/rbac/roles/:id":                "system.roles.manage",
  "DELETE /system/rbac/roles/:id":                "system.roles.manage",
  "POST   /system/rbac/roles/:id/permissions":    "system.roles.manage",
  "DELETE /system/rbac/roles/:id/permissions/:p": "system.roles.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS_MAP)[keyof typeof PERMISSIONS_MAP];
