import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  adminAccountsTable,
} from "@workspace/db/schema";
import {
  eq,
  desc,
  count,
  sum,
  and,
  gte,
  lte,
  sql,
  or,
  ilike,
  asc,
  isNull,
  isNotNull,
  avg,
  ne,
} from "drizzle-orm";
import {
  stripUser,
  generateId,
  getUserLanguage,
  t,
  getPlatformSettings,
  adminAuth,
  getAdminSecret,
  sendUserNotification,
  logger,
  ORDER_NOTIF_KEYS,
  RIDE_NOTIF_KEYS,
  PHARMACY_NOTIF_KEYS,
  PARCEL_NOTIF_KEYS,
  checkAdminLoginLockout,
  recordAdminLoginFailure,
  resetAdminLoginAttempts,
  addAuditEntry,
  addSecurityEvent,
  getClientIp,
  signAdminJwt,
  verifyAdminJwt,
  invalidateSettingsCache,
  getCachedSettings,
  ADMIN_TOKEN_TTL_HRS,
  verifyTotpToken,
  verifyAdminSecret,
  ensureDefaultRideServices,
  ensureDefaultLocations,
  formatSvc,
  type AdminRequest,
  adminLoginAttempts,
  ADMIN_MAX_ATTEMPTS,
} from "../../admin-shared.js";
import { hashAdminSecret } from "../../../services/password.js";
import { recordAdminPasswordSnapshot } from "../../../services/admin-password-watch.service.js";
import {
  generateTotpSecret,
  verifyTotpToken as verifyTotp,
  generateQRCodeDataURL,
  getTotpUri,
} from "../../../services/totp.js";
import { writeAuthAuditLog } from "../../../middleware/security.js";
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendForbidden,
  sendUnauthorized,
  sendValidationError,
} from "../../../lib/response.js";
import { UserService } from "../../../services/admin-user.service.js";
import { AuditService } from "../../../services/admin-audit.service.js";
import { requirePermission } from "../../../middlewares/require-permission.js";
import { SYSTEM_PERMS } from "../../../middlewares/permissions-map.js";
import { logAdminAudit } from "../../../middlewares/admin-audit.js";

const router = Router();
router.post("/auth", async (req, res) => {
  const body = (req.body ?? {}) as { username?: string; password?: string; secret?: string };
  const username = (body.username ?? "").trim();
  /* Backwards-compatible: accept "password" (new) or "secret" (legacy) */
  const password = body.password ?? body.secret ?? "";
  const ip = getClientIp(req);
  const ADMIN_SECRET = await getAdminSecret();

  const lockout = checkAdminLoginLockout(ip);
  if (lockout.locked) {
    addSecurityEvent({
      type: "admin_login_locked",
      ip,
      details: `Locked admin login attempt from ${ip}`,
      severity: "high",
    });
    res
      .status(429)
      .json({
        error: `Too many failed attempts. Try again in ${lockout.minutesLeft} minute(s).`,
      });
    return;
  }

  /* ── Attempt master super-admin login ──
     Accepts:
       - new flow: username "admin" (or "super") + password = ADMIN_SECRET
       - legacy flow: any payload whose password equals ADMIN_SECRET (no username) */
  const isMasterUsername =
    username === "" || username.toLowerCase() === "admin" || username.toLowerCase() === "super";
  if (ADMIN_SECRET && password === ADMIN_SECRET && isMasterUsername) {
    resetAdminLoginAttempts(ip);
    const adminToken = signAdminJwt(
      null,
      "super",
      "Super Admin",
      ADMIN_TOKEN_TTL_HRS,
    );
    addAuditEntry({
      action: "admin_login_success",
      ip,
      details: "Master admin login — JWT issued",
      result: "success",
    });
    writeAuthAuditLog("admin_login", {
      ip,
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { role: "super" },
    });
    res.json({
      success: true,
      token: adminToken,
      expiresIn: `${ADMIN_TOKEN_TTL_HRS}h`,
    });
    return;
  }

  /* ── Attempt sub-admin login via username + password ──
     Username matches `username` column (preferred) or falls back to `name`
     (case-insensitive). Password verified via bcrypt / legacy scrypt / plaintext. */
  const activeSubs2 = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.isActive, true));

  let candidates = activeSubs2;
  if (username) {
    const u = username.toLowerCase();
    candidates = activeSubs2.filter(
      (s) =>
        (s.username && s.username.toLowerCase() === u) ||
        s.name.toLowerCase() === u,
    );
  }
  const sub = candidates.find((s) => verifyAdminSecret(password, s.secret));

  if (sub) {
    resetAdminLoginAttempts(ip);
    const adminToken = signAdminJwt(
      sub.id,
      sub.role,
      sub.name,
      ADMIN_TOKEN_TTL_HRS,
    );
    await db
      .update(adminAccountsTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminAccountsTable.id, sub.id));
    addAuditEntry({
      action: "admin_login_success",
      ip,
      adminId: sub.id,
      details: `Sub-admin ${sub.name} login — JWT issued`,
      result: "success",
    });
    writeAuthAuditLog("admin_login", {
      ip,
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { adminId: sub.id, role: sub.role },
    });
    res.json({
      success: true,
      token: adminToken,
      expiresIn: `${ADMIN_TOKEN_TTL_HRS}h`,
    });
    return;
  }

  recordAdminLoginFailure(ip);
  const rec = adminLoginAttempts.get(ip);
  const remaining = Math.max(0, ADMIN_MAX_ATTEMPTS - (rec?.count ?? 0));
  addAuditEntry({
    action: "admin_login_failed",
    ip,
    details: "Wrong admin secret",
    result: "fail",
  });
  addSecurityEvent({
    type: "admin_login_failed",
    ip,
    details: `Failed admin login attempt from ${ip}`,
    severity: "high",
  });
  if (remaining === 0) {
    res
      .status(429)
      .json({
        error: `Too many failed attempts. Account locked for 15 minutes.`,
      });
  } else {
    res
      .status(401)
      .json({
        error: `Invalid admin password. ${remaining} attempt(s) remaining.`,
      });
  }
});

router.use(adminAuth);
router.get("/admin-accounts", async (_req, res) => {
  const accounts = await db
    .select({
      id: adminAccountsTable.id,
      name: adminAccountsTable.name,
      username: adminAccountsTable.username,
      email: adminAccountsTable.email,
      role: adminAccountsTable.role,
      permissions: adminAccountsTable.permissions,
      isActive: adminAccountsTable.isActive,
      mustChangePassword: adminAccountsTable.mustChangePassword,
      lastLoginAt: adminAccountsTable.lastLoginAt,
      createdAt: adminAccountsTable.createdAt,
    })
    .from(adminAccountsTable)
    .orderBy(desc(adminAccountsTable.createdAt));
  res.json({
    accounts: accounts.map((a) => ({
      ...a,
      lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

router.post("/admin-accounts", requirePermission(SYSTEM_PERMS.adminManage), async (req, res) => {
  const adminReq = req as AdminRequest;
  const body = req.body as Record<string, unknown>;

  /* Accept both new ("username"/"password") and legacy ("name"/"secret") shapes */
  const name = (body.name ?? body.username) as string | undefined;
  const password = (body.password ?? body.secret) as string | undefined;
  const usernameField = (body.username ?? body.name) as string | undefined;
  const emailRaw = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    sendValidationError(res, "Invalid email address");
    return;
  }
  const emailField = emailRaw || null;

  if (!name || !password) {
    sendValidationError(res, "username and password required");
    return;
  }
  if (password === (await getAdminSecret())) {
    sendError(res, "Cannot use the master secret", 400);
    return;
  }

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "admin_account_create",
        resourceType: "admin_account",
        resource: name,
        details: `Role: ${body.role || "manager"}`,
      },
      () =>
        UserService.createAdminAccount({
          name,
          username: usernameField,
          email: emailField,
          secret: password,
          role: (body.role as string) || "manager",
        }),
    );

    sendSuccess(res, { success: true, adminName: name }, undefined, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("23505") || message.includes("duplicate")) {
      sendError(res, "Admin name or secret already in use", 409);
    } else {
      sendError(res, message, 400);
    }
  }
});

router.patch("/admin-accounts/:id", requirePermission(SYSTEM_PERMS.adminManage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, any> = {};
  const targetId = req.params["id"]!;
  const adminReq = req as AdminRequest;
  const isSelfEdit = adminReq.adminId === targetId;
  if (body.name !== undefined) updates.name = body.name;
  if (body.username !== undefined) updates.username = body.username;
  if (body.email !== undefined) {
    const raw = body.email;
    if (raw === null || raw === "") {
      updates.email = null;
    } else if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
      }
      updates.email = normalized;
    }
  }
  if (body.role !== undefined) updates.role = body.role;
  if (body.permissions !== undefined) updates.permissions = body.permissions;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  const newPassword = body.password ?? body.secret;
  if (newPassword !== undefined) {
    if (newPassword === (await getAdminSecret())) {
      res.status(400).json({ error: "Cannot use the master secret" });
      return;
    }
    updates.secret = hashAdminSecret(newPassword as string);
  }
  // The optional "still using default credentials" marker is cleared as
  // soon as the admin self-edits their username or password (the two
  // surfaces the first-login popup exposes). Edits performed by another
  // super-admin do not touch the flag — that is genuinely a different
  // operator's account.
  if (isSelfEdit && (updates.username !== undefined || updates.secret !== undefined)) {
    updates.defaultCredentials = false;
  }
  const [account] = await db
    .update(adminAccountsTable)
    .set(updates)
    .where(eq(adminAccountsTable.id, targetId))
    .returning();
  if (!account) {
    res.status(404).json({ error: "Admin account not found" });
    return;
  }
  // If a password was set on this PATCH, refresh the watchdog snapshot so the
  // legitimate super-admin edit is not later misclassified as an out-of-band
  // direct DB write on the next startup scan.
  if (updates.secret) {
    await recordAdminPasswordSnapshot({
      adminId: account.id,
      secret: updates.secret,
      passwordChangedAt: new Date(),
    });
  }
  res.json({
    ...account,
    secret: "••••••",
    createdAt: account.createdAt.toISOString(),
  });
});

router.delete("/admin-accounts/:id", requirePermission(SYSTEM_PERMS.adminManage), async (req, res) => {
  await db
    .delete(adminAccountsTable)
    .where(eq(adminAccountsTable.id, req.params["id"]!));
  res.json({ success: true });
});

/**
 * POST /api/admin/system/admin-accounts/:id/send-reset-link
 *
 * Super-admin action: issue a single-use password reset link for the
 * specified admin and email it to them. Returns the (already-emailed) URL
 * to the caller in non-production environments so the operator can copy it
 * out-of-band when SMTP is not configured.
 */
router.post(
  "/admin-accounts/:id/send-reset-link",
  // Identity-management action: gated behind the same RBAC permission used
  // for managing roles/admin identities. requirePermission auto-passes
  // super admins, so this preserves the existing super-admin entry point
  // while allowing fine-grained delegation later via RBAC.
  requirePermission("system.roles.manage"),
  async (req, res) => {
  const adminReq = req as AdminRequest;

  const targetId = req.params["id"]!;
  const [target] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, targetId))
    .limit(1);

  if (!target) {
    res.status(404).json({ success: false, error: "Admin account not found" });
    return;
  }
  if (!target.isActive) {
    res.status(400).json({
      success: false,
      error: "Cannot send a reset link to an inactive admin account.",
    });
    return;
  }
  if (!target.email) {
    res.status(400).json({
      success: false,
      error: "Target admin has no email on file. Set an email first.",
    });
    return;
  }

  const ip = adminReq.adminIp || getClientIp(req);
  const userAgent = req.headers["user-agent"] ?? null;

  // Lazy-load to avoid a circular import at module init.
  const { issueAdminPasswordResetToken } = await import(
    "../../../services/admin-password.service.js"
  );
  const { sendAdminPasswordResetLinkEmail } = await import(
    "../../../services/email.js"
  );

  const issued = await issueAdminPasswordResetToken({
    adminId: target.id,
    requestedBy: "super_admin",
    requesterAdminId: adminReq.adminId ?? null,
    requesterIp: ip,
    requesterUserAgent: userAgent,
  });

  // Force the target admin to choose a new password on their next sign-in,
  // even if they don't click the emailed link. This makes the action a real
  // "lockout + reset" rather than just an out-of-band suggestion.
  await db
    .update(adminAccountsTable)
    .set({ mustChangePassword: true })
    .where(eq(adminAccountsTable.id, target.id));

  // Build the reset URL (mirrors the public flow).
  const base =
    process.env.ADMIN_BASE_URL ||
    process.env.APP_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/admin`
      : "http://localhost:5000/admin");
  const resetUrl = `${base.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(
    issued.rawToken,
  )}`;

  const sendResult = await sendAdminPasswordResetLinkEmail(target.email, {
    resetUrl,
    recipientName: target.name,
    expiresAt: issued.expiresAt,
  }).catch((err) => ({ sent: false, reason: (err as Error).message }));

  // Funnel into the same admin_audit_log stream the rest of the password
  // lifecycle uses (forgot/reset/change-password) so security teams have a
  // single sink to read.
  await logAdminAudit("admin_password_reset_link_sent", {
    adminId: target.id,
    ip,
    userAgent: userAgent ?? undefined,
    result: sendResult.sent ? "success" : "failure",
    reason: sendResult.sent ? undefined : sendResult.reason,
    metadata: {
      issuedBy: adminReq.adminId ?? null,
      issuedByName: adminReq.adminName ?? null,
      targetEmail: target.email,
      tokenId: issued.id,
      expiresAt: issued.expiresAt.toISOString(),
    },
  });

  res.json({
    success: true,
    sent: sendResult.sent,
    reason: sendResult.sent ? undefined : sendResult.reason,
    expiresAt: issued.expiresAt.toISOString(),
    // Reveal the URL only in non-production so a super-admin can copy it
    // when SMTP is not yet wired up. Production never echoes the token.
    resetUrl: process.env.NODE_ENV === "production" ? undefined : resetUrl,
  });
  },
);

/* ── App Management ── */
router.post("/rotate-secret", adminAuth, (req, res) => {
  const adminRole = (req as AdminRequest).adminRole;
  if (adminRole !== "super") {
    res
      .status(403)
      .json({ error: "Only super admin can rotate the master secret." });
    return;
  }

  /* The new secret must be provided in the request body.
     The actual env var rotation must be done by the operator, but this
     endpoint validates the new secret and returns guidance. */
  const { newSecret } = req.body;
  if (!newSecret || newSecret.length < 32) {
    res
      .status(400)
      .json({ error: "New secret must be at least 32 characters." });
    return;
  }

  const ip = getClientIp(req);
  addAuditEntry({
    action: "admin_secret_rotation_requested",
    ip,
    details: "Admin requested secret rotation",
    result: "success",
  });
  writeAuthAuditLog("admin_secret_rotation", {
    ip,
    metadata: {
      note: "Secret rotation requested — update ADMIN_SECRET env var",
    },
  });

  res.json({
    success: true,
    message:
      "Set the new secret as the ADMIN_SECRET environment variable and restart the server to apply the rotation.",
    instructions:
      "New secret validated — it meets the minimum length requirement (32+ chars).",
  });
});

router.get("/me/language", adminAuth, async (req, res) => {
  const adminId = req.adminId;
  if (!adminId) {
    res.json({ language: null });
    return;
  }
  const [admin] = await db
    .select({ language: adminAccountsTable.language })
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  res.json({ language: admin?.language ?? null });
});

/* PUT /admin/me/language — save current admin's language preference */
router.put("/me/language", adminAuth, async (req, res) => {
  const adminId = req.adminId;
  if (!adminId) {
    res.json({
      success: false,
      note: "Super admin language is managed locally",
    });
    return;
  }
  const { language } = req.body as { language?: string };
  if (!language) {
    res.status(400).json({ error: "language required" });
    return;
  }
  const VALID = new Set(["en", "ur", "roman", "en_roman", "en_ur"]);
  if (!VALID.has(language)) {
    res.status(400).json({ error: "Invalid language" });
    return;
  }
  await db
    .update(adminAccountsTable)
    .set({ language })
    .where(eq(adminAccountsTable.id, adminId));
  res.json({ success: true, language });
});

/* GET /admin/mfa/status — check if MFA is set up for the current sub-admin */
router.get("/mfa/status", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  if (!adminId) {
    res.json({ mfaEnabled: false, note: "Super admin does not use TOTP." });
    return;
  }
  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin) {
    res.status(404).json({ error: "Admin account not found" });
    return;
  }
  res.json({
    mfaEnabled: admin.totpEnabled,
    totpConfigured: !!admin.totpSecret,
  });
});

/* POST /admin/mfa/setup — generate a TOTP secret and QR code (step 1 of MFA setup) */
router.post("/mfa/setup", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not need TOTP setup." });
    return;
  }

  const secret = generateTotpSecret();
  const qrCodeUrl = await generateQRCodeDataURL(secret, adminName);
  const otpUri = getTotpUri(secret, adminName);

  /* Store secret but don't enable TOTP yet — must be verified first */
  await db
    .update(adminAccountsTable)
    .set({ totpSecret: secret, totpEnabled: false })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_setup_initiated",
    ip: req.adminIp!,
    adminId,
    details: `MFA setup started for ${adminName}`,
    result: "success",
  });

  res.json({
    secret,
    otpUri,
    qrCodeDataUrl: qrCodeUrl,
    instructions:
      "Scan the QR code with Google Authenticator or Authy. Then call POST /admin/mfa/verify with a valid token to activate MFA.",
  });
});

/* POST /admin/mfa/verify — verify a TOTP token to activate MFA */
router.post("/mfa/verify", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not use TOTP." });
    return;
  }

  const { token } = req.body as { token: string };
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin || !admin.totpSecret) {
    res
      .status(400)
      .json({
        error: "TOTP not set up yet. Call POST /admin/mfa/setup first.",
      });
    return;
  }

  if (admin.totpEnabled) {
    res.json({ success: true, message: "MFA is already active." });
    return;
  }

  const valid = verifyTotpToken(token, admin.totpSecret);
  if (!valid) {
    addAuditEntry({
      action: "mfa_verify_failed",
      ip: req.adminIp!,
      adminId,
      details: `MFA verify failed for ${adminName}`,
      result: "fail",
    });
    res.status(401).json({ error: "Invalid TOTP token. Please try again." });
    return;
  }

  await db
    .update(adminAccountsTable)
    .set({ totpEnabled: true })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_activated",
    ip: req.adminIp!,
    adminId,
    details: `MFA activated for ${adminName}`,
    result: "success",
  });

  res.json({
    success: true,
    message:
      "MFA successfully activated. You must now provide x-admin-totp with every request when global MFA is enabled.",
  });
});

/* DELETE /admin/mfa/disable — disable MFA (requires current valid TOTP or super admin) */
router.delete("/mfa/disable", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not use TOTP." });
    return;
  }

  const { token } = req.body as { token?: string };
  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin) {
    res.status(404).json({ error: "Admin not found" });
    return;
  }

  if (admin.totpEnabled && admin.totpSecret) {
    if (!token || !verifyTotpToken(token, admin.totpSecret)) {
      res
        .status(401)
        .json({ error: "Valid TOTP token required to disable MFA." });
      return;
    }
  }

  await db
    .update(adminAccountsTable)
    .set({ totpSecret: null, totpEnabled: false })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_disabled",
    ip: req.adminIp!,
    adminId,
    details: `MFA disabled for ${adminName}`,
    result: "warn",
  });

  res.json({
    success: true,
    message: "MFA has been disabled for your account.",
  });
});

export default router;
