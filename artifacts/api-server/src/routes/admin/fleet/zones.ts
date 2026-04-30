import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { serviceZonesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendValidationError } from "../../../lib/response.js";
import { requirePermission } from "../../../middlewares/require-permission.js";
import { FLEET_PERMS } from "../../../middlewares/permissions-map.js";
import { invalidateZoneCache } from "../../../lib/geofence.js";
import { getCachedSettings } from "../../../middleware/security.js";
import type { AdminRequest } from "../../admin-shared.js";
import { AuditService } from "../../../services/admin-audit.service.js";
import { FleetService } from "../../../services/admin-fleet.service.js";
import { getClientIp } from "../../admin-shared.js";

const router: IRouter = Router();

/* ── GET /admin/service-zones — list all zones ── */
router.get("/", async (_req, res) => {
  const zones = await db
    .select()
    .from(serviceZonesTable)
    .orderBy(serviceZonesTable.city, serviceZonesTable.name);
  sendSuccess(res, zones);
});

/* ── POST /admin/service-zones — create a zone ── */
router.post("/", requirePermission(FLEET_PERMS.manage), async (req, res) => {
  const {
    name, city, lat, lng, radiusKm,
    isActive, appliesToRides, appliesToOrders, appliesToParcel, notes,
  } = req.body as Record<string, unknown>;

  if (!name || !city || lat == null || lng == null) {
    sendValidationError(res, "name, city, lat, lng are required"); return;
  }

  const latNum = parseFloat(String(lat));
  const lngNum = parseFloat(String(lng));
  if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    sendValidationError(res, "Invalid lat/lng values"); return;
  }

  const s = await getCachedSettings();
  const defaultRadius = parseFloat(s["geo_default_zone_radius_km"] ?? "30");
  const radiusNum = radiusKm != null ? parseFloat(String(radiusKm)) : (Number.isFinite(defaultRadius) ? defaultRadius : 30);
  if (isNaN(radiusNum) || radiusNum <= 0 || radiusNum > 5000) {
    sendValidationError(res, "radius_km must be between 0 and 5000"); return;
  }

  const [zone] = await db.insert(serviceZonesTable).values({
    name:             String(name),
    city:             String(city),
    lat:              latNum.toFixed(6),
    lng:              lngNum.toFixed(6),
    radiusKm:         radiusNum.toFixed(2),
    isActive:         isActive !== false,
    appliesToRides:   appliesToRides !== false,
    appliesToOrders:  appliesToOrders !== false,
    appliesToParcel:  appliesToParcel !== false,
    notes:            notes ? String(notes) : null,
  }).returning();

  invalidateZoneCache();
  sendCreated(res, zone);
});

/* ── PUT /admin/service-zones/:id — update a zone ── */
router.put("/:id", requirePermission(FLEET_PERMS.manage), async (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  if (isNaN(id)) { sendValidationError(res, "Invalid zone id"); return; }

  const {
    name, city, lat, lng, radiusKm,
    isActive, appliesToRides, appliesToOrders, appliesToParcel, notes,
  } = req.body as Record<string, unknown>;

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (name    != null) patch.name    = String(name);
  if (city    != null) patch.city    = String(city);
  if (isActive != null) patch.isActive = isActive === true || isActive === "true";
  if (appliesToRides   != null) patch.appliesToRides   = appliesToRides === true   || appliesToRides === "true";
  if (appliesToOrders  != null) patch.appliesToOrders  = appliesToOrders === true  || appliesToOrders === "true";
  if (appliesToParcel  != null) patch.appliesToParcel  = appliesToParcel === true  || appliesToParcel === "true";
  if (notes   != null) patch.notes   = String(notes) || null;

  if (lat != null) {
    const latNum = parseFloat(String(lat));
    if (isNaN(latNum) || latNum < -90 || latNum > 90) { sendValidationError(res, "Invalid lat"); return; }
    patch.lat = latNum.toFixed(6);
  }
  if (lng != null) {
    const lngNum = parseFloat(String(lng));
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) { sendValidationError(res, "Invalid lng"); return; }
    patch.lng = lngNum.toFixed(6);
  }
  if (radiusKm != null) {
    const r = parseFloat(String(radiusKm));
    if (isNaN(r) || r <= 0 || r > 5000) { sendValidationError(res, "radius_km must be 1–5000"); return; }
    patch.radiusKm = r.toFixed(2);
  }

  const [updated] = await db
    .update(serviceZonesTable)
    .set(patch as Parameters<typeof db.update>[0] extends { set: infer S } ? S : never)
    .where(eq(serviceZonesTable.id, id))
    .returning();

  if (!updated) { sendNotFound(res, "Service zone not found"); return; }

  invalidateZoneCache();
  sendSuccess(res, updated);
});

/* ── DELETE /admin/service-zones/:id ── */
router.delete("/:id", requirePermission(FLEET_PERMS.manage), async (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  if (isNaN(id)) { sendValidationError(res, "Invalid zone id"); return; }

  const [deleted] = await db
    .delete(serviceZonesTable)
    .where(eq(serviceZonesTable.id, id))
    .returning({ id: serviceZonesTable.id });

  if (!deleted) { sendNotFound(res, "Service zone not found"); return; }

  invalidateZoneCache();
  sendSuccess(res, { deleted: true, id });
});

export default router;
