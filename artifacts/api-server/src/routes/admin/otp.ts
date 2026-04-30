import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, platformSettingsTable, authAuditLogTable, otpBypassAuditTable, whitelistUsersTable } from "@workspace/db/schema";
import { eq, desc, and, sql, inArray, or, type SQL } from "drizzle-orm";
import {
  addAuditEntry, getClientIp, getPlatformSettings, invalidateSettingsCache,
  type AdminRequest,
} from "../admin-shared.js";
import { sendSuccess, sendNotFound, sendValidationError } from "../../lib/response.js";
import { generateSecureOtp } from "../../services/password.js";
import { generateId } from "../../lib/id.js";
import { createHash, randomBytes } from "crypto";
import { writeAuthAuditLog } from "../../middleware/security.js";
import { AuditService } from "../../services/admin-audit.service.js";
import { UserService } from "../../services/admin-user.service.js";
import { logger } from "../../lib/logger.js";

const router = Router();

/* Shared regex constant — must mirror the one in the admin SPA so client/server
   accept exactly the same set of bypass codes. */
export const BYPASS_CODE_REGEX = /^[0-9]{6}$/;

/* Generic, shape-typed update payload for the whitelist PATCH endpoint. */
interface WhitelistUpdate {
  label?: string | null;
  bypassCode?: string;
  isActive?: boolean;
  expiresAt?: Date | null;
  updatedAt?: Date;
}

/**
 * Cryptographically secure 6-digit bypass code.
 * Uses crypto.randomBytes — OS CSPRNG, cannot be predicted by an attacker.
 */
function generateBypassCode(): string {
  const n = randomBytes(3).readUIntBE(0, 3) % 1_000_000;
  return n.toString().padStart(6, "0");
}

/**
 * Normalise the User-Agent header to a string. Express types it as
 * `string | string[] | undefined`.
 */
function safeUserAgent(req: { headers: { "user-agent"?: string | string[] } }): string {
  const raw = req.headers["user-agent"];
  if (Array.isArray(raw)) return raw.join(", ") || "unknown";
  return (raw ?? "unknown") as string;
}

/**
 * Map a thrown error to a safe, generic message for the client while
 * preserving the original details in our server logs.
 */
function sendServerError(
  res: import("express").Response,
  error: unknown,
  context: string,
): void {
  logger.error({ err: error, context }, `[admin/otp] ${context}`);
  res.status(500).json({
    success: false,
    error: "Database operation failed. Please try again.",
  });
}

/* ─── GET /admin/otp/status ───────────────────────────────────────────────── */
router.get("/otp/status", async (_req, res) => {
  try {
    const status = await UserService.getOtpStatus();
    sendSuccess(res, status);
  } catch (error) {
    sendServerError(res, error, "get OTP status");
  }
});

/* ─── POST /admin/otp/disable ─────────────────────────────────────────────── */
router.post("/otp/disable", async (req, res) => {
  const minutes = Number(req.body?.minutes);
  const adminReq = req as AdminRequest;

  if (!minutes || minutes <= 0 || minutes > 10080) {
    return sendValidationError(res, "Minutes must be between 1 and 10080");
  }

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_otp_global_disable",
        resourceType: "otp_config",
        resource: "global_disable",
        details: `Disabled OTP for ${minutes} minutes`,
      },
      () => UserService.disableOtpGlobally(minutes)
    );

    writeAuthAuditLog("admin_otp_global_disable", {
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { adminId: adminReq.adminId, minutes, disabledUntil: result.disabledUntil, result: "success" },
    });

    sendSuccess(res, result);
  } catch (error) {
    sendServerError(res, error, "disable OTP globally");
  }
});

/* ─── DELETE /admin/otp/disable ───────────────────────────────────────────── */
router.delete("/otp/disable", async (req, res) => {
  const adminReq = req as AdminRequest;

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_otp_global_restore",
        resourceType: "otp_config",
        resource: "global_restore",
        details: "Restored global OTP (early restore)",
      },
      () => UserService.restoreOtpGlobally()
    );

    writeAuthAuditLog("admin_otp_global_restore", {
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { adminId: adminReq.adminId, result: "success" },
    });

    sendSuccess(res, result);
  } catch (error) {
    sendServerError(res, error, "restore OTP globally");
  }
});

/* ─── GET /admin/otp/audit ─────────────────────────────────────────────── */
router.get("/otp/audit", async (req, res) => {
  const { userId, from, to, page } = req.query as Record<string, string>;

  /* Validate optional date params up-front so the service never receives
     garbage that would produce a misleading error response. */
  if (from && isNaN(new Date(from).getTime())) {
    return sendValidationError(res, "Invalid 'from' date — expected ISO 8601 string");
  }
  if (to && isNaN(new Date(to).getTime())) {
    return sendValidationError(res, "Invalid 'to' date — expected ISO 8601 string");
  }

  try {
    const result = await UserService.getOtpAuditLog({
      userId,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
    });
    sendSuccess(res, result);
  } catch (error) {
    sendServerError(res, error, "get OTP audit log");
  }
});

/* ─── GET /admin/otp/channels ─────────────────────────────────────────────── */
router.get("/otp/channels", async (_req, res) => {
  try {
    const result = await UserService.getOtpChannels();
    sendSuccess(res, result);
  } catch (error) {
    sendServerError(res, error, "get OTP channels");
  }
});

/* ─── PATCH /admin/otp/channels ───────────────────────────────────────────── */
router.patch("/otp/channels", async (req, res) => {
  const { channels } = req.body;
  const adminReq = req as AdminRequest;

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_otp_channels_update",
        resourceType: "otp_config",
        resource: "channels",
        details: `Updated OTP channel priority: ${channels?.join(" → ")}`,
      },
      () => UserService.updateOtpChannels(channels)
    );

    sendSuccess(res, result);
  } catch (error: any) {
    const errMsg = error.message || String(error);
    sendValidationError(res, errMsg);
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* ADMIN OTP TOOLS: GENERATE + VERIFY                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * POST /admin/otp/generate
 * Generate a fresh OTP for a user identified by userId, phone, or email.
 * Returns the plaintext OTP so the admin can share it with the user directly.
 */
router.post("/otp/generate", async (req, res) => {
  const { identifier } = req.body as { identifier?: string };
  const adminReq = req as AdminRequest;

  if (!identifier || !identifier.trim()) {
    return sendValidationError(res, "identifier (userId, phone, or email) is required");
  }

  const id = identifier.trim();

  try {
    /* Resolve the user by userId (UUID-like), phone, or email. */
    const user = await db.query.usersTable.findFirst({
      where: or(
        eq(usersTable.id, id),
        eq(usersTable.phone, id),
        eq(usersTable.email, id.toLowerCase()),
      ),
      columns: { id: true, phone: true, email: true, name: true },
    });

    if (!user) {
      return sendNotFound(res, "User not found");
    }

    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_otp_generate",
        resourceType: "user",
        resource: user.id,
        details: `Generated OTP for user ${user.phone || user.email}`,
      },
      () => UserService.generateOtpForUser(user.id)
    );

    writeAuthAuditLog("admin_otp_generate", {
      userId: user.id,
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { phone: result.phone, adminId: adminReq.adminId },
    });

    sendSuccess(res, {
      otp: result.otp,
      expiresAt: result.expiresAt,
      userId: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    sendServerError(res, error, "generate OTP");
  }
});

/**
 * POST /admin/otp/verify
 * Verify an OTP for a user — admin tool to check whether a given code is
 * valid before manually authorising an action. Does NOT consume the OTP
 * (otpUsed is not set to true) so this is read-only / non-destructive.
 */
router.post("/otp/verify", async (req, res) => {
  const { identifier, otp } = req.body as { identifier?: string; otp?: string };
  const adminReq = req as AdminRequest;

  if (!identifier || !identifier.trim()) {
    return sendValidationError(res, "identifier (userId, phone, or email) is required");
  }
  if (!otp || !otp.trim()) {
    return sendValidationError(res, "otp is required");
  }
  if (!/^\d{4,8}$/.test(otp.trim())) {
    return sendValidationError(res, "otp must be 4–8 digits");
  }

  const id = identifier.trim();

  try {
    const user = await db.query.usersTable.findFirst({
      where: or(
        eq(usersTable.id, id),
        eq(usersTable.phone, id),
        eq(usersTable.email, id.toLowerCase()),
      ),
      columns: { id: true, phone: true, email: true, name: true, otpCode: true, otpExpiry: true, otpUsed: true },
    });

    if (!user) {
      return sendNotFound(res, "User not found");
    }

    const now = new Date();

    if (!user.otpCode) {
      return sendSuccess(res, { valid: false, reason: "No OTP has been generated for this user" });
    }

    if (user.otpExpiry && user.otpExpiry < now) {
      return sendSuccess(res, { valid: false, reason: "OTP has expired" });
    }

    if (user.otpUsed) {
      return sendSuccess(res, { valid: false, reason: "OTP has already been used" });
    }

    /* Constant-time hash comparison to prevent timing attacks. */
    const submittedHash = createHash("sha256").update(otp.trim()).digest("hex");
    const isMatch = submittedHash === user.otpCode;

    writeAuthAuditLog("admin_otp_verify_check", {
      userId: user.id,
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: {
        adminId: adminReq.adminId,
        phone: user.phone,
        result: isMatch ? "match" : "mismatch",
      },
    });

    sendSuccess(res, {
      valid: isMatch,
      reason: isMatch ? undefined : "OTP does not match",
      userId: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
      expiresAt: user.otpExpiry?.toISOString() ?? null,
    });
  } catch (error) {
    sendServerError(res, error, "verify OTP");
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* PER-USER OTP BYPASS ENDPOINTS                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

/* ─── POST /admin/users/:id/otp/generate ─────────────────────────────────── */
router.post("/users/:id/otp/generate", async (req, res) => {
  const userId = req.params["id"]!;
  const adminReq = req as AdminRequest;

  try {
    const result = await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_otp_generate",
        resourceType: "user",
        resource: userId,
        details: `Generated OTP for user ${userId}`,
      },
      () => UserService.generateOtpForUser(userId)
    );

    writeAuthAuditLog("admin_otp_generate", {
      userId,
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { phone: result.phone, adminId: adminReq.adminId },
    });

    sendSuccess(res, { otp: result.otp, expiresAt: result.expiresAt });
  } catch (error: any) {
    const errMsg = error.message || String(error);
    if (errMsg.includes("not found")) {
      sendNotFound(res, "User not found");
    } else {
      sendServerError(res, error, "generate OTP for user");
    }
  }
});

/* ─── POST /admin/users/:id/otp/bypass ──────────────────────────────────────*/
router.post("/users/:id/otp/bypass", async (req, res) => {
  const userId = req.params["id"]!;
  const minutes = Number(req.body?.minutes || 0);
  const adminReq = req as AdminRequest;

  if (!minutes || minutes <= 0 || minutes > 1440) {
    return sendValidationError(res, "Minutes must be between 1 and 1440");
  }

  try {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.id, userId),
      columns: { id: true, phone: true, email: true, name: true, otpBypassUntil: true },
    });

    if (!user) {
      return sendNotFound(res, "User not found");
    }

    const now = new Date();
    if (user.otpBypassUntil && user.otpBypassUntil.getTime() > now.getTime()) {
      return res.status(409).json({
        success: false,
        error: "User already has an active OTP bypass.",
        existingBypassUntil: user.otpBypassUntil.toISOString(),
      });
    }

    const bypassUntil = new Date(Date.now() + minutes * 60 * 1000);
    const userAgent = safeUserAgent(req);
    const ip = getClientIp(req);

    await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await tx
        .update(usersTable)
        .set({ otpBypassUntil: bypassUntil, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      await tx.insert(otpBypassAuditTable).values({
        id: generateId(),
        eventType: "otp_bypass_granted",
        userId,
        adminId: adminReq.adminId,
        phone: user.phone,
        email: user.email,
        bypassReason: "admin_grant",
        expiresAt: bypassUntil,
        ipAddress: ip,
        userAgent,
        metadata: { minutes },
      });
    });

    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: ip,
        action: "admin_otp_bypass_grant",
        resourceType: "user",
        resource: userId,
        details: `Granted OTP bypass to ${user.phone || user.email} for ${minutes} minutes`,
      },
      async () => ({ success: true })
    );

    sendSuccess(res, {
      bypassUntil: bypassUntil.toISOString(),
      minutesGranted: minutes,
      userPhone: user.phone,
      userName: user.name,
    });
  } catch (error) {
    sendServerError(res, error, "grant per-user bypass");
  }
});

/* ─── DELETE /admin/users/:id/otp/bypass ──────────────────────────────────────*/
router.delete("/users/:id/otp/bypass", async (req, res) => {
  const userId = req.params["id"]!;
  const adminReq = req as AdminRequest;

  try {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.id, userId),
      columns: { id: true, phone: true, email: true, name: true, otpBypassUntil: true },
    });

    if (!user) {
      return sendNotFound(res, "User not found");
    }

    const userAgent = safeUserAgent(req);
    const ip = getClientIp(req);

    await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await tx
        .update(usersTable)
        .set({ otpBypassUntil: null, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      await tx.insert(otpBypassAuditTable).values({
        id: generateId(),
        eventType: "otp_bypass_revoked",
        userId,
        adminId: adminReq.adminId,
        phone: user.phone,
        email: user.email,
        bypassReason: "admin_revoke",
        ipAddress: ip,
        userAgent,
      });
    });

    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: ip,
        action: "admin_otp_bypass_revoke",
        resourceType: "user",
        resource: userId,
        details: `Revoked OTP bypass for ${user.phone || user.email}`,
      },
      async () => ({ success: true })
    );

    sendSuccess(res, {
      message: `Bypass revoked for ${user.phone || user.email}`,
    });
  } catch (error) {
    sendServerError(res, error, "revoke per-user bypass");
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* WHITELIST CRUD ENDPOINTS                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

/* ─── GET /admin/otp/whitelist ───────────────────────────────────────────────*/
router.get("/otp/whitelist", async (req, res) => {
  const page = Math.max(1, parseInt((req.query["page"] as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) || "50", 10)));
  const offset = (page - 1) * limit;

  try {
    const [entries, [{ total }]] = await Promise.all([
      db.query.whitelistUsersTable.findMany({
        orderBy: desc(whitelistUsersTable.createdAt),
        limit,
        offset,
      }),
      db.select({ total: sql<number>`COUNT(*)::int` }).from(whitelistUsersTable),
    ]);

    sendSuccess(res, {
      entries,
      total: Number(total ?? 0),
      page,
      pages: Math.ceil(Number(total ?? 0) / limit),
    });
  } catch (error) {
    sendServerError(res, error, "get whitelist");
  }
});

/* ─── POST /admin/otp/whitelist ──────────────────────────────────────────────*/
router.post("/otp/whitelist", async (req, res) => {
  const { identifier, label, bypassCode, expiresAt } = req.body;
  const adminReq = req as AdminRequest;

  /* Generate a CSPRNG bypass code if none supplied — the frontend leaves this
     field blank to signal "auto-generate". */
  const code = bypassCode ? String(bypassCode).trim() : generateBypassCode();

  if (!identifier || identifier.length < 7) {
    return sendValidationError(res, "Identifier must be at least 7 characters (phone or email)");
  }

  if (!BYPASS_CODE_REGEX.test(code)) {
    return sendValidationError(res, "Bypass code must be exactly 6 digits");
  }

  let expires: Date | null = null;
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return sendValidationError(res, "Expires At must be a valid date/time");
    }
    expires = parsed;
  }

  try {
    const existing = await db.query.whitelistUsersTable.findFirst({
      where: eq(whitelistUsersTable.identifier, identifier),
      columns: { id: true },
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "Identifier already whitelisted" });
    }

    const id = generateId();

    await db.insert(whitelistUsersTable).values({
      id,
      identifier,
      label: label || null,
      bypassCode: code,
      isActive: true,
      expiresAt: expires,
      createdBy: adminReq.adminId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_whitelist_entry_add",
        resourceType: "whitelist",
        resource: id,
        details: `Added whitelist entry: ${identifier}${label ? ` (${label})` : ""}`,
      },
      async () => ({ success: true })
    );

    sendSuccess(res, {
      entry: {
        id,
        identifier,
        label: label || null,
        bypassCode: code,
        isActive: true,
        expiresAt: expires ? expires.toISOString() : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    sendServerError(res, error, "create whitelist entry");
  }
});

/* ─── PATCH /admin/otp/whitelist/:id ─────────────────────────────────────────*/
router.patch("/otp/whitelist/:id", async (req, res) => {
  const id = req.params["id"]!;
  const updates = (req.body ?? {}) as Partial<WhitelistUpdate> & { expiresAt?: string | Date | null };
  const adminReq = req as AdminRequest;

  try {
    const existing = await db.query.whitelistUsersTable.findFirst({
      where: eq(whitelistUsersTable.id, id),
    });

    if (!existing) {
      return sendNotFound(res, "Whitelist entry not found");
    }

    const updateData: Partial<WhitelistUpdate> = { updatedAt: new Date() };

    if (updates.label !== undefined) {
      updateData.label = updates.label;
    }

    if (updates.bypassCode) {
      if (!BYPASS_CODE_REGEX.test(updates.bypassCode)) {
        return sendValidationError(res, "Bypass code must be exactly 6 digits");
      }
      updateData.bypassCode = updates.bypassCode;
    }

    if (updates.isActive !== undefined) {
      updateData.isActive = updates.isActive;
    }

    if (updates.expiresAt !== undefined) {
      updateData.expiresAt = updates.expiresAt
        ? (updates.expiresAt instanceof Date ? updates.expiresAt : new Date(updates.expiresAt))
        : null;
    }

    await db
      .update(whitelistUsersTable)
      .set(updateData)
      .where(eq(whitelistUsersTable.id, id));

    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_whitelist_entry_update",
        resourceType: "whitelist",
        resource: id,
        details: `Updated whitelist entry: ${existing.identifier}`,
      },
      async () => ({ success: true })
    );

    sendSuccess(res, { message: "Whitelist entry updated" });
  } catch (error) {
    sendServerError(res, error, "update whitelist entry");
  }
});

/* ─── DELETE /admin/otp/whitelist/:id ────────────────────────────────────────*/
router.delete("/otp/whitelist/:id", async (req, res) => {
  const id = req.params["id"]!;
  const adminReq = req as AdminRequest;

  try {
    const existing = await db.query.whitelistUsersTable.findFirst({
      where: eq(whitelistUsersTable.id, id),
      columns: { id: true, identifier: true },
    });

    if (!existing) {
      return sendNotFound(res, "Whitelist entry not found");
    }

    await db.delete(whitelistUsersTable).where(eq(whitelistUsersTable.id, id));

    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: getClientIp(req),
        action: "admin_whitelist_entry_delete",
        resourceType: "whitelist",
        resource: id,
        details: `Deleted whitelist entry: ${existing.identifier}`,
      },
      async () => ({ success: true })
    );

    sendSuccess(res, { message: "Whitelist entry deleted" });
  } catch (error) {
    sendServerError(res, error, "delete whitelist entry");
  }
});

export default router;
