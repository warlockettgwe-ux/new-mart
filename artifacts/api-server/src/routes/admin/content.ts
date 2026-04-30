import { Router } from "express";
import path from "path";
import fs from "fs";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  ordersTable, productsTable, flashDealsTable, promoCodesTable, categoriesTable, bannersTable,
  stockSubscriptionsTable,
} from "@workspace/db/schema";
import { eq, desc, count, sum, and, gte, lte, sql, or, ilike, asc, isNull, isNotNull, avg, ne } from "drizzle-orm";
import { sendPushToUsers } from "../../lib/webpush.js";
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
  type AdminRequest, type TranslationKey,
} from "../admin-shared.js";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendValidationError } from "../../lib/response.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { CONTENT_PERMS } from "../../middlewares/permissions-map.js";

const router = Router();
router.get("/products", async (_req, res) => {
  const settings = await getCachedSettings();
  const isDemoMode = (settings["platform_mode"] ?? "demo") === "demo";

  if (isDemoMode) {
    const { getDemoSnapshot } = await import("../../lib/demo-snapshot.js");
    const snap = await getDemoSnapshot();
    sendSuccess(res, { products: snap.products, total: snap.products.length, isDemo: true });
    return;
  }

  const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
  sendSuccess(res, {
    products: products.map(p => ({
      ...p,
      price: parseFloat(p.price),
      originalPrice: p.originalPrice ? parseFloat(p.originalPrice) : null,
      rating: p.rating ? parseFloat(p.rating) : null,
      createdAt: p.createdAt.toISOString(),
    })),
    total: products.length,
    isDemo: false,
  });
});

router.get("/products/pending", async (_req, res) => {
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.approvalStatus, "pending"))
    .orderBy(desc(productsTable.createdAt));
  sendSuccess(res, {
    products: products.map(p => ({
      ...p,
      price: parseFloat(p.price),
      originalPrice: p.originalPrice ? parseFloat(p.originalPrice) : null,
      rating: p.rating ? parseFloat(p.rating) : null,
      createdAt: p.createdAt.toISOString(),
    })),
    total: products.length,
  });
});

router.patch("/products/:id/approve", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { note } = req.body;
  /* Fetch previous state before approve to detect back-in-stock transition */
  const [prevProduct] = await db.select().from(productsTable).where(eq(productsTable.id, req.params["id"]!)).limit(1);
  const [product] = await db
    .update(productsTable)
    .set({ approvalStatus: "approved", inStock: true, updatedAt: new Date() })
    .where(eq(productsTable.id, req.params["id"]!))
    .returning();
  if (!product) { sendNotFound(res, "Product not found"); return; }
  if (product.vendorId && product.vendorId !== "ajkmart_system") {
    const [vendor] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, product.vendorId)).limit(1);
    if (vendor) {
      const vLang = await getUserLanguage(vendor.id);
      const vBody = note
        ? t("notifProductApprovedBodyNote", vLang).replace("{name}", product.name).replace("{note}", note)
        : t("notifProductApprovedBody", vLang).replace("{name}", product.name);
      await db.insert(notificationsTable).values({
        id: generateId(),
        userId: vendor.id,
        title: t("notifProductApproved", vLang),
        body: vBody,
        type: "system",
        icon: "checkmark-circle-outline",
      }).catch(() => {});
    }
  }
  /* Back-in-stock: notify subscribers when previously out-of-stock product is approved */
  if (prevProduct && (!prevProduct.inStock || (prevProduct.stock !== null && prevProduct.stock <= 0))) {
    try {
      const subs = await db.select({ userId: stockSubscriptionsTable.userId })
        .from(stockSubscriptionsTable)
        .where(eq(stockSubscriptionsTable.productId, product.id));
      if (subs.length > 0) {
        const userIds = subs.map(s => s.userId);
        await sendPushToUsers(userIds, {
          title: "Back in Stock!",
          body: `${product.name} is now available. Order before it sells out!`,
          data: { productId: product.id },
        });
        await db.delete(stockSubscriptionsTable).where(eq(stockSubscriptionsTable.productId, product.id));
      }
    } catch (e) { logger.warn({ err: e }, "[back-in-stock] approve notify failed"); }
  }
  sendSuccess(res, { ...product, price: parseFloat(product.price) });
});

router.patch("/products/:id/reject", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { reason } = req.body;
  if (!reason) { sendValidationError(res, "reason is required"); return; }
  const [product] = await db
    .update(productsTable)
    .set({ approvalStatus: "rejected", inStock: false, updatedAt: new Date() })
    .where(eq(productsTable.id, req.params["id"]!))
    .returning();
  if (!product) { sendNotFound(res, "Product not found"); return; }
  if (product.vendorId && product.vendorId !== "ajkmart_system") {
    const [vendor] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, product.vendorId)).limit(1);
    if (vendor) {
      const vLang = await getUserLanguage(vendor.id);
      await db.insert(notificationsTable).values({
        id: generateId(),
        userId: vendor.id,
        title: t("notifProductRejected", vLang),
        body: t("notifProductRejectedBody", vLang).replace("{name}", product.name).replace("{reason}", reason),
        type: "system",
        icon: "close-circle-outline",
      }).catch(() => {});
    }
  }
  sendSuccess(res, { ...product, price: parseFloat(product.price) });
});

const SYSTEM_VENDOR_ID = "ajkmart_system";

async function ensureSystemVendor(): Promise<void> {
  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, SYSTEM_VENDOR_ID));
  if (existing.length === 0) {
    await db.insert(usersTable).values({
      id: SYSTEM_VENDOR_ID,
      phone: "+920000000000",
      name: "AJKMart System",
      roles: "vendor",
      city: "Muzaffarabad",
      area: "System",
      phoneVerified: true,
      approvalStatus: "approved",
      isActive: true,
      walletBalance: "0",
    });
  }
}

router.post("/products", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { name, description, price, originalPrice, category, type, unit, vendorName, inStock, deliveryTime, image } = req.body;
  if (!name || !price || !category) {
    sendValidationError(res, "name, price, and category are required");
    return;
  }
  await ensureSystemVendor();
  const [product] = await db.insert(productsTable).values({
    id: generateId(),
    name,
    description: description || null,
    price: String(price),
    originalPrice: originalPrice ? String(originalPrice) : null,
    category,
    type: type || "mart",
    vendorId: SYSTEM_VENDOR_ID,
    vendorName: vendorName || "AJKMart Store",
    unit: unit || null,
    inStock: inStock !== false,
    deliveryTime: deliveryTime || "30-45 min",
    rating: "4.5",
    reviewCount: 0,
    image: image || null,
  }).returning();
  sendCreated(res, { ...product!, price: parseFloat(product!.price) });
});

router.patch("/products/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { name, description, price, originalPrice, category, unit, inStock, stock, vendorName, deliveryTime, image } = req.body;
  const updates: Partial<typeof productsTable.$inferInsert> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) updates.price = String(price);
  if (originalPrice !== undefined) updates.originalPrice = originalPrice ? String(originalPrice) : null;
  if (category !== undefined) updates.category = category;
  if (unit !== undefined) updates.unit = unit;
  if (inStock !== undefined) updates.inStock = inStock;
  if (stock !== undefined) updates.stock = stock;
  if (vendorName !== undefined) updates.vendorName = vendorName;
  if (deliveryTime !== undefined) updates.deliveryTime = deliveryTime;
  if (image !== undefined) updates.image = image;

  /* Fetch previous state to detect back-in-stock transition */
  const [prevProduct] = await db.select().from(productsTable).where(eq(productsTable.id, req.params["id"]!)).limit(1);

  const [product] = await db
    .update(productsTable)
    .set(updates)
    .where(eq(productsTable.id, req.params["id"]!))
    .returning();
  if (!product) { sendNotFound(res, "Product not found"); return; }

  /* Back-in-stock: notify subscribers when product becomes available again */
  if (prevProduct) {
    const wasOutOfStock = !prevProduct.inStock || (prevProduct.stock !== null && prevProduct.stock <= 0);
    const isNowAvailable = product.inStock || (product.stock !== null && product.stock > 0);
    if (wasOutOfStock && isNowAvailable) {
      try {
        const subs = await db.select({ userId: stockSubscriptionsTable.userId })
          .from(stockSubscriptionsTable)
          .where(eq(stockSubscriptionsTable.productId, product.id));
        if (subs.length > 0) {
          const userIds = subs.map(s => s.userId);
          await sendPushToUsers(userIds, {
            title: "Back in Stock!",
            body: `${product.name} is now available. Order before it sells out!`,
            data: { productId: product.id },
          });
          await db.delete(stockSubscriptionsTable).where(eq(stockSubscriptionsTable.productId, product.id));
        }
      } catch (e) { logger.warn({ err: e }, "[back-in-stock] admin notify failed"); }
    }
  }

  sendSuccess(res, { ...product, price: parseFloat(product.price) });
});

router.delete("/products/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  await db.delete(productsTable).where(eq(productsTable.id, req.params["id"]!));
  sendSuccess(res, { success: true });
});

/* ── Broadcast Notification ──
 * Audience filtering uses CSV-aware role matching against `users.roles`
 * (a comma-separated list, e.g. "customer,rider,van_driver").
 * Previous LIKE '%role%' could falsely match substrings (e.g. "rider" inside
 * a future role name) and was the root cause of cross-audience leaks.
 * We now match an exact CSV element via Postgres regex with word-boundary
 * anchors and tolerate optional surrounding whitespace.
 */
const VALID_BROADCAST_ROLES = ["customer", "rider", "vendor", "admin"] as const;
type BroadcastRole = typeof VALID_BROADCAST_ROLES[number];

function parseTargetRoles(input: unknown): { roles: BroadcastRole[]; error: string | null } {
  if (input === undefined || input === null || input === "all") return { roles: [], error: null };
  const list = Array.isArray(input) ? input : [input];
  const cleaned: BroadcastRole[] = [];
  for (const r of list) {
    if (typeof r !== "string") return { roles: [], error: "targetRole entries must be strings" };
    const norm = r.trim().toLowerCase();
    if (!norm) continue;
    if (!VALID_BROADCAST_ROLES.includes(norm as BroadcastRole)) {
      return { roles: [], error: `Invalid targetRole "${r}". Must be one of: ${VALID_BROADCAST_ROLES.join(", ")}` };
    }
    if (!cleaned.includes(norm as BroadcastRole)) cleaned.push(norm as BroadcastRole);
  }
  return { roles: cleaned, error: null };
}

function buildRoleConditions(roles: BroadcastRole[]) {
  const conditions = [eq(usersTable.isActive, true)];
  if (roles.length > 0) {
    /* Matches an exact CSV element with optional whitespace around it.
       e.g. "rider" matches "rider", "customer,rider", "rider , vendor"
       but NOT a hypothetical "super_rider" or "ridernew". */
    const roleClauses = roles.map(r =>
      sql`${usersTable.roles} ~ ${`(^|,)\\s*${r}\\s*(,|$)`}`
    );
    conditions.push(roleClauses.length === 1 ? roleClauses[0]! : or(...roleClauses)!);
  }
  return conditions;
}

/* GET /broadcast/recipients/count?targetRole=rider
 * Also accepts repeated targetRole params or a comma list, e.g. ?targetRole=rider,vendor
 * Returns { count, targetRoles } so the admin UI can preview the audience size
 * BEFORE sending the broadcast. */
router.get("/broadcast/recipients/count", async (req, res) => {
  const raw = req.query["targetRole"];
  let parsed: unknown = raw;
  if (typeof raw === "string" && raw.includes(",")) {
    parsed = raw.split(",").map(s => s.trim()).filter(Boolean);
  }
  const { roles, error } = parseTargetRoles(parsed);
  if (error) { sendValidationError(res, error); return; }

  const conditions = buildRoleConditions(roles);
  const [row] = await db.select({ c: count() }).from(usersTable).where(and(...conditions));
  sendSuccess(res, {
    count: row?.c ?? 0,
    targetRoles: roles.length > 0 ? roles : ["all"],
  });
});

router.post("/broadcast", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { title, body, titleKey, bodyKey, type = "system", icon = "notifications-outline", targetRole } = req.body;
  if (!title && !titleKey) { sendValidationError(res, "title or titleKey required"); return; }
  if (!body && !bodyKey) { sendValidationError(res, "body or bodyKey required"); return; }

  const { roles, error } = parseTargetRoles(targetRole);
  if (error) { sendValidationError(res, error); return; }

  const conditions = buildRoleConditions(roles);
  const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(...conditions));
  let sent = 0;
  for (const user of users) {
    let localTitle = title as string;
    let localBody = body as string;
    if (titleKey || bodyKey) {
      const lang = await getUserLanguage(user.id);
      if (titleKey) localTitle = t(titleKey as TranslationKey, lang);
      if (bodyKey) localBody = t(bodyKey as TranslationKey, lang);
    }
    await db.insert(notificationsTable).values({
      id: generateId(),
      userId: user.id,
      title: localTitle,
      body: localBody,
      type,
      icon,
    }).catch(() => {});
    sent++;
  }
  sendSuccess(res, { success: true, sent, targetRoles: roles.length > 0 ? roles : ["all"] });
});

/* ── Wallet Transactions ── */
router.get("/categories/tree", async (req, res) => {
  const type = req.query["type"] as string;
  const conditions = [];
  if (type) conditions.push(eq(categoriesTable.type, type));

  const allCats = await db
    .select()
    .from(categoriesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(categoriesTable.sortOrder));

  const topLevel = allCats.filter(c => !c.parentId);
  const childrenMap = new Map<string, typeof allCats>();
  for (const c of allCats) {
    if (c.parentId) {
      const arr = childrenMap.get(c.parentId) || [];
      arr.push(c);
      childrenMap.set(c.parentId, arr);
    }
  }

  const tree = topLevel.map(c => ({
    ...c,
    children: (childrenMap.get(c.id) || []),
  }));

  sendSuccess(res, { categories: tree });
});

router.post("/categories", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { name, icon, type, parentId, sortOrder, isActive } = req.body;
  if (!name || !type) {
    sendValidationError(res, "name and type are required");
    return;
  }

  const id = generateId();
  const [category] = await db.insert(categoriesTable).values({
    id,
    name,
    icon: icon || "grid-outline",
    type,
    parentId: parentId || null,
    sortOrder: sortOrder ?? 0,
    isActive: isActive !== false,
  }).returning();

  sendCreated(res, category);
});

router.patch("/categories/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { name, icon, type, parentId, sortOrder, isActive } = req.body;

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (icon !== undefined) updates.icon = icon;
  if (type !== undefined) updates.type = type;
  if (parentId !== undefined) updates.parentId = parentId || null;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (isActive !== undefined) updates.isActive = isActive;

  const [updated] = await db
    .update(categoriesTable)
    .set(updates)
    .where(eq(categoriesTable.id, req.params["id"]!))
    .returning();

  if (!updated) {
    sendNotFound(res, "Category not found");
    return;
  }

  sendSuccess(res, updated);
});

router.delete("/categories/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const id = req.params["id"]!;

  await db
    .update(categoriesTable)
    .set({ parentId: null })
    .where(eq(categoriesTable.parentId, id));

  const [deleted] = await db
    .delete(categoriesTable)
    .where(eq(categoriesTable.id, id))
    .returning();

  if (!deleted) {
    sendNotFound(res, "Category not found");
    return;
  }

  sendSuccess(res, { success: true });
});

router.post("/categories/reorder", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    sendValidationError(res, "items array required");
    return;
  }

  for (const item of items) {
    if (item.id && typeof item.sortOrder === "number") {
      await db
        .update(categoriesTable)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(eq(categoriesTable.id, item.id));
    }
  }

  sendSuccess(res, { success: true });
});

/* ── Banners ── */
router.get("/banners", async (req, res) => {
  const placement = req.query["placement"] as string | undefined;
  const status = req.query["status"] as string | undefined;

  const banners = await db
    .select()
    .from(bannersTable)
    .orderBy(asc(bannersTable.sortOrder), desc(bannersTable.createdAt));
  const now = new Date();
  let mapped = banners.map(b => ({
    ...b,
    startDate: b.startDate ? b.startDate.toISOString() : null,
    endDate: b.endDate ? b.endDate.toISOString() : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    status: (!b.isActive ? "inactive"
          : b.startDate && now < b.startDate ? "scheduled"
          : b.endDate && now > b.endDate ? "expired"
          : "active") as "active" | "scheduled" | "expired" | "inactive",
  }));
  if (placement) mapped = mapped.filter(b => b.placement === placement);
  if (status) mapped = mapped.filter(b => b.status === status);
  sendSuccess(res, { banners: mapped, total: mapped.length });
});

router.post("/banners", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.title) {
    sendValidationError(res, "title is required"); return;
  }
  const [banner] = await db.insert(bannersTable).values({
    id: generateId(),
    title: body.title as string,
    subtitle: (body.subtitle as string) || null,
    imageUrl: (body.imageUrl as string) || null,
    linkType: (body.linkType as string) || "none",
    linkValue: (body.linkValue as string) || null,
    targetService: (body.targetService as string) || null,
    placement: (body.placement as string) || "home",
    colorFrom: (body.colorFrom as string) || "#7C3AED",
    colorTo: (body.colorTo as string) || "#4F46E5",
    icon: (body.icon as string) || null,
    sortOrder: (body.sortOrder as number) ?? 0,
    isActive: body.isActive !== false,
    startDate: body.startDate ? new Date(body.startDate as string) : null,
    endDate: body.endDate ? new Date(body.endDate as string) : null,
  }).returning();
  sendCreated(res, banner);
});

router.patch("/banners/reorder", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const { items } = req.body as { items: { id: string; sortOrder: number }[] };
  if (!Array.isArray(items)) {
    sendValidationError(res, "items array required"); return;
  }
  for (const item of items) {
    await db.update(bannersTable).set({ sortOrder: item.sortOrder, updatedAt: new Date() }).where(eq(bannersTable.id, item.id));
  }
  sendSuccess(res, { success: true });
});

const bannerUpdateHandler = async (req: import("express").Request, res: import("express").Response) => {
  const bannerId = req.params["id"]!;
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fields = ["title", "subtitle", "imageUrl", "linkType", "linkValue", "targetService", "placement", "colorFrom", "colorTo", "icon", "sortOrder", "isActive"];
  for (const f of fields) {
    if (body[f] !== undefined) updates[f] = body[f];
  }
  if (body.startDate !== undefined) updates.startDate = body.startDate ? new Date(body.startDate as string) : null;
  if (body.endDate !== undefined) updates.endDate = body.endDate ? new Date(body.endDate as string) : null;

  const [updated] = await db.update(bannersTable).set(updates).where(eq(bannersTable.id, bannerId)).returning();
  if (!updated) {
    sendNotFound(res, "Banner not found"); return;
  }
  sendSuccess(res, updated);
};
router.patch("/banners/:id", requirePermission(CONTENT_PERMS.manage), bannerUpdateHandler);
router.put("/banners/:id", requirePermission(CONTENT_PERMS.manage), bannerUpdateHandler);

router.delete("/banners/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const bannerId = req.params["id"]!;
  const [deleted] = await db.delete(bannersTable).where(eq(bannersTable.id, bannerId)).returning();
  if (!deleted) {
    sendNotFound(res, "Banner not found"); return;
  }
  sendSuccess(res, { success: true, id: bannerId });
});

/* ── Flash Deals ── */
router.get("/flash-deals", async (_req, res) => {
  const deals = await db.select().from(flashDealsTable).orderBy(desc(flashDealsTable.createdAt));
  const products = await db.select({ id: productsTable.id, name: productsTable.name, price: productsTable.price, image: productsTable.image, category: productsTable.category }).from(productsTable);
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));
  const now = new Date();
  sendSuccess(res, {
    deals: deals.map(d => ({
      ...d,
      discountPct:  d.discountPct  ? parseFloat(String(d.discountPct))  : null,
      discountFlat: d.discountFlat ? parseFloat(String(d.discountFlat)) : null,
      startTime: d.startTime.toISOString(),
      endTime:   d.endTime.toISOString(),
      createdAt: d.createdAt.toISOString(),
      product:   productMap[d.productId] ?? null,
      status: !d.isActive ? "inactive"
            : now < d.startTime ? "scheduled"
            : now > d.endTime   ? "expired"
            : d.dealStock !== null && d.soldCount >= d.dealStock ? "sold_out"
            : "live",
    })),
  });
});

router.post("/flash-deals", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.productId || !body.startTime || !body.endTime) {
    sendValidationError(res, "productId, startTime, endTime required"); return;
  }
  const [deal] = await db.insert(flashDealsTable).values({
    id:           generateId(),
    productId:    body.productId as string,
    title:        (body.title as string)    || null,
    badge:        (body.badge as string)    || "FLASH",
    discountPct:  body.discountPct  ? String(body.discountPct)  : null,
    discountFlat: body.discountFlat ? String(body.discountFlat) : null,
    startTime:    new Date(body.startTime as string),
    endTime:      new Date(body.endTime as string),
    dealStock:    body.dealStock  ? Number(body.dealStock)  : null,
    isActive:     body.isActive !== false,
  }).returning();
  sendCreated(res, deal);
});

router.patch("/flash-deals/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, any> = {};
  if (body.title        !== undefined) updates.title        = body.title;
  if (body.badge        !== undefined) updates.badge        = body.badge;
  if (body.discountPct  !== undefined) updates.discountPct  = body.discountPct  ? String(body.discountPct)  : null;
  if (body.discountFlat !== undefined) updates.discountFlat = body.discountFlat ? String(body.discountFlat) : null;
  if (body.startTime    !== undefined) updates.startTime    = new Date(body.startTime as string);
  if (body.endTime      !== undefined) updates.endTime      = new Date(body.endTime as string);
  if (body.dealStock    !== undefined) updates.dealStock    = body.dealStock ? Number(body.dealStock) : null;
  if (body.isActive     !== undefined) updates.isActive     = body.isActive;
  const [deal] = await db.update(flashDealsTable).set(updates).where(eq(flashDealsTable.id, req.params["id"]!)).returning();
  if (!deal) { sendNotFound(res, "Deal not found"); return; }
  sendSuccess(res, deal);
});

router.delete("/flash-deals/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  await db.delete(flashDealsTable).where(eq(flashDealsTable.id, req.params["id"]!));
  sendSuccess(res, { success: true });
});

/* ── Promo Codes ── */
router.get("/promo-codes", async (_req, res) => {
  const codes = await db.select().from(promoCodesTable).orderBy(desc(promoCodesTable.createdAt));
  const now = new Date();
  sendSuccess(res, {
    codes: codes.map(c => ({
      ...c,
      discountPct:    c.discountPct    ? parseFloat(String(c.discountPct))    : null,
      discountFlat:   c.discountFlat   ? parseFloat(String(c.discountFlat))   : null,
      minOrderAmount: c.minOrderAmount ? parseFloat(String(c.minOrderAmount)) : 0,
      maxDiscount:    c.maxDiscount    ? parseFloat(String(c.maxDiscount))    : null,
      expiresAt:  c.expiresAt  ? c.expiresAt.toISOString()  : null,
      createdAt:  c.createdAt.toISOString(),
      status: !c.isActive ? "inactive"
            : c.expiresAt && now > c.expiresAt ? "expired"
            : c.usageLimit !== null && c.usedCount >= c.usageLimit ? "exhausted"
            : "active",
    })),
  });
});

router.post("/promo-codes", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.code) { sendValidationError(res, "code required"); return; }
  try {
    const [code] = await db.insert(promoCodesTable).values({
      id:             generateId(),
      code:           String(body.code).toUpperCase().trim(),
      description:    body.description    ? String(body.description)    : null,
      discountPct:    body.discountPct    ? String(body.discountPct)    : null,
      discountFlat:   body.discountFlat   ? String(body.discountFlat)   : null,
      minOrderAmount: body.minOrderAmount ? String(body.minOrderAmount) : "0",
      maxDiscount:    body.maxDiscount    ? String(body.maxDiscount)    : null,
      usageLimit:     body.usageLimit     ? Number(body.usageLimit)     : null,
      appliesTo:      body.appliesTo      ? String(body.appliesTo)      : "all",
      expiresAt:      body.expiresAt      ? new Date(body.expiresAt as string) : null,
      isActive:       body.isActive !== false,
    }).returning();
    sendCreated(res, code);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "23505") { sendError(res, "Promo code already exists", 409); return; }
    throw e;
  }
});

router.patch("/promo-codes/:id", requirePermission(CONTENT_PERMS.manage), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, any> = {};
  if (body.code           !== undefined) updates.code           = String(body.code).toUpperCase().trim();
  if (body.description    !== undefined) updates.description    = body.description;
  if (body.discountPct    !== undefined) updates.discountPct    = body.discountPct    ? String(body.discountPct)    : null;
  if (body.discountFlat   !== undefined) updates.discountFlat   = body.discountFlat   ? String(body.discountFlat)   : null;
  if (body.minOrderAmount !== undefined) updates.minOrderAmount = String(body.minOrderAmount);
  if (body.maxDiscount    !== undefined) updates.maxDiscount    = body.maxDiscount    ? String(body.maxDiscount)    : null;
  if (body.usageLimit     !== undefined) updates.usageLimit     = body.usageLimit     ? Number(body.usageLimit)     : null;
  if (body.appliesTo      !== undefined) updates.appliesTo      = body.appliesTo;
  if (body.expiresAt      !== undefined) updates.expiresAt      = body.expiresAt      ? new Date(body.expiresAt as string)    : null;
  if (body.isActive       !== undefined) updates.isActive       = body.isActive;
  const [code] = await db.update(promoCodesTable).set(updates).where(eq(promoCodesTable.id, req.params["id"]!)).returning();
  if (!code) { sendNotFound(res, "Promo code not found"); return; }
  sendSuccess(res, code);
});

router.delete("/promo-codes/:id", async (req, res) => {
  await db.delete(promoCodesTable).where(eq(promoCodesTable.id, req.params["id"]!));
  sendSuccess(res, { success: true });
});

/* ══════════════════════════════════════
   VENDOR MANAGEMENT
══════════════════════════════════════ */

/* ── POST /uploads/admin — base64 image upload for admin panel ── */
router.post("/uploads/admin", async (req, res) => {
  try {
    const { base64, mimeType } = req.body as { base64?: string; mimeType?: string };
    if (!base64 || !mimeType) { sendError(res, "base64 and mimeType are required", 400); return; }
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(mimeType)) { sendError(res, "Only JPEG, PNG, and WebP images are allowed", 400); return; }
    const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > 10 * 1024 * 1024) { sendError(res, "Image must be under 10MB", 400); return; }
    const uniqueName = `admin_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const uploadsDir = path.resolve(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, uniqueName), buffer);
    const url = `/api/uploads/${uniqueName}`;
    sendSuccess(res, { url });
  } catch (e: any) {
    sendError(res, e.message || "Upload failed", 500);
  }
});

export default router;
