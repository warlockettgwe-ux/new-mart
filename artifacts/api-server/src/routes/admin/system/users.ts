import { Router } from "express";
import { getIO } from "../../../lib/socketio.js";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  ordersTable, ridesTable, pharmacyOrdersTable, parcelBookingsTable,
  accountConditionsTable,
  userSessionsTable,
  refreshTokensTable,
} from "@workspace/db/schema";
import { eq, desc, count, sum, and, gte, lte, sql, or, ilike, asc, isNull, isNotNull, avg, ne } from "drizzle-orm";
import {
  stripUser, generateId, getUserLanguage, t,
  getPlatformSettings, adminAuth, getAdminSecret,
  sendUserNotification, logger,
  ORDER_NOTIF_KEYS, RIDE_NOTIF_KEYS, PHARMACY_NOTIF_KEYS, PARCEL_NOTIF_KEYS,
  checkAdminLoginLockout, recordAdminLoginFailure, resetAdminLoginAttempts,
  addAuditEntry, addSecurityEvent, getClientIp,
  signAdminJwt, verifyAdminJwt, invalidateSettingsCache, getCachedSettings,
  ADMIN_TOKEN_TTL_HRS, verifyTotpToken, verifyAdminSecret,
  ensureDefaultRideServices, ensureDefaultLocations, formatSvc,
  type AdminRequest, revokeAllUserSessions,
} from "../../admin-shared.js";
import { writeAuthAuditLog } from "../../../middleware/security.js";
import { hashPassword, validatePasswordStrength } from "../../../services/password.js";
import { sendSuccess, sendError, sendNotFound, sendForbidden, sendValidationError } from "../../../lib/response.js";
import { reconcileUserFlags } from "./conditions.js";
import { canonicalizePhone } from "@workspace/phone-utils";
import { UserService } from "../../../services/admin-user.service.js";
import { FinanceService } from "../../../services/admin-finance.service.js";
import { AuditService } from "../../../services/admin-audit.service.js";
import { requirePermission } from "../../../middlewares/require-permission.js";
import { USERS_PERMS, FINANCE_PERMS, SYSTEM_PERMS } from "../../../middlewares/permissions-map.js";

const router = Router();

router.post("/users", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const adminReq = req as AdminRequest;
  const { phone, name, role, city, area, email, username, tempPassword } = req.body;

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "user_create",
        resourceType: "user",
        resource: phone || name || "new_user",
        details: `Role: ${role || "customer"}`,
      },
      () => UserService.createUser({
        phone,
        email,
        name,
        username,
        role,
        city,
        area,
        tempPassword,
      })
    );

    // Fetch the created user
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, canonicalizePhone(phone))).limit(1);
    sendSuccess(res, { user: user ? stripUser(user) : { id: result.userId } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("duplicate") || message.includes("already exists")) {
      sendError(res, message, 409);
    } else if (message.includes("Invalid") || message.includes("weak")) {
      sendValidationError(res, message);
    } else {
      sendError(res, message, 400);
    }
  }
});

/* GET /admin/users/search?q=...&limit=20
   Lightweight server-side user search used by OTP Control and other admin tools.
   Returns users matching name or phone query (partial, case-insensitive). */
router.get("/users/search", async (req, res) => {
  const q = ((req.query?.q as string) ?? "").trim();
  const limitN = Math.min(50, Math.max(1, parseInt((req.query?.limit as string) ?? "20", 10)));

  const where = q
    ? or(ilike(usersTable.name, `%${q}%`), ilike(usersTable.phone, `%${q}%`))
    : undefined;

  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      phone: usersTable.phone,
      role: usersTable.roles,
      otpBypassUntil: sql<string | null>`${usersTable}.otp_bypass_until`,
    })
    .from(usersTable)
    .where(where)
    .orderBy(asc(usersTable.name))
    .limit(limitN);

  sendSuccess(res, { users: rows, total: rows.length });
});

/* GET /admin/users/search-riders?q=...&limit=20&onlineOnly=true
   Lightweight server-side rider search used by RideDetailModal for reassignment.
   Returns only active, non-rejected riders matching the search query.
   Pass onlineOnly=true to restrict to riders currently online (matches reassign constraints). */
router.get("/users/search-riders", async (req, res) => {
  const q = ((req.query?.q as string) ?? "").trim();
  const limitN = Math.min(50, Math.max(1, parseInt((req.query?.limit as string) ?? "20", 10)));
  const onlineOnly = (req.query?.onlineOnly as string) === "true";

  const conditions = [
    ilike(usersTable.roles, "%rider%") as ReturnType<typeof eq>,
    eq(usersTable.isActive, true),
    ne(usersTable.approvalStatus, "rejected"),
  ];
  if (onlineOnly) {
    conditions.push(eq(usersTable.isOnline, true) as ReturnType<typeof eq>);
  }
  if (q) {
    conditions.push(or(
      ilike(usersTable.name, `%${q}%`),
      ilike(usersTable.phone, `%${q}%`),
    )! as ReturnType<typeof eq>);
  }
  const riders = await db
    .select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone, isOnline: usersTable.isOnline, approvalStatus: usersTable.approvalStatus })
    .from(usersTable)
    .where(and(...conditions))
    .orderBy(asc(usersTable.name))
    .limit(limitN);
  sendSuccess(res, { riders, total: riders.length });
});

router.get("/users", async (req, res) => {
  const filter = (req.query?.filter as string) ?? "";
  const conditionTier = (req.query?.conditionTier as string) ?? "";
  const users = await (
    filter === "2fa_enabled"
      ? db.select().from(usersTable).where(eq(usersTable.totpEnabled, true))
      : db.select().from(usersTable)
  ).orderBy(desc(usersTable.createdAt));

  const condCounts = await db.select({
    userId: accountConditionsTable.userId,
    activeCount: count(),
    maxSeverity: sql<string>`MAX(CASE ${accountConditionsTable.severity}::text WHEN 'ban' THEN 5 WHEN 'suspension' THEN 4 WHEN 'restriction_strict' THEN 3 WHEN 'restriction_normal' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END)`,
    maxSeverityLabel: sql<string>`(ARRAY['warning','warning','restriction_normal','restriction_strict','suspension','ban'])[1 + MAX(CASE ${accountConditionsTable.severity}::text WHEN 'ban' THEN 5 WHEN 'suspension' THEN 4 WHEN 'restriction_strict' THEN 3 WHEN 'restriction_normal' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END)]`,
  }).from(accountConditionsTable)
    .where(eq(accountConditionsTable.isActive, true))
    .groupBy(accountConditionsTable.userId);

  const condMap = new Map(condCounts.map(c => [c.userId, { count: Number(c.activeCount), maxSeverity: c.maxSeverityLabel }]));

  let enrichedUsers = users.map((u) => ({
    ...stripUser(u),
    walletBalance: parseFloat(u.walletBalance ?? "0"),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    conditionCount: condMap.get(u.id)?.count || 0,
    maxConditionSeverity: condMap.get(u.id)?.maxSeverity || null,
    isMpinLocked: !!(u.walletPinLockedUntil && u.walletPinLockedUntil.getTime() > Date.now()),
  }));

  if (conditionTier === "has_conditions") {
    enrichedUsers = enrichedUsers.filter(u => u.conditionCount > 0);
  } else if (conditionTier === "warnings") {
    enrichedUsers = enrichedUsers.filter(u => u.maxConditionSeverity === "warning");
  } else if (conditionTier === "restrictions") {
    enrichedUsers = enrichedUsers.filter(u => u.maxConditionSeverity === "restriction_normal" || u.maxConditionSeverity === "restriction_strict");
  } else if (conditionTier === "suspensions") {
    enrichedUsers = enrichedUsers.filter(u => u.maxConditionSeverity === "suspension");
  } else if (conditionTier === "bans") {
    enrichedUsers = enrichedUsers.filter(u => u.maxConditionSeverity === "ban");
  } else if (conditionTier === "clean") {
    enrichedUsers = enrichedUsers.filter(u => u.conditionCount === 0);
  }

  sendSuccess(res, {
    users: enrichedUsers,
    total: enrichedUsers.length,
  });
});

router.patch("/users/:id", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const { role, isActive, walletBalance } = req.body;
  const updates: Partial<typeof usersTable.$inferInsert> & { tokenVersion?: ReturnType<typeof sql> } = {};
  if (role !== undefined) { updates.roles = role; updates.roles = role; }
  if (isActive !== undefined) updates.isActive = isActive;
  if (walletBalance !== undefined) updates.walletBalance = String(walletBalance);

  if (role === "vendor" || role === "rider") {
    updates.isActive = true;
    updates.approvalStatus = "approved";
  }

  const [user] = await db
    .update(usersTable)
    .set({ ...(updates as typeof usersTable.$inferInsert), updatedAt: new Date() })
    .where(eq(usersTable.id, req.params["id"]!))
    .returning();

  if (!user) { sendNotFound(res, "User not found"); return; }
  /* Revoke sessions on role or status change so user re-authenticates with new role */
  if (role !== undefined || isActive === false) {
    revokeAllUserSessions(req.params["id"]!).catch(() => {});
  }
  sendSuccess(res, { ...stripUser(user), walletBalance: parseFloat(user.walletBalance ?? "0") });
});

/* ── Pending Approval Users ── */
router.get("/users/pending", async (_req, res) => {
  const users = await db.select().from(usersTable)
    .where(eq(usersTable.approvalStatus, "pending"))
    .orderBy(desc(usersTable.createdAt));
  sendSuccess(res, {
    users: users.map(({ otpCode: _otp, otpExpiry: _exp, passwordHash: _ph, emailOtpCode: _eotp, emailOtpExpiry: _eexp, ...u }) => ({
      ...u,
      walletBalance: parseFloat(u.walletBalance ?? "0"),
      createdAt: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
    total: users.length,
  });
});

/* ── Approve User ── */
router.post("/users/:id/approve", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const adminReq = req as AdminRequest;
  const { note, skipDocCheck } = req.body;
  const userId = req.params["id"]!;
  
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target) { sendNotFound(res, "User not found"); return; }

  if (target.roles.includes("rider") && !skipDocCheck) {
    // Document check logic for rider approval
    // If needed, check for required rider documents from database
    // For now, we'll allow skipping this check
  }

  try {
    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "user_approve",
        resourceType: "user",
        resource: userId,
        details: note,
      },
      () => UserService.approveUser(userId)
    );

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    sendSuccess(res, { success: true, user: { ...stripUser(user!), walletBalance: parseFloat(user!.walletBalance ?? "0") } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message, 400);
  }
});

/* ── Reject User ── */
router.post("/users/:id/reject", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const adminReq = req as AdminRequest;
  const { note } = req.body as { note?: string };
  const userId = req.params["id"]!;

  try {
    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "user_reject",
        resourceType: "user",
        resource: userId,
        details: note || "No reason provided",
      },
      () => UserService.rejectUser(userId, note || "Rejected by admin")
    );

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    sendSuccess(res, { success: true, user: { ...stripUser(user!), walletBalance: parseFloat(user!.walletBalance ?? "0") } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message, 400);
  }
});

/* ── Wallet Top-up ── */
router.post("/users/:id/wallet-topup", requirePermission(FINANCE_PERMS.manage), async (req, res) => {
  const adminReq = req as AdminRequest;
  const { amount, description } = req.body;
  const userId = req.params["id"]!;
  
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    sendValidationError(res, "Valid amount is required");
    return;
  }

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "wallet_topup",
        resourceType: "user",
        resource: userId,
        details: `Amount: Rs. ${amount}`,
      },
      () => FinanceService.processTopup({
        userId,
        amount: Number(amount),
        paymentMethod: "admin_topup",
        reference: description,
      })
    );

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const newBalance = parseFloat(user?.walletBalance ?? "0");

    sendSuccess(res, {
      success: true,
      newBalance,
      user: { ...stripUser(user!), walletBalance: newBalance },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message, 400);
  }
});
router.delete("/users/:id", requirePermission(USERS_PERMS.delete), async (req, res) => {
  const adminReq = req as AdminRequest;
  const userId = req.params["id"]!;

  try {
    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "user_delete",
        resourceType: "user",
        resource: userId,
      },
      () => UserService.deleteUser(userId)
    );

    sendSuccess(res, { success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message, 400);
  }
});

/* ── User Activity (orders + rides summary) ── */
router.get("/users/:id/activity", async (req, res) => {
  const uid = req.params["id"]!;
  const orders = await db.select().from(ordersTable).where(eq(ordersTable.userId, uid)).orderBy(desc(ordersTable.createdAt)).limit(10);
  const rides = await db.select().from(ridesTable).where(eq(ridesTable.userId, uid)).orderBy(desc(ridesTable.createdAt)).limit(10);
  const pharmacy = await db.select().from(pharmacyOrdersTable).where(eq(pharmacyOrdersTable.userId, uid)).orderBy(desc(pharmacyOrdersTable.createdAt)).limit(5);
  const parcels = await db.select().from(parcelBookingsTable).where(eq(parcelBookingsTable.userId, uid)).orderBy(desc(parcelBookingsTable.createdAt)).limit(5);
  const txns = await db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, uid)).orderBy(desc(walletTransactionsTable.createdAt)).limit(10);
  sendSuccess(res, {
    orders: orders.map(o => ({ ...o, total: parseFloat(String(o.total)), createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString() })),
    rides: rides.map(r => ({ ...r, fare: parseFloat(r.fare), distance: parseFloat(r.distance), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })),
    pharmacy: pharmacy.map(p => ({ ...p, total: parseFloat(String(p.total)), createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })),
    parcels: parcels.map(p => ({ ...p, fare: parseFloat(p.fare), createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() })),
    transactions: txns.map(t => ({ ...t, amount: parseFloat(t.amount), createdAt: t.createdAt.toISOString() })),
  });
});

/* ── Overview with user enrichment (orders + user info) ── */
router.patch("/users/:id/security", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.isActive     !== undefined) updates.isActive     = body.isActive;
  if (body.isBanned     !== undefined) updates.isBanned     = body.isBanned;
  if (body.banReason    !== undefined) updates.banReason    = (body.banReason as string) || null;

  const willBeBanned = body.isBanned === true;
  const currentUser = await db.select({ isBanned: usersTable.isBanned }).from(usersTable).where(eq(usersTable.id, id!)).limit(1).then(r => r[0]);
  const alreadyBanned = currentUser?.isBanned ?? false;
  const canAutoApprove = !willBeBanned && !alreadyBanned;

  if (body.roles !== undefined) {
    const rolesValue = String(body.roles).trim();
    const roleList = rolesValue.split(",").map((r: string) => r.trim()).filter(Boolean);
    if (!roleList.length) { sendValidationError(res, "At least one role must be assigned"); return; }
    updates.roles = roleList.join(",");
    updates.role = roleList.includes("vendor") ? "vendor" : roleList.includes("rider") ? "rider" : roleList[0];

    if (canAutoApprove && (roleList.includes("rider") || roleList.includes("vendor"))) {
      updates.isActive = true;
      updates.approvalStatus = "approved";
    }
  }
  if (body.role !== undefined) {
    const roleValue = String(body.role).trim();
    if (roleValue) {
      updates.role = roleValue;
      if (canAutoApprove && (roleValue === "vendor" || roleValue === "rider")) {
        updates.isActive = true;
        updates.approvalStatus = "approved";
      }
    }
  }

  const prevBlockedServices = body.blockedServices !== undefined
    ? (await db.select({ blockedServices: usersTable.blockedServices }).from(usersTable).where(eq(usersTable.id, id!)).limit(1).then(r => r[0]?.blockedServices ?? ""))
    : null;
  if (body.blockedServices !== undefined) updates.blockedServices = body.blockedServices;
  if (body.securityNote !== undefined) updates.securityNote = body.securityNote || null;

  const adminReq = req as AdminRequest;
  if (willBeBanned && !alreadyBanned) {
    const [existingUser] = await db.select({ roles: usersTable.roles }).from(usersTable).where(eq(usersTable.id, id!)).limit(1);
    await db.insert(accountConditionsTable).values({
      id: generateId(),
      userId: id!,
      userRole: existingUser?.roles?.split(",")[0]?.trim() || "customer",
      conditionType: "ban_hard",
      severity: "ban",
      category: "ban",
      reason: String(body.banReason || "Banned by admin via security panel"),
      appliedBy: adminReq.adminId || "admin",
      notes: body.securityNote ? String(body.securityNote) : null,
    });
    await reconcileUserFlags(id!);
  } else if (!willBeBanned && alreadyBanned && body.isBanned === false) {
    await db.update(accountConditionsTable).set({
      isActive: false,
      liftedAt: new Date(),
      liftedBy: adminReq.adminId || "admin",
      liftReason: "Unbanned via security panel",
      updatedAt: new Date(),
    }).where(and(
      eq(accountConditionsTable.userId, id!),
      eq(accountConditionsTable.isActive, true),
      eq(accountConditionsTable.severity, "ban"),
    ));
    await reconcileUserFlags(id!);
  }

  if (willBeBanned !== alreadyBanned) {
    delete updates["isBanned"];
    delete updates["isActive"];
    delete updates["banReason"];
  }
  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id!)).returning();
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (body.blockedServices !== undefined && prevBlockedServices !== null) {
    const wasFrozen = (prevBlockedServices || "").split(",").map((s: string) => s.trim()).includes("wallet");
    const isFrozen = (String(body.blockedServices || "")).split(",").map((s: string) => s.trim()).includes("wallet");
    if (isFrozen !== wasFrozen) {
      const io = getIO();
      if (io) io.to(`user:${id}`).emit(isFrozen ? "wallet:frozen" : "wallet:unfrozen", {});
    }
  }

  /* Revoke all sessions if ban, deactivation, or role change occurred */
  if (body.isBanned || body.isActive === false || body.roles !== undefined || body.role !== undefined) {
    revokeAllUserSessions(id!).catch(() => {});
  }
  if (body.isBanned && body.notify) {
    await sendUserNotification(id!, "Account Suspended ⚠️", String(body.banReason || "Your account has been suspended. Contact support."), "warning", "warning-outline");
  }
  sendSuccess(res, { ...user, walletBalance: parseFloat(String(user.walletBalance)) });
});

/* ── PATCH /admin/users/:id/identity — Admin update user identity (username, email, name) ── */
router.patch("/users/:id/identity", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const userId = req.params["id"]!;
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!target) { sendNotFound(res, "User not found"); return; }

  if (body.username !== undefined) {
    const raw = String(body.username).toLowerCase().replace(/[^a-z0-9_]/g, "").trim();
    if (raw && raw.length < 3) { sendValidationError(res, "Username must be at least 3 characters"); return; }
    if (raw) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.username}) = ${raw}`).limit(1);
      if (existing && existing.id !== userId) {
        sendError(res, "Username already taken by another account", 409); return;
      }
      updates.username = raw;
    } else {
      updates.username = null;
    }
  }

  if (body.email !== undefined) {
    const raw = String(body.email).toLowerCase().trim();
    if (raw && !raw.includes("@")) { sendValidationError(res, "Invalid email format"); return; }
    if (raw) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.email}) = ${raw}`).limit(1);
      if (existing && existing.id !== userId) {
        sendError(res, "Email already linked to another account", 409); return;
      }
      updates.email = raw;
      updates.emailVerified = false;
    } else {
      updates.email = null;
      updates.emailVerified = false;
    }
  }

  if (body.name !== undefined) {
    const raw = String(body.name).trim();
    if (raw) updates.name = raw;
  }

  if (body.phone !== undefined) {
    const raw = String(body.phone).replace(/[\s\-()]/g, "");
    if (raw) {
      const normalized = raw.replace(/^\+?92/, "").replace(/^0/, "");
      if (!/^3\d{9}$/.test(normalized)) { sendValidationError(res, "Invalid phone format"); return; }
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, normalized)).limit(1);
      if (existing && existing.id !== userId) {
        sendError(res, "Phone already linked to another account", 409); return;
      }
      updates.phone = normalized;
    }
  }

  if (Object.keys(updates).length <= 1) {
    sendValidationError(res, "No valid fields to update"); return;
  }

  const ip = getClientIp(req);
  const changedFields = Object.keys(updates).filter(k => k !== "updatedAt");
  addAuditEntry({ action: "admin_identity_update", ip, details: `Admin updated identity for ${userId}: ${changedFields.join(", ")}`, result: "success" });

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
  if (!user) { sendNotFound(res, "User not found"); return; }

  revokeAllUserSessions(userId).catch(() => {});

  sendSuccess(res, { ...stripUser(user), walletBalance: parseFloat(String(user.walletBalance)) });
});

router.post("/users/:id/reset-otp", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  await db.update(usersTable).set({ otpCode: null, otpExpiry: null, updatedAt: new Date() }).where(eq(usersTable.id, req.params["id"]!));
  sendSuccess(res, { success: true, message: "OTP cleared — user must re-authenticate" });
});


/* ── POST /admin/users/:id/otp/bypass — set a timed OTP bypass ── */
router.post("/users/:id/otp/bypass", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const userId = req.params["id"]!;
  const minutes = Number(req.body?.minutes);
  if (!minutes || minutes <= 0 || minutes > 1440 || !Number.isInteger(minutes)) {
    sendValidationError(res, "minutes must be a positive integer between 1 and 1440");
    return;
  }
  const [user] = await db.select({ id: usersTable.id, phone: usersTable.phone }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  const bypassUntil = new Date(Date.now() + minutes * 60 * 1000);

  // no user notification — admin-only action
  await db.update(usersTable).set({ otpBypassUntil: bypassUntil, updatedAt: new Date() }).where(eq(usersTable.id, userId));

  const ip = getClientIp(req);
  const adminReq = req as unknown as AdminRequest;
  addAuditEntry({ action: "admin_otp_bypass_set", ip, adminId: adminReq.adminId, details: `Admin set ${minutes}min OTP bypass for user ${userId} (${user.phone}), expires ${bypassUntil.toISOString()}`, result: "success" });
  writeAuthAuditLog("admin_otp_bypass_set", {
    userId,
    ip,
    userAgent: req.headers["user-agent"] ?? undefined,
    metadata: { phone: user.phone, adminId: adminReq.adminId, minutes, bypassUntil: bypassUntil.toISOString(), result: "success" },
  });

  sendSuccess(res, { bypassUntil: bypassUntil.toISOString(), minutes });
});

/* ── DELETE /admin/users/:id/otp/bypass — cancel an active OTP bypass ── */
router.delete("/users/:id/otp/bypass", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const userId = req.params["id"]!;
  const [user] = await db.select({ id: usersTable.id, phone: usersTable.phone }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  // no user notification — admin-only action
  await db.update(usersTable).set({ otpBypassUntil: null, updatedAt: new Date() }).where(eq(usersTable.id, userId));

  const ip = getClientIp(req);
  const adminReq = req as unknown as AdminRequest;
  addAuditEntry({ action: "admin_otp_bypass_cancel", ip, adminId: adminReq.adminId, details: `Admin cancelled OTP bypass for user ${userId} (${user.phone})`, result: "success" });
  writeAuthAuditLog("admin_otp_bypass_cancel", {
    userId,
    ip,
    userAgent: req.headers["user-agent"] ?? undefined,
    metadata: { phone: user.phone, adminId: adminReq.adminId, result: "success" },
  });

  sendSuccess(res, { success: true });
});


/* ── Force-disable 2FA for a user (admin action) ── */
router.post("/users/:id/2fa/disable", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const userId = req.params["id"]!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!user.totpEnabled) { sendValidationError(res, "2FA is not enabled for this user"); return; }

  await db.update(usersTable).set({
    totpEnabled: false, totpSecret: null, backupCodes: null, trustedDevices: null, updatedAt: new Date(),
  }).where(eq(usersTable.id, userId));

  const ip = getClientIp(req);
  addAuditEntry({ action: "admin_2fa_disable", ip, details: `Admin force-disabled 2FA for user ${userId} (${user.phone})`, result: "success" });
  writeAuthAuditLog("admin_2fa_disabled", { userId, ip, userAgent: req.headers["user-agent"] as string, metadata: { adminAction: true } });

  sendSuccess(res, { success: true, message: `2FA disabled for user ${user.name ?? user.phone}` });
});

router.post("/users/:id/reset-wallet-pin", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const userId = req.params["id"]!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }
  if (!user.walletPinHash) { sendValidationError(res, "This user has no MPIN set"); return; }

  await db.update(usersTable).set({
    walletPinHash: null,
    walletPinAttempts: 0,
    walletPinLockedUntil: null,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, userId));

  sendSuccess(res, { success: true, message: `Wallet MPIN reset for ${user.name ?? user.phone}. User will need to create a new MPIN.` });
});

/* ── Admin Accounts (Sub-Admins) ── */
router.patch("/users/:id/request-correction", requirePermission(USERS_PERMS.manage), async (req, res) => {
  const { field, note } = req.body as { field?: string; note?: string };
  const [user] = await db.update(usersTable)
    .set({ approvalStatus: "correction_needed", approvalNote: note || `Please re-upload: ${field || "document"}`, updatedAt: new Date() })
    .where(eq(usersTable.id, req.params["id"]!))
    .returning();
  if (!user) { sendNotFound(res, "User not found"); return; }
  addAuditEntry({ action: "user_correction_requested", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Correction requested for ${user.phone}: ${field}`, result: "success" });
  const docLang = await getUserLanguage(user.id);
  await db.insert(notificationsTable).values({
    id: generateId(), userId: user.id,
    title: t("notifDocumentCorrection", docLang),
    body: note || t("notifDocumentCorrectionBody", docLang).replace("{field}", field || "document"),
    type: "system", icon: "document-outline",
  }).catch(() => {});
  sendSuccess(res, { success: true, user: stripUser(user) });
});

/* ── PATCH /admin/users/:id/waive-debt — waive rider's cancellation debt ── */
router.patch("/users/:id/waive-debt", requirePermission(FINANCE_PERMS.manage), async (req, res) => {
  const userId = req.params["id"]!;
  const [user] = await db.select({ id: usersTable.id, phone: usersTable.phone, cancellationDebt: usersTable.cancellationDebt })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }
  const debt = parseFloat(user.cancellationDebt ?? "0");
  if (debt <= 0) { sendSuccess(res, { success: true, message: "No debt to waive" }); return; }
  await db.update(usersTable).set({ cancellationDebt: "0", updatedAt: new Date() }).where(eq(usersTable.id, userId));
  addAuditEntry({ action: "debt_waived", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Cancelled debt of Rs.${debt.toFixed(0)} for ${user.phone}`, result: "success" });
  const debtLang = await getUserLanguage(userId);
  await db.insert(notificationsTable).values({
    id: generateId(), userId,
    title: t("notifDebtWaived", debtLang),
    body: t("notifDebtWaivedBody", debtLang).replace("{amount}", debt.toFixed(0)),
    type: "system", icon: "checkmark-circle-outline",
  }).catch(() => {});
  sendSuccess(res, { success: true, waived: debt });
});

/* ── PATCH /admin/users/:id/bulk-ban — ban/unban multiple users ── */
router.patch("/users/bulk-ban", requirePermission(USERS_PERMS.ban), async (req, res) => {
  const { ids, action, reason } = req.body as { ids: string[]; action: "ban" | "unban"; reason?: string };
  if (!ids?.length) { sendValidationError(res, "ids required"); return; }
  const adminReq = req as AdminRequest;
  for (const id of ids) {
    if (action === "ban") {
      const [u] = await db.select({ roles: usersTable.roles }).from(usersTable).where(eq(usersTable.id, id)).limit(1);
      await db.insert(accountConditionsTable).values({
        id: generateId(),
        userId: id,
        userRole: u?.roles?.split(",")[0]?.trim() || "customer",
        conditionType: "ban_hard",
        severity: "ban",
        category: "ban",
        reason: reason || "Bulk banned by admin",
        appliedBy: adminReq.adminId || "admin",
      });
    } else {
      await db.update(accountConditionsTable).set({
        isActive: false, liftedAt: new Date(), liftedBy: adminReq.adminId || "admin",
        liftReason: "Bulk unbanned via admin", updatedAt: new Date(),
      }).where(and(
        eq(accountConditionsTable.userId, id),
        eq(accountConditionsTable.isActive, true),
        eq(accountConditionsTable.severity, "ban"),
      ));
    }
    await reconcileUserFlags(id);
  }
  addAuditEntry({ action: `bulk_${action}`, ip: getClientIp(req), adminId: adminReq.adminId, details: `Bulk ${action}: ${ids.length} users`, result: "success" });
  sendSuccess(res, { success: true, affected: ids.length, action });
});

/* ── GET /admin/users/:id/sessions — list user's active sessions ── */
router.get("/users/:id/sessions", async (req, res) => {
  const { id } = req.params;
  const sessions = await db
    .select()
    .from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, id!), isNull(userSessionsTable.revokedAt)))
    .orderBy(desc(userSessionsTable.lastActiveAt));

  sendSuccess(res, {
    sessions: sessions.map(s => ({
      id: s.id,
      deviceName: s.deviceName,
      browser: s.browser,
      os: s.os,
      ip: s.ip,
      location: s.location,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
    })),
  });
});

/* ── DELETE /admin/users/:id/sessions/:sessionId — revoke one session ── */
router.delete("/users/:id/sessions/:sessionId", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const { id, sessionId } = req.params;
  const [session] = await db
    .select()
    .from(userSessionsTable)
    .where(and(eq(userSessionsTable.id, sessionId!), eq(userSessionsTable.userId, id!)))
    .limit(1);

  if (!session) { sendNotFound(res, "Session"); return; }

  await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.id, sessionId!));

  if (session.refreshTokenId) {
    await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.id, session.refreshTokenId));
  }

  writeAuthAuditLog("admin_session_revoked", { userId: id!, ip: req.ip ?? "", metadata: { sessionId } });
  sendSuccess(res, { revoked: true });
});

/* ── DELETE /admin/users/:id/sessions — revoke ALL sessions for user ── */
router.delete("/users/:id/sessions", requirePermission(SYSTEM_PERMS.securityManage), async (req, res) => {
  const { id } = req.params;

  await db.update(userSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessionsTable.userId, id!), isNull(userSessionsTable.revokedAt)));

  await db.update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokensTable.userId, id!), isNull(refreshTokensTable.revokedAt)));

  /* Bump tokenVersion so all outstanding access JWTs are immediately invalid */
  await db.update(usersTable)
    .set({ tokenVersion: sql`token_version + 1`, updatedAt: new Date() })
    .where(eq(usersTable.id, id!));

  writeAuthAuditLog("admin_all_sessions_revoked", { userId: id!, ip: req.ip ?? "" });
  sendSuccess(res, { revoked: true, message: "All sessions revoked for user" });
});

export default router;
