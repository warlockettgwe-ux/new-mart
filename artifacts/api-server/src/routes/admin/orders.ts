import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  ordersTable, pharmacyOrdersTable, parcelBookingsTable, ridesTable, rideBidsTable,
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
} from "../admin-shared.js";
import { sendSuccess, sendError, sendNotFound, sendValidationError, sendErrorWithData } from "../../lib/response.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import {
  ORDER_VALID_STATUSES, RIDE_VALID_STATUSES, PARCEL_VALID_STATUSES, PHARMACY_ORDER_VALID_STATUSES,
  getSocketRoom,
} from "@workspace/service-constants";
import { getIO } from "../../lib/socketio.js";

const router = Router();

router.post("/orders", requirePermission("orders.manage"), async (req, res) => {
  const { userId, vendorId, type, items, total, deliveryAddress, paymentMethod, status } = req.body;
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    sendValidationError(res, "userId is required");
    return;
  }
  const numTotal = Number(total);
  if (!numTotal || numTotal <= 0) {
    sendValidationError(res, "total must be a positive number");
    return;
  }
  const validTypes = ["mart", "food"];
  const orderType = validTypes.includes(type) ? type : "mart";
  const validPayments = ["cod", "wallet", "jazzcash", "easypaisa"];
  const payment = validPayments.includes(paymentMethod) ? paymentMethod : "cod";
  const validStatuses = ["pending", "confirmed", "preparing", "picked_up", "delivered", "cancelled"];
  const orderStatus = validStatuses.includes(status) ? status : "pending";
  try {
    const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId.trim()));
    if (!user) {
      sendValidationError(res, "User not found with the given userId");
      return;
    }
    const [order] = await db.insert(ordersTable).values({
      id: generateId(),
      userId: userId.trim(),
      vendorId: (vendorId || userId).trim(),
      type: orderType,
      items: items ? (typeof items === "string" ? items : JSON.stringify(items)) : JSON.stringify([{ name: "Custom item", qty: 1, price: numTotal.toString() }]),
      total: numTotal.toString(),
      deliveryAddress: (deliveryAddress || "Admin-created order").trim(),
      paymentMethod: payment,
      status: orderStatus,
      paymentStatus: "pending",
      estimatedTime: "30-45 min",
    }).returning();
    sendSuccess(res, { order });
  } catch (e: any) {
    sendError(res, e.message, 500);
  }
});

router.get("/orders", async (req, res) => {
  const { status, type, limit: lim } = req.query;
  const settings = await getCachedSettings();
  const isDemoMode = (settings["platform_mode"] ?? "demo") === "demo";

  if (isDemoMode) {
    const { getDemoSnapshot } = await import("../../lib/demo-snapshot.js");
    const snap = await getDemoSnapshot();
    const filtered = snap.orders
      .filter(o => !status || o.status === status)
      .filter(o => !type   || o.type   === type);
    sendSuccess(res, { orders: filtered, total: filtered.length, isDemo: true });
    return;
  }

  const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(Number(lim) || 200);

  const filtered = orders
    .filter(o => !status || o.status === status)
    .filter(o => !type || o.type === type);

  sendSuccess(res, {
    orders: filtered.map(o => ({
      ...o,
      total: parseFloat(String(o.total)),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    total: filtered.length,
    isDemo: false,
  });
});

router.patch("/orders/:id/status", requirePermission("orders.manage"), async (req, res) => {
  const { status } = req.body;
  const orderId = req.params["id"]!;

  if (!status || !(ORDER_VALID_STATUSES as readonly string[]).includes(status)) {
    sendValidationError(res, `Invalid order status "${status}". Valid statuses: ${ORDER_VALID_STATUSES.join(", ")}`);
    return;
  }

  /* For wallet-paid → cancelled: do status update + wallet refund in ONE transaction */
  const [preOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!preOrder) { sendNotFound(res, "Order not found"); return; }

  const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["preparing", "cancelled"],
    preparing: ["ready", "out_for_delivery", "picked_up", "cancelled"],
    ready: ["picked_up", "out_for_delivery", "delivered", "cancelled"],
    picked_up: ["out_for_delivery", "delivered", "cancelled"],
    out_for_delivery: ["delivered", "cancelled"],
    delivered: [],
    cancelled: [],
    completed: [],
  };

  const allowed = ALLOWED_TRANSITIONS[preOrder.status] || [];
  if (!allowed.includes(status)) {
    sendValidationError(res, `Cannot transition from "${preOrder.status}" to "${status}". Allowed next statuses: ${allowed.length ? allowed.join(", ") : "none (terminal state)"}`);
    return;
  }

  let order = preOrder;

  if (status === "cancelled" && preOrder.paymentMethod === "wallet" && !preOrder.refundedAt) {
    const refundAmt = parseFloat(String(preOrder.total));
    const now = new Date();
    /* Atomic: status update + wallet credit + refund stamp in one transaction.
       Guard: WHERE refunded_at IS NULL prevents double-credit under concurrency.
       If the conditional update returns 0 rows, we throw to roll back the transaction. */
    const txResult = await db.transaction(async (tx) => {
      const result = await tx.update(ordersTable)
        .set({ status, refundedAt: now, refundedAmount: refundAmt.toFixed(2), paymentStatus: "refunded", updatedAt: now })
        .where(and(eq(ordersTable.id, orderId), isNull(ordersTable.refundedAt)))
        .returning();
      if (result.length === 0) {
        /* Already refunded (concurrent request won) — throw to roll back entire tx */
        throw new Error("ALREADY_REFUNDED");
      }
      await tx.update(usersTable)
        .set({ walletBalance: sql`wallet_balance + ${refundAmt}`, updatedAt: now })
        .where(eq(usersTable.id, preOrder.userId));
      await tx.insert(walletTransactionsTable).values({
        id: generateId(), userId: preOrder.userId, type: "credit",
        amount: refundAmt.toFixed(2),
        description: `Refund — Order #${orderId.slice(-6).toUpperCase()} cancelled by admin`,
      });
      return result[0];
    }).catch((err: Error) => {
      if (err.message === "ALREADY_REFUNDED") return null;
      throw err;
    });
    if (!txResult) { sendError(res, "Order has already been refunded", 409); return; }
    order = txResult;
    /* Refund + cancellation consolidated into ONE notification after successful commit
       (avoids sending two separate push notifications for the same event) */
    await sendUserNotification(
      preOrder.userId,
      "Order Cancelled & Refunded 💰",
      `Order #${orderId.slice(-6).toUpperCase()} cancel ho gaya. Rs. ${refundAmt.toFixed(0)} aapki wallet mein wapas aa gaya.`,
      "mart",
      "wallet-outline",
    );
    /* Skip the generic "cancelled" status notification below */
    const io = getIO();
    if (io) {
      const payload = { id: orderId, status: "cancelled", updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt };
      io.to(getSocketRoom(orderId, order.type ?? "mart")).emit("order:update", payload);
      io.to(`user:${preOrder.userId}`).emit("order:update", payload);
    }
    addAuditEntry({
      action: "order_status_cancelled_refunded",
      adminId: (req as AdminRequest).adminId,
      ip: getClientIp(req),
      details: `Order #${orderId.slice(-6).toUpperCase()} cancelled + wallet refund Rs.${parseFloat(String(preOrder.total)).toFixed(0)} issued`,
      result: "success",
    });
    sendSuccess(res, order);
    return;
  } else {
    const [updated] = await db.update(ordersTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(ordersTable.id, orderId), ne(ordersTable.status, status)))
      .returning();
    if (!updated) { sendError(res, "Order status has already been updated", 409); return; }
    order = updated;
  }

  const notifKeys = ORDER_NOTIF_KEYS[status];
  if (notifKeys) {
    const orderUserLang = await getUserLanguage(order.userId);
    await sendUserNotification(order.userId, t(notifKeys.titleKey, orderUserLang), t(notifKeys.bodyKey, orderUserLang), "mart", notifKeys.icon);
  }

  // NOTE: Wallet is already debited when order is PLACED (orders.ts).
  // Do NOT deduct again here. Only credit the rider's share on delivery.

  if (status === "delivered") {
    const total = parseFloat(String(order.total));
    const riderKeepPct = (Number((await getPlatformSettings())["rider_keep_pct"]) || 80) / 100;
    const riderEarning = parseFloat((total * riderKeepPct).toFixed(2));
    if (order.riderId) {
      await db.transaction(async (tx) => {
        await tx.update(usersTable)
          .set({ walletBalance: sql`wallet_balance + ${riderEarning}`, updatedAt: new Date() })
          .where(eq(usersTable.id, order.riderId!));
        await tx.insert(walletTransactionsTable).values({
          id: generateId(), userId: order.riderId!, type: "credit",
          amount: String(riderEarning),
          description: `Delivery earnings — Order #${order.id.slice(-6).toUpperCase()} (${Math.round(riderKeepPct * 100)}%)`,
        });
      });
    }
  }

  const io = getIO();
  if (io) {
    const payload = { id: orderId, status: order.status, updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt };
    io.to(getSocketRoom(orderId, order.type ?? "mart")).emit("order:update", payload);
    io.to(`user:${order.userId}`).emit("order:update", payload);
  }

  /* Audit: record terminal status transitions for compliance trail */
  if (["delivered", "cancelled"].includes(status)) {
    addAuditEntry({
      action: `order_status_${status}`,
      adminId: (req as AdminRequest).adminId,
      ip: getClientIp(req),
      details: `Order #${orderId.slice(-6).toUpperCase()} marked ${status}`,
      result: "success",
    });
  }

  sendSuccess(res, { ...order, total: parseFloat(String(order.total)) });
});

router.post("/orders/:id/refund", requirePermission("orders.manage"), async (req, res) => {
  const { amount, reason } = req.body;
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, req.params["id"]!)).limit(1);
  if (!order) { sendNotFound(res, "Order not found"); return; }

  /* Only allow refunds for terminal orders */
  if (order.status !== "delivered" && order.status !== "cancelled") {
    sendValidationError(res, "Refund only allowed for delivered or cancelled orders"); return;
  }

  /* Only wallet-paid orders can be wallet-refunded */
  if (order.paymentMethod !== "wallet") {
    sendValidationError(res, "Refund only applies to wallet-paid orders"); return;
  }

  /* Fast-path: pre-check before entering transaction */
  if (order.refundedAt) {
    sendErrorWithData(res, "Order has already been refunded", {
      refundedAt: order.refundedAt,
      refundedAmount: order.refundedAmount ? parseFloat(String(order.refundedAmount)) : null,
    }, 409);
    return;
  }

  /* Validate refund amount — reject invalid/negative instead of silently defaulting */
  const maxRefund = parseFloat(String(order.total));
  const parsedAmount = amount !== undefined && amount !== null && amount !== ""
    ? parseFloat(String(amount))
    : NaN;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    sendValidationError(res, "amount must be a positive number"); return;
  }
  if (parsedAmount > maxRefund) {
    sendValidationError(res, `Refund amount (${parsedAmount}) cannot exceed order total (${maxRefund})`); return;
  }
  const refundAmt = parsedAmount;

  const now = new Date();
  let alreadyRefunded = false;

  await db.transaction(async (tx) => {
    /* Atomic idempotency: only stamp refunded_at if it is still NULL.
       The WHERE clause with IS NULL means only one concurrent request will get rowCount > 0. */
    const updated = await tx.update(ordersTable)
      .set({ refundedAt: now, refundedAmount: refundAmt.toFixed(2), paymentStatus: "refunded", updatedAt: now })
      .where(and(eq(ordersTable.id, order.id), isNull(ordersTable.refundedAt)))
      .returning({ id: ordersTable.id });

    if (updated.length === 0) {
      /* Another concurrent request beat us to the refund — abort */
      alreadyRefunded = true;
      return;
    }

    /* Credit customer wallet only if we successfully stamped the order */
    await tx.update(usersTable)
      .set({ walletBalance: sql`wallet_balance + ${refundAmt}`, updatedAt: now })
      .where(eq(usersTable.id, order.userId));

    await tx.insert(walletTransactionsTable).values({
      id: generateId(),
      userId: order.userId,
      type: "credit",
      amount: refundAmt.toFixed(2),
      description: `Admin refund — Order #${order.id.slice(-6).toUpperCase()}${reason ? `. ${reason}` : ""}`,
    });
  });

  if (alreadyRefunded) {
    sendError(res, "Order has already been refunded", 409); return;
  }

  await sendUserNotification(
    order.userId,
    "Order Refund 💰",
    `Rs. ${refundAmt.toFixed(0)} aapki wallet mein refund ho gaya — Order #${order.id.slice(-6).toUpperCase()}`,
    "mart",
    "wallet-outline"
  );

  addAuditEntry({
    action: "order_refunded",
    adminId: (req as AdminRequest).adminId,
    ip: getClientIp(req),
    details: `Order #${order.id.slice(-6).toUpperCase()} admin refund Rs.${refundAmt.toFixed(0)}${reason ? ` — ${reason}` : ""}`,
    result: "success",
  });

  sendSuccess(res, { success: true, refundedAmount: refundAmt, orderId: order.id });
});
router.get("/pharmacy-orders", async (_req, res) => {
  const orders = await db
    .select()
    .from(pharmacyOrdersTable)
    .orderBy(desc(pharmacyOrdersTable.createdAt))
    .limit(200);
  sendSuccess(res, {
    orders: orders.map(o => ({
      ...o,
      total: parseFloat(o.total),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    total: orders.length,
  });
});

router.patch("/pharmacy-orders/:id/status", requirePermission("orders.manage"), async (req, res) => {
  const { status } = req.body;
  if (!status || !(PHARMACY_ORDER_VALID_STATUSES as readonly string[]).includes(status)) {
    sendValidationError(res, `Invalid pharmacy order status "${status}". Valid statuses: ${PHARMACY_ORDER_VALID_STATUSES.join(", ")}`);
    return;
  }
  const [order] = await db
    .update(pharmacyOrdersTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(pharmacyOrdersTable.id, req.params["id"]!))
    .returning();
  if (!order) { sendNotFound(res, "Not found"); return; }

  const pharmNotifKeys = PHARMACY_NOTIF_KEYS[status];
  if (pharmNotifKeys) {
    const pharmUserLang = await getUserLanguage(order.userId);
    await sendUserNotification(order.userId, t(pharmNotifKeys.titleKey, pharmUserLang), t(pharmNotifKeys.bodyKey, pharmUserLang), "pharmacy", pharmNotifKeys.icon);
  }

  // Wallet refund on cancellation (atomic)
  if (status === "cancelled" && order.paymentMethod === "wallet") {
    const refundAmt = parseFloat(order.total);
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({ walletBalance: sql`wallet_balance + ${refundAmt}`, updatedAt: new Date() }).where(eq(usersTable.id, order.userId));
      await tx.insert(walletTransactionsTable).values({ id: generateId(), userId: order.userId, type: "credit", amount: refundAmt.toFixed(2), description: `Refund — Pharmacy Order #${order.id.slice(-6).toUpperCase()} cancelled` });
    }).catch(() => {});
    const pharmRefundLang = await getUserLanguage(order.userId);
    await sendUserNotification(order.userId, t("notifPharmacyRefund", pharmRefundLang), t("notifPharmacyRefundBody", pharmRefundLang).replace("{amount}", refundAmt.toFixed(0)), "pharmacy", "wallet-outline");
  }

  const ioPharm = getIO();
  if (ioPharm) {
    const pharmPayload = { id: order.id, status: order.status, updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt };
    ioPharm.to(getSocketRoom(order.id, "pharmacy")).emit("order:update", pharmPayload);
    ioPharm.to(`user:${order.userId}`).emit("order:update", pharmPayload);
  }

  if (["delivered", "cancelled"].includes(status)) {
    addAuditEntry({
      action: `pharmacy_order_${status}`,
      adminId: (req as AdminRequest).adminId,
      ip: getClientIp(req),
      details: `Pharmacy Order #${order.id.slice(-6).toUpperCase()} marked ${status}`,
      result: "success",
    });
  }

  sendSuccess(res, { ...order, total: parseFloat(order.total) });
});

/* ── Parcel Bookings ── */
router.get("/parcel-bookings", async (_req, res) => {
  const bookings = await db
    .select()
    .from(parcelBookingsTable)
    .orderBy(desc(parcelBookingsTable.createdAt))
    .limit(200);
  sendSuccess(res, {
    bookings: bookings.map(b => ({
      ...b,
      fare: parseFloat(b.fare),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    })),
    total: bookings.length,
  });
});

router.patch("/parcel-bookings/:id/status", requirePermission("orders.manage"), async (req, res) => {
  const { status } = req.body;
  if (!status || !(PARCEL_VALID_STATUSES as readonly string[]).includes(status)) {
    sendValidationError(res, `Invalid parcel status "${status}". Valid statuses: ${PARCEL_VALID_STATUSES.join(", ")}`);
    return;
  }
  const [booking] = await db
    .update(parcelBookingsTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(parcelBookingsTable.id, req.params["id"]!))
    .returning();
  if (!booking) { sendNotFound(res, "Not found"); return; }

  const parcelNotifKeys = PARCEL_NOTIF_KEYS[status];
  if (parcelNotifKeys) {
    const parcelUserLang = await getUserLanguage(booking.userId);
    await sendUserNotification(booking.userId, t(parcelNotifKeys.titleKey, parcelUserLang), t(parcelNotifKeys.bodyKey, parcelUserLang), "parcel", parcelNotifKeys.icon);
  }

  // Wallet refund on cancellation (atomic)
  if (status === "cancelled" && booking.paymentMethod === "wallet") {
    const refundAmt = parseFloat(booking.fare);
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({ walletBalance: sql`wallet_balance + ${refundAmt}`, updatedAt: new Date() }).where(eq(usersTable.id, booking.userId));
      await tx.insert(walletTransactionsTable).values({ id: generateId(), userId: booking.userId, type: "credit", amount: refundAmt.toFixed(2), description: `Refund — Parcel Booking #${booking.id.slice(-6).toUpperCase()} cancelled` });
    }).catch(() => {});
    const parcelRefundLang = await getUserLanguage(booking.userId);
    await sendUserNotification(booking.userId, t("notifParcelRefund", parcelRefundLang), t("notifParcelRefundBody", parcelRefundLang).replace("{amount}", refundAmt.toFixed(0)), "parcel", "wallet-outline");
  }

  const ioParcel = getIO();
  if (ioParcel) {
    const parcelPayload = { id: booking.id, status: booking.status, updatedAt: booking.updatedAt instanceof Date ? booking.updatedAt.toISOString() : booking.updatedAt };
    ioParcel.to(getSocketRoom(booking.id, "parcel")).emit("order:update", parcelPayload);
    ioParcel.to(`user:${booking.userId}`).emit("order:update", parcelPayload);
  }

  if (["completed", "cancelled"].includes(status)) {
    addAuditEntry({
      action: `parcel_booking_${status}`,
      adminId: (req as AdminRequest).adminId,
      ip: getClientIp(req),
      details: `Parcel Booking #${booking.id.slice(-6).toUpperCase()} marked ${status}`,
      result: "success",
    });
  }

  sendSuccess(res, { ...booking, fare: parseFloat(booking.fare) });
});
router.get("/pharmacy-enriched", async (_req, res) => {
  const orders = await db.select().from(pharmacyOrdersTable).orderBy(desc(pharmacyOrdersTable.createdAt)).limit(200);
  const users = await db.select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone }).from(usersTable);
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  sendSuccess(res, {
    orders: orders.map(o => ({
      ...o,
      total: parseFloat(String(o.total)),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      userName: userMap[o.userId]?.name || null,
      userPhone: userMap[o.userId]?.phone || null,
    })),
    total: orders.length,
  });
});

/* ── Parcel Bookings Enriched ── */
router.get("/parcel-enriched", async (_req, res) => {
  const bookings = await db.select().from(parcelBookingsTable).orderBy(desc(parcelBookingsTable.createdAt)).limit(200);
  const users = await db.select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone }).from(usersTable);
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  sendSuccess(res, {
    bookings: bookings.map(b => ({
      ...b,
      fare: parseFloat(b.fare),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
      userName: userMap[b.userId]?.name || null,
      userPhone: userMap[b.userId]?.phone || null,
    })),
    total: bookings.length,
  });
});

/* ── Delete User ── */
const ACTIVE_STATUSES = ["pending", "confirmed", "preparing", "ready", "picked_up", "out_for_delivery"];

function buildOrderFilters(query: Record<string, string | undefined>) {
  const { status, type, search, dateFrom, dateTo } = query;
  const conditions: any[] = [];

  if (status && status !== "all") {
    if (status === "active") {
      conditions.push(or(...ACTIVE_STATUSES.map(s => eq(ordersTable.status, s))));
    } else {
      conditions.push(eq(ordersTable.status, status));
    }
  }
  if (type && type !== "all") {
    conditions.push(eq(ordersTable.type, type));
  }
  if (dateFrom) {
    conditions.push(gte(ordersTable.createdAt, new Date(dateFrom + "T00:00:00.000Z")));
  }
  if (dateTo) {
    conditions.push(lte(ordersTable.createdAt, new Date(dateTo + "T23:59:59.999Z")));
  }
  if (search) {
    conditions.push(
      or(
        ilike(ordersTable.id, `%${search}%`),
        ilike(usersTable.name, `%${search}%`),
        ilike(usersTable.phone, `%${search}%`),
      )
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function getOrderByClause(sortBy?: string, sortDir?: string) {
  const direction = sortDir === "asc" ? asc : desc;
  switch (sortBy) {
    case "id": return direction(ordersTable.id);
    case "customer": return direction(usersTable.name);
    case "type": return direction(ordersTable.type);
    case "total": return direction(ordersTable.total);
    case "status": return direction(ordersTable.status);
    case "date":
    default: return direction(ordersTable.createdAt);
  }
}

router.get("/orders-stats", async (_req, res) => {
  const [statuses, [revRow]] = await Promise.all([
    db
      .select({ status: ordersTable.status, cnt: count() })
      .from(ordersTable)
      .groupBy(ordersTable.status),
    db
      .select({ rev: sum(ordersTable.total) })
      .from(ordersTable)
      .where(eq(ordersTable.status, "delivered")),
  ]);

  const statusMap: Record<string, number> = {};
  let total = 0;
  for (const s of statuses) {
    const n = Number(s.cnt);
    statusMap[s.status] = n;
    total += n;
  }

  sendSuccess(res, {
    total,
    pending: statusMap["pending"] ?? 0,
    confirmed: statusMap["confirmed"] ?? 0,
    preparing: statusMap["preparing"] ?? 0,
    ready: statusMap["ready"] ?? 0,
    picked_up: statusMap["picked_up"] ?? 0,
    out_for_delivery: statusMap["out_for_delivery"] ?? 0,
    delivered: statusMap["delivered"] ?? 0,
    cancelled: statusMap["cancelled"] ?? 0,
    active: ACTIVE_STATUSES.reduce((s, k) => s + (statusMap[k] ?? 0), 0),
    totalRevenue: parseFloat(String(revRow?.rev ?? "0")),
  });
});

router.get("/orders-enriched", async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const { page: pageStr, limit: limitStr, sortBy, sortDir: sortDirStr } = query;

  const whereClause = buildOrderFilters(query);
  const pageNum = Math.max(1, parseInt(pageStr || "1", 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limitStr || "200", 10) || 200));
  const orderByClause = getOrderByClause(sortBy, sortDirStr);

  const baseQuery = db
    .select({
      order: ordersTable,
      userName: usersTable.name,
      userPhone: usersTable.phone,
    })
    .from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.userId, usersTable.id));

  const countQuery = db
    .select({ cnt: count() })
    .from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.userId, usersTable.id));

  if (whereClause) {
    baseQuery.where(whereClause);
    countQuery.where(whereClause);
  }

  const [rows, [{ cnt: totalCount }]] = await Promise.all([
    baseQuery
      .orderBy(orderByClause)
      .limit(limitNum)
      .offset((pageNum - 1) * limitNum),
    countQuery,
  ]);

  sendSuccess(res, {
    orders: rows.map(r => ({
      ...r.order,
      total: parseFloat(String(r.order.total)),
      createdAt: r.order.createdAt.toISOString(),
      updatedAt: r.order.updatedAt.toISOString(),
      userName: r.userName || null,
      userPhone: r.userPhone || null,
    })),
    total: totalCount,
    page: pageNum,
    limit: limitNum,
  });
});

router.get("/orders-export", async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const { sortBy, sortDir: sortDirStr } = query;

  const whereClause = buildOrderFilters(query);
  const orderByClause = getOrderByClause(sortBy, sortDirStr);

  const baseQuery = db
    .select({
      order: ordersTable,
      userName: usersTable.name,
      userPhone: usersTable.phone,
    })
    .from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.userId, usersTable.id));

  if (whereClause) baseQuery.where(whereClause);

  const rows = await baseQuery.orderBy(orderByClause).limit(5000);

  sendSuccess(res, {
    orders: rows.map(r => ({
      ...r.order,
      total: parseFloat(String(r.order.total)),
      createdAt: r.order.createdAt.toISOString(),
      updatedAt: r.order.updatedAt.toISOString(),
      userName: r.userName || null,
      userPhone: r.userPhone || null,
    })),
    total: rows.length,
  });
});



/* ── User Security Management ── */
router.patch("/orders/:id/assign-rider", requirePermission("orders.manage"), async (req, res) => {
  const { riderId } = req.body as { riderId?: string };
  let riderName: string | null = null;
  let riderPhone: string | null = null;
  if (riderId) {
    const [rider] = await db.select({ name: usersTable.name, phone: usersTable.phone }).from(usersTable).where(eq(usersTable.id, riderId));
    riderName = rider?.name ?? null;
    riderPhone = rider?.phone ?? null;
  }
  const [order] = await db.update(ordersTable)
    .set({ riderId: riderId || null, riderName, riderPhone, updatedAt: new Date() })
    .where(eq(ordersTable.id, req.params["id"]!))
    .returning();
  if (!order) { sendNotFound(res, "Order not found"); return; }
  addAuditEntry({ action: "order_rider_assigned", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Rider ${riderName ?? riderId ?? "unassigned"} assigned to order ${req.params["id"]}`, result: "success" });
  sendSuccess(res, { success: true, order: { ...order, total: parseFloat(String(order.total)), riderName, riderPhone } });
});

/* ── PATCH /admin/vendors/:id/commission — set per-vendor commission override ── */

export default router;
