import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletTransactionsTable } from "@workspace/db/schema";
import { eq, and, ilike, or, sql, desc } from "drizzle-orm";
import { generateId } from "../../lib/id.js";
import {
  addAuditEntry, getClientIp, type AdminRequest,
  sendUserNotification,
} from "../admin-shared.js";
import { sendSuccess, sendError, sendNotFound, sendValidationError } from "../../lib/response.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { FINANCE_PERMS } from "../../middlewares/permissions-map.js";

const router = Router();

type LoyaltyRow = { amount: string; type: string; reference: string | null };

function computeLoyalty(rows: LoyaltyRow[]) {
  let totalEarned = 0;
  let totalRedeemed = 0;
  for (const r of rows) {
    const amt = parseFloat(r.amount ?? "0");
    if (r.reference === "admin_loyalty_debit") {
      totalRedeemed += amt;
    } else if (r.type === "loyalty") {
      totalEarned += amt;
    } else if (r.type === "credit" && r.reference?.startsWith("loyalty_redeem_")) {
      totalRedeemed += amt;
    }
  }
  const available = Math.max(0, Math.floor(totalEarned) - Math.floor(totalRedeemed));
  return { totalEarned: Math.floor(totalEarned), totalRedeemed: Math.floor(totalRedeemed), available };
}

router.get("/loyalty/users", async (req, res) => {
  const q = ((req.query?.q as string) ?? "").trim();

  const conditions: ReturnType<typeof eq>[] = [
    ilike(usersTable.roles, "%customer%") as ReturnType<typeof eq>,
  ];
  if (q) {
    conditions.push(or(
      ilike(usersTable.name, `%${q}%`),
      ilike(usersTable.phone, `%${q}%`),
      ilike(usersTable.email, `%${q}%`),
    )! as ReturnType<typeof eq>);
  }

  const users = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      phone: usersTable.phone,
      email: usersTable.email,
      avatar: usersTable.avatar,
      walletBalance: usersTable.walletBalance,
      isActive: usersTable.isActive,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(and(...conditions))
    .orderBy(desc(usersTable.createdAt));

  const loyaltyTxns = await db
    .select({
      userId: walletTransactionsTable.userId,
      type: walletTransactionsTable.type,
      amount: walletTransactionsTable.amount,
      reference: walletTransactionsTable.reference,
    })
    .from(walletTransactionsTable)
    .where(
      or(
        eq(walletTransactionsTable.type, "loyalty"),
        sql`${walletTransactionsTable.type} = 'credit' AND ${walletTransactionsTable.reference} LIKE 'loyalty_redeem_%'`,
      )!,
    );

  const perUserTxns = new Map<string, LoyaltyRow[]>();
  for (const txn of loyaltyTxns) {
    if (!perUserTxns.has(txn.userId)) perUserTxns.set(txn.userId, []);
    perUserTxns.get(txn.userId)!.push(txn);
  }

  const enrichedUsers = users.map(u => {
    const loyalty = computeLoyalty(perUserTxns.get(u.id) || []);
    return {
      ...u,
      walletBalance: parseFloat(u.walletBalance ?? "0"),
      createdAt: u.createdAt.toISOString(),
      loyaltyPoints: loyalty,
    };
  });

  sendSuccess(res, { users: enrichedUsers, total: enrichedUsers.length });
});

router.post("/loyalty/users/:id/adjust", requirePermission(FINANCE_PERMS.manage), async (req, res) => {
  const userId = req.params["id"]!;
  const { amount, reason, type } = req.body as { amount?: number; reason?: string; type?: string };

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0 || !Number.isInteger(Number(amount))) {
    sendValidationError(res, "A positive whole number amount is required");
    return;
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    sendValidationError(res, "A reason is required for loyalty point adjustments");
    return;
  }
  if (type !== "credit" && type !== "debit") {
    sendValidationError(res, "Type must be 'credit' or 'debit'");
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    sendNotFound(res, "User not found");
    return;
  }

  const adjustAmount = Number(amount);

  if (type === "debit") {
    const inserted = await db.transaction(async (tx) => {
      const allRows = await tx
        .select({ amount: walletTransactionsTable.amount, type: walletTransactionsTable.type, reference: walletTransactionsTable.reference })
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.userId, userId));

      const loyaltyRows = allRows.filter(r =>
        r.type === "loyalty" ||
        (r.type === "credit" && r.reference?.startsWith("loyalty_redeem_"))
      );
      const { available } = computeLoyalty(loyaltyRows);

      if (adjustAmount > available) {
        return { error: `Cannot debit ${adjustAmount} points. User only has ${available} loyalty points available.` };
      }

      await tx.insert(walletTransactionsTable).values({
        id: generateId(),
        userId,
        type: "loyalty",
        amount: adjustAmount.toFixed(2),
        description: `Admin loyalty debit: ${reason.trim()}`,
        reference: "admin_loyalty_debit",
      });
      return { error: null };
    });

    if (inserted.error) {
      sendError(res, inserted.error, 400);
      return;
    }
  } else {
    await db.insert(walletTransactionsTable).values({
      id: generateId(),
      userId,
      type: "loyalty",
      amount: adjustAmount.toFixed(2),
      description: `Admin loyalty credit: ${reason.trim()}`,
      reference: "admin_loyalty_credit",
    });
  }

  const ip = getClientIp(req);
  addAuditEntry({
    action: `loyalty_${type}`,
    ip: ip || "admin",
    details: `Admin ${type === "credit" ? "credited" : "debited"} ${adjustAmount} loyalty points for user ${user.phone || user.name || userId} — Reason: ${reason.trim()}`,
    result: "success",
  });

  await sendUserNotification(
    userId,
    type === "credit" ? "Loyalty Points Added!" : "Loyalty Points Adjusted",
    type === "credit"
      ? `${adjustAmount} loyalty points have been added to your account.`
      : `${adjustAmount} loyalty points have been deducted from your account.`,
    "system",
    "star-outline",
  );

  const updatedRows = await db
    .select({ amount: walletTransactionsTable.amount, type: walletTransactionsTable.type, reference: walletTransactionsTable.reference })
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.userId, userId));

  const updatedLoyalty = computeLoyalty(updatedRows.filter(r =>
    r.type === "loyalty" ||
    (r.type === "credit" && r.reference?.startsWith("loyalty_redeem_"))
  ));

  sendSuccess(res, {
    success: true,
    loyaltyPoints: updatedLoyalty,
  });
});

export default router;
