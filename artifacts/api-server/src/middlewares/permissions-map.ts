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
  manage: "users.manage",
  delete: "users.delete",
  ban: "users.ban",
} as const;

export const CONTENT_PERMS = {
  manage: "content.manage",
} as const;

export const SYSTEM_PERMS = {
  adminManage: "system.admin.manage",
  rolesManage: "system.roles.manage",
  securityManage: "system.security.manage",
  auditView: "system.audit.view",
} as const;

export const COMMUNICATION_PERMS = {
  manage: "communication.manage",
} as const;

export const FLEET_PERMS = {
  manage: "fleet.manage",
} as const;

export type FinancePerm       = (typeof FINANCE_PERMS)[keyof typeof FINANCE_PERMS];
export type OrdersPerm        = (typeof ORDERS_PERMS)[keyof typeof ORDERS_PERMS];
export type UsersPerm         = (typeof USERS_PERMS)[keyof typeof USERS_PERMS];
export type ContentPerm       = (typeof CONTENT_PERMS)[keyof typeof CONTENT_PERMS];
export type SystemPerm        = (typeof SYSTEM_PERMS)[keyof typeof SYSTEM_PERMS];
export type CommunicationPerm = (typeof COMMUNICATION_PERMS)[keyof typeof COMMUNICATION_PERMS];
export type FleetPerm         = (typeof FLEET_PERMS)[keyof typeof FLEET_PERMS];
export type AdminPerm         = FinancePerm | OrdersPerm | UsersPerm | ContentPerm | SystemPerm | CommunicationPerm | FleetPerm;

/**
 * Full route → permission matrix for auditing.
 * This map is exhaustive for all guarded routes — every entry MUST correspond
 * to an actual requirePermission guard applied in the route file listed in
 * the comment.
 */
export const ADMIN_PERMISSIONS_MAP: Record<string, AdminPerm> = {
  // ── Finance (routes/admin/finance/wallets.ts) ──────────────────────────────
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

  // ── Orders (routes/admin/orders.ts) ───────────────────────────────────────
  "POST  /orders":                                ORDERS_PERMS.manage,
  "PATCH /orders/:id/status":                     ORDERS_PERMS.manage,
  "POST  /orders/:id/refund":                     ORDERS_PERMS.manage,
  "PATCH /orders/:id/assign-rider":               ORDERS_PERMS.manage,
  "PATCH /pharmacy-orders/:id/status":            ORDERS_PERMS.manage,
  "PATCH /parcel-bookings/:id/status":            ORDERS_PERMS.manage,

  // ── User management (routes/admin/system/users.ts) ────────────────────────
  "POST  /users":                                 USERS_PERMS.manage,
  "PATCH /users/:id":                             USERS_PERMS.manage,
  "POST  /users/:id/approve":                     USERS_PERMS.manage,
  "POST  /users/:id/reject":                      USERS_PERMS.manage,
  "PATCH /users/:id/request-correction":          USERS_PERMS.manage,
  "PATCH /users/:id/identity":                    USERS_PERMS.manage,
  "POST  /users/:id/wallet-topup":                FINANCE_PERMS.manage,
  "PATCH /users/:id/waive-debt":                  FINANCE_PERMS.manage,
  "PATCH /users/:id/security":                    SYSTEM_PERMS.securityManage,
  "POST  /users/:id/otp/bypass":                  SYSTEM_PERMS.securityManage,
  "DELETE /users/:id/otp/bypass":                 SYSTEM_PERMS.securityManage,
  "POST  /users/:id/2fa/disable":                 SYSTEM_PERMS.securityManage,
  "POST  /users/:id/reset-wallet-pin":            SYSTEM_PERMS.securityManage,
  "POST  /users/:id/reset-otp":                   SYSTEM_PERMS.securityManage,
  "DELETE /users/:id":                            USERS_PERMS.delete,
  "PATCH  /users/bulk-ban":                       USERS_PERMS.ban,
  "DELETE /users/:id/sessions/:sessionId":        SYSTEM_PERMS.securityManage,
  "DELETE /users/:id/sessions":                   SYSTEM_PERMS.securityManage,

  // ── Admin account management (routes/admin/system/auth.ts) ────────────────
  "POST  /admin-accounts":                        SYSTEM_PERMS.adminManage,
  "PATCH /admin-accounts/:id":                    SYSTEM_PERMS.adminManage,
  "DELETE /admin-accounts/:id":                   SYSTEM_PERMS.adminManage,

  // ── RBAC / role management (routes/admin/system/rbac.ts) ──────────────────
  "POST   /roles":                                SYSTEM_PERMS.rolesManage,
  "PATCH  /roles/:id":                            SYSTEM_PERMS.rolesManage,
  "DELETE /roles/:id":                            SYSTEM_PERMS.rolesManage,
  "PUT    /roles/:id/permissions":                SYSTEM_PERMS.rolesManage,
  "PUT    /admins/:adminId/roles":                SYSTEM_PERMS.rolesManage,

  // ── Content management (routes/admin/content.ts) ──────────────────────────
  "PATCH /products/:id/approve":                  CONTENT_PERMS.manage,
  "PATCH /products/:id/reject":                   CONTENT_PERMS.manage,
  "POST  /products":                              CONTENT_PERMS.manage,
  "PATCH /products/:id":                          CONTENT_PERMS.manage,
  "DELETE /products/:id":                         CONTENT_PERMS.manage,
  "POST  /broadcast":                             CONTENT_PERMS.manage,
  "POST  /categories":                            CONTENT_PERMS.manage,
  "PATCH /categories/:id":                        CONTENT_PERMS.manage,
  "DELETE /categories/:id":                       CONTENT_PERMS.manage,
  "POST  /categories/reorder":                    CONTENT_PERMS.manage,
  "POST  /banners":                               CONTENT_PERMS.manage,
  "PATCH /banners/reorder":                       CONTENT_PERMS.manage,
  "PATCH /banners/:id":                           CONTENT_PERMS.manage,
  "PUT   /banners/:id":                           CONTENT_PERMS.manage,
  "DELETE /banners/:id":                          CONTENT_PERMS.manage,
  "POST  /flash-deals":                           CONTENT_PERMS.manage,
  "PATCH /flash-deals/:id":                       CONTENT_PERMS.manage,
  "DELETE /flash-deals/:id":                      CONTENT_PERMS.manage,
  "POST  /promo-codes":                           CONTENT_PERMS.manage,
  "PATCH /promo-codes/:id":                       CONTENT_PERMS.manage,

  // ── Fleet / Rides (routes/admin/fleet/rides.ts + zones.ts) ───────────────
  "PATCH /rides/:id/status":                       FLEET_PERMS.manage,
  "POST  /ride-services":                          FLEET_PERMS.manage,
  "PATCH /ride-services/:id":                      FLEET_PERMS.manage,
  "DELETE /ride-services/:id":                     FLEET_PERMS.manage,
  "POST  /locations":                              FLEET_PERMS.manage,
  "POST  /zones":                                  FLEET_PERMS.manage,
  "PUT   /zones/:id":                              FLEET_PERMS.manage,
  "DELETE /zones/:id":                             FLEET_PERMS.manage,

  // ── Loyalty (routes/admin/loyalty.ts) ─────────────────────────────────────
  "POST  /loyalty/users/:id/adjust":               FINANCE_PERMS.manage,

  // ── FAQ (routes/admin/faq.ts) ──────────────────────────────────────────────
  "POST  /faq":                                    CONTENT_PERMS.manage,
  "PATCH /faq/:id":                                CONTENT_PERMS.manage,
  "DELETE /faq/:id":                               CONTENT_PERMS.manage,

  // ── Communication (routes/admin/communication.ts) ─────────────────────────
  "PATCH /communication/flags/:id/resolve":        COMMUNICATION_PERMS.manage,
  "POST  /communication/roles":                    COMMUNICATION_PERMS.manage,
  "PUT   /communication/roles/:id":                COMMUNICATION_PERMS.manage,
  "DELETE /communication/roles/:id":               COMMUNICATION_PERMS.manage,
  "POST  /communication/roles/ai-generate":        COMMUNICATION_PERMS.manage,
  "POST  /communication/users/:id/block":          COMMUNICATION_PERMS.manage,
  "POST  /communication/users/:id/unblock":        COMMUNICATION_PERMS.manage,
  "PUT   /communication/settings":                 COMMUNICATION_PERMS.manage,
  "PUT   /communication/ajk-ids/:userId":          COMMUNICATION_PERMS.manage,
};
