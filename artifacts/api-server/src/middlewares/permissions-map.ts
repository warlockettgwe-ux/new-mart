/**
 * Central Permissions Map
 *
 * Single source of truth for all per-route RBAC permissions in the admin API.
 * Route guards import their permission strings from here so any change to a
 * permission key is propagated everywhere automatically — drift between the map
 * and the actual guards is impossible.
 *
 * Permission strings follow the pattern: <domain>.<action>
 * Super-admins bypass all permission checks (handled inside requirePermission).
 *
 * Usage in a route file:
 *   import { FINANCE_PERMS } from '../../middlewares/permissions-map.js';
 *   router.post('/path', requirePermission(FINANCE_PERMS.manage), handler);
 */

export const FINANCE_PERMS = {
  manage: "finance.manage",
  approve: "finance.approve",
} as const;

export const ORDERS_PERMS = {
  manage: "orders.manage",
} as const;

export const USERS_PERMS = {
  delete: "users.delete",
  ban: "users.ban",
} as const;

export const SYSTEM_PERMS = {
  rolesManage: "system.roles.manage",
  auditView: "system.audit.view",
} as const;

export type FinancePerm  = (typeof FINANCE_PERMS)[keyof typeof FINANCE_PERMS];
export type OrdersPerm   = (typeof ORDERS_PERMS)[keyof typeof ORDERS_PERMS];
export type UsersPerm    = (typeof USERS_PERMS)[keyof typeof USERS_PERMS];
export type SystemPerm   = (typeof SYSTEM_PERMS)[keyof typeof SYSTEM_PERMS];
export type AdminPerm    = FinancePerm | OrdersPerm | UsersPerm | SystemPerm;

/**
 * Full route → permission matrix for auditing.
 * This map is exhaustive — every entry MUST correspond to an actual route
 * guard applied in the route file listed in the comment.
 */
export const ADMIN_PERMISSIONS_MAP: Record<string, AdminPerm> = {
  // ── Finance (artifacts/api-server/src/routes/admin/finance/wallets.ts) ──
  "PATCH /vendors/:id/status":                    FINANCE_PERMS.manage,
  "POST  /vendors/:id/payout":                    FINANCE_PERMS.manage,
  "POST  /vendors/:id/credit":                    FINANCE_PERMS.manage,
  "PATCH /vendors/:id/commission":                FINANCE_PERMS.manage,
  "POST  /vendors/:id/override-suspension":       FINANCE_PERMS.manage,
  "PATCH /riders/:id/status":                     FINANCE_PERMS.manage,
  "POST  /riders/:id/payout":                     FINANCE_PERMS.manage,
  "POST  /riders/:id/bonus":                      FINANCE_PERMS.manage,
  "POST  /riders/:id/credit":                     FINANCE_PERMS.manage,
  "POST  /riders/:id/restrict":                   FINANCE_PERMS.manage,
  "POST  /riders/:id/unrestrict":                 FINANCE_PERMS.manage,
  "POST  /riders/:id/override-suspension":        FINANCE_PERMS.manage,
  "PATCH /withdrawal-requests/:id/approve":       FINANCE_PERMS.approve,
  "PATCH /withdrawal-requests/:id/reject":        FINANCE_PERMS.approve,
  "PATCH /withdrawal-requests/batch-approve":     FINANCE_PERMS.approve,
  "PATCH /withdrawal-requests/batch-reject":      FINANCE_PERMS.approve,
  "PATCH /deposit-requests/:id/approve":          FINANCE_PERMS.approve,
  "PATCH /deposit-requests/:id/reject":           FINANCE_PERMS.approve,
  "POST  /deposit-requests/bulk-approve":         FINANCE_PERMS.approve,
  "POST  /deposit-requests/bulk-reject":          FINANCE_PERMS.approve,

  // ── Orders (artifacts/api-server/src/routes/admin/orders.ts) ──
  "POST  /orders":                                ORDERS_PERMS.manage,
  "PATCH /orders/:id/status":                     ORDERS_PERMS.manage,
  "POST  /orders/:id/refund":                     ORDERS_PERMS.manage,
  "PATCH /orders/:id/assign-rider":               ORDERS_PERMS.manage,
  "PATCH /pharmacy-orders/:id/status":            ORDERS_PERMS.manage,
  "PATCH /parcel-bookings/:id/status":            ORDERS_PERMS.manage,

  // ── Users (artifacts/api-server/src/routes/admin/system/users.ts) ──
  "DELETE /users/:id":                            USERS_PERMS.delete,
  "PATCH  /users/bulk-ban":                       USERS_PERMS.ban,

  // ── System / RBAC (artifacts/api-server/src/routes/admin/system/rbac.ts) ──
  "POST   /system/rbac/roles":                    SYSTEM_PERMS.rolesManage,
  "PATCH  /system/rbac/roles/:id":                SYSTEM_PERMS.rolesManage,
  "DELETE /system/rbac/roles/:id":                SYSTEM_PERMS.rolesManage,
  "POST   /system/rbac/roles/:id/permissions":    SYSTEM_PERMS.rolesManage,
  "DELETE /system/rbac/roles/:id/permissions/:p": SYSTEM_PERMS.rolesManage,
};
