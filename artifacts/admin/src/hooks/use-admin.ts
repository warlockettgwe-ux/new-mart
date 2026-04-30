import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetcher } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const REFETCH_INTERVAL = 30_000;
const RIDES_REFETCH_INTERVAL = 5_000;

// Auth
export const useAdminLogin = () => {
  return useMutation({
    mutationFn: (creds: { username: string; password: string }) =>
      fetcher("/auth", {
        method: "POST",
        body: JSON.stringify({
          username: creds.username,
          password: creds.password,
          /* legacy field kept so older API builds still work */
          secret: creds.password,
        }),
      }),
  });
};

// Dashboard Stats
export const useStats = () => {
  return useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => fetcher("/stats"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

// Users
export const useUsers = (conditionTier?: string) => {
  const params = conditionTier ? `?conditionTier=${conditionTier}` : "";
  return useQuery({
    queryKey: ["admin-users", conditionTier || ""],
    queryFn: () => fetcher(`/users${params}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useSearchRiders = (q: string, onlineOnly = true) => {
  return useQuery({
    queryKey: ["admin-search-riders", q, onlineOnly],
    queryFn: () => fetcher(`/users/search-riders?q=${encodeURIComponent(q)}&limit=20&onlineOnly=${onlineOnly}`),
    enabled: true,
    staleTime: 10_000,
  });
};

export const usePendingUsers = () => {
  return useQuery({
    queryKey: ["admin-users-pending"],
    queryFn: () => fetcher("/users/pending"),
    refetchInterval: 15_000,
  });
};

export const useApproveUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      fetcher(`/users/${id}/approve`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-pending"] });
    },
  });
};

export const useRejectUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      fetcher(`/users/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-pending"] });
    },
  });
};

export const useUpdateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; role?: string; isActive?: boolean; walletBalance?: string | number }) =>
      fetcher(`/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-transactions"] });
    },
  });
};

export const useWalletTopup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description }: { id: string; amount: number; description?: string }) =>
      fetcher(`/users/${id}/wallet-topup`, {
        method: "POST",
        body: JSON.stringify({ amount, description }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Orders
export const useOrders = () => {
  return useQuery({
    queryKey: ["admin-orders"],
    queryFn: () => fetcher("/orders"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useUpdateOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      fetcher(`/orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["admin-orders-enriched"] });
      const previousQueries: { queryKey: unknown[]; data: unknown }[] = [];
      queryClient.getQueriesData({ queryKey: ["admin-orders-enriched"] }).forEach(([key, data]) => {
        previousQueries.push({ queryKey: key as unknown[], data });
      });
      queryClient.setQueriesData(
        { queryKey: ["admin-orders-enriched"], exact: false },
        (old: any) => {
          if (!old?.orders) return old;
          return {
            ...old,
            orders: old.orders.map((o: any) =>
              o.id === variables.id ? { ...o, status: variables.status, updatedAt: new Date().toISOString() } : o
            ),
          };
        },
      );
      return { previousQueries };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousQueries) {
        for (const { queryKey, data } of context.previousQueries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders-enriched"] });
      queryClient.invalidateQueries({ queryKey: ["admin-orders-stats"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Rides
export const useRides = () => {
  return useQuery({
    queryKey: ["admin-rides"],
    queryFn: () => fetcher("/rides"),
    refetchInterval: RIDES_REFETCH_INTERVAL,
  });
};

export const useUpdateRide = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, status, riderName, riderPhone }: { id: string; status: string; riderName?: string; riderPhone?: string }) =>
      fetcher(`/rides/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, riderName, riderPhone }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-rides"] });
      queryClient.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      toast({ title: "Failed to update ride", description: error.message, variant: "destructive" });
      if (import.meta.env.DEV) console.error("[admin] update ride status failed:", error.message);
    },
  });
};

// Pharmacy Orders
export const usePharmacyOrders = () => {
  return useQuery({
    queryKey: ["admin-pharmacy"],
    queryFn: () => fetcher("/pharmacy-enriched"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useUpdatePharmacyOrder = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      fetcher(`/pharmacy-orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-pharmacy"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Parcel Bookings
export const useParcelBookings = () => {
  return useQuery({
    queryKey: ["admin-parcel"],
    queryFn: () => fetcher("/parcel-enriched"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useUpdateParcelBooking = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      fetcher(`/parcel-bookings/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-parcel"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

export interface CreateUserInput {
  name?: string;
  phone?: string;
  email?: string;
  username?: string;
  tempPassword?: string;
  role?: "customer" | "rider" | "vendor";
  city?: string;
  area?: string;
}

// Create User
export const useCreateUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUserInput) =>
      fetcher("/users", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Delete User
export const useDeleteUser = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// User Activity
export const useUserActivity = (userId: string | null) => {
  return useQuery({
    queryKey: ["admin-user-activity", userId],
    queryFn: () => fetcher(`/users/${userId}/activity`),
    enabled: !!userId,
  });
};

// Products
export const useCategories = () => {
  return useQuery({
    queryKey: ["categories"],
    queryFn: async () => {
      const apiBase = window.location.origin;
      const res = await fetch(`${apiBase}/api/categories`);
      if (!res.ok) throw new Error("Failed to fetch categories");
      const json = await res.json();
      const payload = json.data ?? json;
      const list: any[] = Array.isArray(payload) ? payload : (payload.categories ?? []);
      return list.map((c: any) => ({
        id: String(c.id),
        name: String(c.name),
        icon: c.icon ?? undefined,
      })) as { id: string; name: string; icon?: string }[];
    },
    staleTime: 5 * 60 * 1000,
  });
};

export const useProducts = () => {
  return useQuery({
    queryKey: ["admin-products"],
    queryFn: () => fetcher("/products"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useCreateProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetcher("/products", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-products"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

export const useUpdateProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) =>
      fetcher(`/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-products"] }),
  });
};

export const useDeleteProduct = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher(`/products/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-products"] });
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

export const usePendingProducts = () => {
  return useQuery({
    queryKey: ["admin-products-pending"],
    queryFn: () => fetcher("/products/pending"),
    refetchInterval: 30_000,
  });
};

export const useApproveProduct = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      fetcher(`/products/${id}/approve`, { method: "PATCH", body: JSON.stringify({ note }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-products-pending"] });
      qc.invalidateQueries({ queryKey: ["admin-products"] });
    },
  });
};

export const useRejectProduct = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      fetcher(`/products/${id}/reject`, { method: "PATCH", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-products-pending"] });
      qc.invalidateQueries({ queryKey: ["admin-products"] });
    },
  });
};

export const useOrderRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, reason }: { id: string; amount?: number; reason?: string }) =>
      fetcher(`/orders/${id}/refund`, { method: "POST", body: JSON.stringify({ amount, reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-orders-enriched"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Broadcast
export const useBroadcast = () => {
  return useMutation({
    mutationFn: (data: any) =>
      fetcher("/broadcast", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
};

/**
 * Estimated recipient count for a broadcast.
 * Pass `targetRole = "all"` (or empty string) to count every active user.
 * Pass an array of roles to count the union of users who hold any of them.
 */
export const useBroadcastRecipientCount = (
  targetRole: string | string[] | undefined,
) => {
  const roles = Array.isArray(targetRole)
    ? targetRole.filter(Boolean)
    : targetRole && targetRole !== "all"
      ? [targetRole]
      : [];
  const queryParam = roles.length > 0 ? `?targetRole=${encodeURIComponent(roles.join(","))}` : "";
  return useQuery({
    queryKey: ["admin-broadcast-recipient-count", roles.join(",") || "all"],
    queryFn: () =>
      fetcher(`/broadcast/recipients/count${queryParam}`) as Promise<{
        count: number;
        targetRoles: string[];
      }>,
    refetchInterval: REFETCH_INTERVAL,
    staleTime: 10_000,
  });
};

// Transactions (enriched with user names)
export const useTransactions = () => {
  return useQuery({
    queryKey: ["admin-transactions"],
    queryFn: () => fetcher("/transactions-enriched"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

// Enriched endpoints (orders + user info)
export interface OrdersEnrichedFilters {
  status?: string;
  type?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: string;
}

function buildOrderParams(filters?: OrdersEnrichedFilters): string {
  if (!filters) return "";
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.type && filters.type !== "all") params.set("type", filters.type);
  if (filters.search) params.set("search", filters.search);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.sortBy) params.set("sortBy", filters.sortBy);
  if (filters.sortDir) params.set("sortDir", filters.sortDir);
  return params.toString();
}

export const useOrdersEnriched = (filters?: OrdersEnrichedFilters) => {
  const qs = buildOrderParams(filters);
  const url = qs ? `/orders-enriched?${qs}` : "/orders-enriched";

  return useQuery({
    queryKey: ["admin-orders-enriched", filters?.status, filters?.type, filters?.search, filters?.dateFrom, filters?.dateTo, filters?.page, filters?.limit, filters?.sortBy, filters?.sortDir],
    queryFn: () => fetcher(url),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useOrdersStats = () => {
  return useQuery({
    queryKey: ["admin-orders-stats"],
    queryFn: () => fetcher("/orders-stats"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const fetchOrdersExport = async (filters?: OrdersEnrichedFilters): Promise<any> => {
  const qs = buildOrderParams(filters);
  const url = qs ? `/orders-export?${qs}` : "/orders-export";
  return fetcher(url);
};

export const useRidesEnriched = (params?: {
  page?: number; limit?: number; status?: string; type?: string;
  search?: string; customer?: string; rider?: string;
  dateFrom?: string; dateTo?: string;
  sortBy?: string; sortDir?: string;
}) => {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.status && params.status !== "all") qs.set("status", params.status);
  if (params?.type && params.type !== "all") qs.set("type", params.type);
  if (params?.search) qs.set("search", params.search);
  if (params?.customer) qs.set("customer", params.customer);
  if (params?.rider) qs.set("rider", params.rider);
  if (params?.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params?.dateTo) qs.set("dateTo", params.dateTo);
  if (params?.sortBy) qs.set("sortBy", params.sortBy);
  if (params?.sortDir) qs.set("sortDir", params.sortDir);
  const query = qs.toString();
  return useQuery({
    queryKey: ["admin-rides-enriched", params?.page ?? 1, params?.limit ?? 50, params?.status ?? "all", params?.type ?? "all", params?.search ?? "", params?.customer ?? "", params?.rider ?? "", params?.dateFrom ?? "", params?.dateTo ?? "", params?.sortBy ?? "date", params?.sortDir ?? "desc"],
    queryFn: () => fetcher(query ? `/rides-enriched?${query}` : "/rides-enriched"),
    refetchInterval: RIDES_REFETCH_INTERVAL,
  });
};

// Platform Settings
export const usePlatformSettings = () => {
  return useQuery({
    queryKey: ["admin-platform-settings"],
    queryFn: () => fetcher("/platform-settings"),
  });
};

export const useUpdatePlatformSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Array<{ key: string; value: string }>) =>
      fetcher("/platform-settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-platform-settings"] }),
  });
};

/* ── Vendors ── */
export const useVendors = () =>
  useQuery({ queryKey: ["admin-vendors"], queryFn: () => fetcher("/vendors"), refetchInterval: REFETCH_INTERVAL });

export const useFleetVendors = () =>
  useQuery({ queryKey: ["admin-fleet-vendors"], queryFn: () => fetcher("/fleet/vendors"), refetchInterval: 60_000 });

export const useUpdateVendorStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => fetcher(`/vendors/${id}/status`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-vendors"] }),
  });
};

export const useVendorPayout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description }: { id: string; amount: number; description?: string }) =>
      fetcher(`/vendors/${id}/payout`, { method: "POST", body: JSON.stringify({ amount, description }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-vendors"] }); qc.invalidateQueries({ queryKey: ["admin-transactions"] }); },
  });
};

export const useVendorCredit = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description }: { id: string; amount: number; description?: string }) =>
      fetcher(`/vendors/${id}/credit`, { method: "POST", body: JSON.stringify({ amount, description }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-vendors"] }); qc.invalidateQueries({ queryKey: ["admin-transactions"] }); },
  });
};

/* ── Riders ── */
export const useRiders = () =>
  /* staleTime: 0 ensures the wallet balance and rider state shown in modals
     are always fresh immediately after any mutation invalidates this query. */
  useQuery({ queryKey: ["admin-riders"], queryFn: () => fetcher("/riders"), refetchInterval: REFETCH_INTERVAL, staleTime: 0 });

export const useUpdateRiderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => fetcher(`/riders/${id}/status`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-riders"] }),
  });
};

export const useRiderPayout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description }: { id: string; amount: number; description?: string }) =>
      fetcher(`/riders/${id}/payout`, { method: "POST", body: JSON.stringify({ amount, description }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-riders"] }); qc.invalidateQueries({ queryKey: ["admin-transactions"] }); },
  });
};

export const useRiderBonus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description }: { id: string; amount: number; description?: string }) =>
      fetcher(`/riders/${id}/bonus`, { method: "POST", body: JSON.stringify({ amount, description }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-riders"] }); qc.invalidateQueries({ queryKey: ["admin-transactions"] }); },
  });
};

export const useRiderPenalties = (riderId: string | null) =>
  useQuery({
    queryKey: ["admin-rider-penalties", riderId],
    queryFn: () => fetcher(`/riders/${riderId}/penalties`),
    enabled: !!riderId,
  });

export const useRiderRatings = (riderId: string | null) =>
  useQuery({
    queryKey: ["admin-rider-ratings", riderId],
    queryFn: () => fetcher(`/riders/${riderId}/ratings`),
    enabled: !!riderId,
  });

export const useRestrictRider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/riders/${id}/restrict`, { method: "POST", body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-riders"] }),
  });
};

export const useUnrestrictRider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/riders/${id}/unrestrict`, { method: "POST", body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-riders"] }),
  });
};

/* ── Promo Codes ── */
export const usePromoCodes = () =>
  useQuery({ queryKey: ["admin-promo-codes"], queryFn: () => fetcher("/promo-codes"), refetchInterval: REFETCH_INTERVAL });

export const useCreatePromoCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetcher("/promo-codes", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-promo-codes"] }),
  });
};

export const useUpdatePromoCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => fetcher(`/promo-codes/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-promo-codes"] }),
  });
};

export const useDeletePromoCode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/promo-codes/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-promo-codes"] }),
  });
};

// Deposit Requests
export const useDepositRequests = (status?: string) => {
  return useQuery({
    queryKey: ["admin-deposits", status],
    queryFn: () => fetcher(`/deposit-requests${status ? `?status=${status}` : ""}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useApproveDeposit = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, refNo, note }: { id: string; refNo?: string; note?: string }) =>
      fetcher(`/deposit-requests/${id}/approve`, { method: "PATCH", body: JSON.stringify({ refNo, note }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-deposits"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

export const useRejectDeposit = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      fetcher(`/deposit-requests/${id}/reject`, { method: "PATCH", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-deposits"] });
    },
  });
};

export const useBulkApproveDeposits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, refNo }: { ids: string[]; refNo?: string }) =>
      fetcher("/deposit-requests/bulk-approve", { method: "POST", body: JSON.stringify({ ids, refNo }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-deposits"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

export const useBulkRejectDeposits = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, reason }: { ids: string[]; reason: string }) =>
      fetcher("/deposit-requests/bulk-reject", { method: "POST", body: JSON.stringify({ ids, reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-deposits"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });
};

// Withdrawal Requests
export const useWithdrawalRequests = (status?: string) => {
  return useQuery({
    queryKey: ["admin-withdrawals", status],
    queryFn: () => fetcher(`/withdrawal-requests${status ? `?status=${status}` : ""}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useApproveWithdrawal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, refNo, note }: { id: string; refNo: string; note?: string }) =>
      fetcher(`/withdrawal-requests/${id}/approve`, { method: "PATCH", body: JSON.stringify({ refNo, note }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-withdrawals"] }),
  });
};

export const useRejectWithdrawal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      fetcher(`/withdrawal-requests/${id}/reject`, { method: "PATCH", body: JSON.stringify({ reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-withdrawals"] }),
  });
};

export const useBatchApproveWithdrawals = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      fetcher("/withdrawal-requests/batch-approve", { method: "PATCH", body: JSON.stringify({ ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-withdrawals"] }),
  });
};

export const useBatchRejectWithdrawals = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, reason }: { ids: string[]; reason: string }) =>
      fetcher("/withdrawal-requests/batch-reject", { method: "PATCH", body: JSON.stringify({ ids, reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-withdrawals"] }),
  });
};

export const useCreditRiderWallet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, description, type }: { id: string; amount: number; description?: string; type?: string }) =>
      fetcher(`/riders/${id}/credit`, { method: "POST", body: JSON.stringify({ amount, description, type }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-riders"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
    },
  });
};

// ── Ride Service Types ──
export const useRideServices = () =>
  useQuery({ queryKey: ["admin-ride-services"], queryFn: () => fetcher("/ride-services"), staleTime: 0 });

export const useCreateRideService = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetcher("/ride-services", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-ride-services"] }),
  });
};

export const useUpdateRideService = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      fetcher(`/ride-services/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-ride-services"] }),
  });
};

export const useDeleteRideService = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/ride-services/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-ride-services"] }),
  });
};

// All Notifications
export const useAllNotifications = (role?: string) => {
  return useQuery({
    queryKey: ["admin-all-notifications", role],
    queryFn: () => fetcher(`/all-notifications${role ? `?role=${role}` : ""}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};

// ══════════════════════════════════════════════════════
// POPULAR LOCATIONS
// ══════════════════════════════════════════════════════

export const usePopularLocations = () => {
  return useQuery({
    queryKey: ["admin-popular-locations"],
    queryFn: () => fetcher("/locations"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useCreateLocation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetcher("/locations", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-popular-locations"] }),
  });
};

export const useUpdateLocation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      fetcher(`/locations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-popular-locations"] }),
  });
};

export const useDeleteLocation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/locations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-popular-locations"] }),
  });
};

// ══════════════════════════════════════════════════════
// SCHOOL ROUTES
// ══════════════════════════════════════════════════════

export const useSchoolRoutes = () => {
  return useQuery({
    queryKey: ["admin-school-routes"],
    queryFn: () => fetcher("/school-routes"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useCreateSchoolRoute = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetcher("/school-routes", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-school-routes"] }),
  });
};

export const useUpdateSchoolRoute = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      fetcher(`/school-routes/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-school-routes"] }),
  });
};

export const useDeleteSchoolRoute = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/school-routes/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-school-routes"] }),
  });
};

export const useSchoolSubscriptions = (routeId?: string) => {
  return useQuery({
    queryKey: ["admin-school-subscriptions", routeId],
    queryFn: () => fetcher(`/school-subscriptions${routeId ? `?routeId=${routeId}` : ""}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};


type LiveRidersResponse = {
  riders: Array<{
    userId: string;
    name: string;
    phone: string | null;
    isOnline: boolean;
    vehicleType: string | null;
    lat: number;
    lng: number;
    updatedAt: string;
    ageSeconds: number;
    isFresh: boolean;
    action?: string | null;
  }>;
  total: number;
  freshCount: number;
  staleTimeoutSec: number;
};

export const useLiveRiders = () => {
  return useQuery<LiveRidersResponse>({
    queryKey: ["admin-live-riders"],
    queryFn: () => fetcher("/live-riders"),
    refetchInterval: 10_000,
  });
};

export const useCustomerLocations = () => {
  return useQuery({
    queryKey: ["admin-customer-locations"],
    queryFn: () => fetcher("/customer-locations"),
    refetchInterval: 30_000,
  });
};

/* ── Task 4 additions ── */

export const useRequestUserCorrection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, field, note }: { id: string; field?: string; note?: string }) =>
      fetcher(`/users/${id}/request-correction`, { method: "PATCH", body: JSON.stringify({ field, note }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-users"] }); qc.invalidateQueries({ queryKey: ["admin-users-pending"] }); },
  });
};

export const useBulkBanUsers = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, action, reason }: { ids: string[]; action: "ban" | "unban"; reason?: string }) =>
      fetcher("/users/bulk-ban", { method: "PATCH", body: JSON.stringify({ ids, action, reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
};

export const useAssignRider = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, riderId, riderName, riderPhone }: { orderId: string; riderId?: string; riderName?: string; riderPhone?: string }) =>
      fetcher(`/orders/${orderId}/assign-rider`, { method: "PATCH", body: JSON.stringify({ riderId, riderName, riderPhone }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-orders-enriched"] }),
  });
};

export const useVendorCommissionOverride = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, commissionPct }: { id: string; commissionPct: number }) =>
      fetcher(`/vendors/${id}/commission`, { method: "PATCH", body: JSON.stringify({ commissionPct }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-vendors"] }),
  });
};

export const useToggleRiderOnline = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isOnline }: { id: string; isOnline: boolean }) =>
      fetcher(`/riders/${id}/online`, { method: "PATCH", body: JSON.stringify({ isOnline }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-riders"] }),
  });
};

export const useRevenueTrend = () =>
  useQuery({ queryKey: ["admin-revenue-trend"], queryFn: () => fetcher("/revenue-trend"), refetchInterval: 60_000 });

export const useLeaderboard = () =>
  useQuery({ queryKey: ["admin-leaderboard"], queryFn: () => fetcher("/leaderboard"), refetchInterval: 60_000 });

export const useAdminCancelRide = () => {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      fetcher(`/rides/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      qc.invalidateQueries({ queryKey: ["admin-rides"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      qc.invalidateQueries({ queryKey: ["admin-dispatch-monitor"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-detail"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-audit"] });
    },
    onError: (error: Error) => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      toast({ title: "Failed to cancel ride", description: error.message, variant: "destructive" });
      if (import.meta.env.DEV) console.error("[admin] cancel ride failed:", error.message);
    },
  });
};

export const useAdminRefundRide = () => {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, amount, reason }: { id: string; amount?: number; reason?: string }) =>
      fetcher(`/rides/${id}/refund`, { method: "POST", body: JSON.stringify({ amount, reason }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      qc.invalidateQueries({ queryKey: ["admin-transactions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-detail"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-audit"] });
    },
    onError: (error: Error) => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      toast({ title: "Failed to process refund", description: error.message, variant: "destructive" });
      if (import.meta.env.DEV) console.error("[admin] refund ride failed:", error.message);
    },
  });
};

export const useAdminReassignRide = () => {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, riderId, riderName, riderPhone }: { id: string; riderId?: string; riderName?: string; riderPhone?: string }) =>
      fetcher(`/rides/${id}/reassign`, { method: "POST", body: JSON.stringify({ riderId, riderName, riderPhone }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      qc.invalidateQueries({ queryKey: ["admin-rides"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-detail"] });
      qc.invalidateQueries({ queryKey: ["admin-ride-audit"] });
    },
    onError: (error: Error) => {
      qc.invalidateQueries({ queryKey: ["admin-rides-enriched"] });
      toast({ title: "Failed to reassign rider", description: error.message, variant: "destructive" });
      if (import.meta.env.DEV) console.error("[admin] reassign ride failed:", error.message);
    },
  });
};

export const useRideDetail = (rideId: string | null) =>
  useQuery({
    queryKey: ["admin-ride-detail", rideId],
    queryFn: () => fetcher(`/rides/${rideId}/detail`),
    enabled: !!rideId,
  });

export const useRideAuditTrail = (rideId: string | null) =>
  useQuery({
    queryKey: ["admin-ride-audit", rideId],
    queryFn: () => fetcher(`/rides/${rideId}/audit-trail`),
    enabled: !!rideId,
    refetchInterval: 15_000,
  });

export const useDispatchMonitor = () =>
  useQuery({
    queryKey: ["admin-dispatch-monitor"],
    queryFn: () => fetcher("/dispatch-monitor"),
    refetchInterval: 10_000,
  });

export const useAuditLog = (params?: { page?: number; action?: string; from?: string; to?: string }) => {
  const qs = new URLSearchParams();
  if (params?.page)   qs.set("page",   String(params.page));
  if (params?.action) qs.set("action", params.action);
  if (params?.from)   qs.set("from",   params.from);
  if (params?.to)     qs.set("to",     params.to);
  const q = qs.toString();
  return useQuery({
    queryKey: ["admin-audit-log", params],
    queryFn: () => fetcher(`/audit-log${q ? `?${q}` : ""}`),
    refetchInterval: 30_000,
  });
};

export const useRiderRoute = (userId: string | null, date?: string) => {
  const qs = date ? `?date=${date}` : "?sinceOnline=true";
  return useQuery({
    queryKey: ["admin-rider-route", userId, date ?? "session"],
    queryFn: () => fetcher(`/riders/${userId}/route${qs}`),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
};

export const useRiderTrailsBatch = (riderIds: string[]) => {
  const results = useQueries({
    queries: riderIds.map(id => ({
      queryKey: ["admin-rider-route", id, "session"],
      queryFn: () => fetcher(`/riders/${id}/route?sinceOnline=true`),
      enabled: riderIds.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    })),
  });
  return results.map((r, i) => ({
    riderId: riderIds[i],
    points: ((r.data as { route?: Array<{ latitude: number; longitude: number }> } | undefined)?.route ?? [])
      .map((p): [number, number] => [p.latitude, p.longitude]),
  })).filter(t => t.points.length >= 2);
};

/* ── Reviews ── */
export const useAdminReviews = (params?: { status?: string; type?: string; q?: string }) =>
  useQuery({
    queryKey: ["admin-reviews", params],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.status && params.status !== "all") qs.set("status", params.status);
      if (params?.type   && params.type   !== "all") qs.set("type", params.type);
      if (params?.q)                                  qs.set("q", params.q);
      const query = qs.toString();
      return fetcher(`/reviews${query ? `?${query}` : ""}`);
    },
    refetchInterval: 30_000,
  });

export const useModerationQueue = () =>
  useQuery({
    queryKey: ["admin-moderation-queue"],
    queryFn: () => fetcher("/reviews/moderation-queue"),
    refetchInterval: 15_000,
  });

export const useApproveReview = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/reviews/${id}/approve`, { method: "PATCH" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-moderation-queue"] });
      qc.invalidateQueries({ queryKey: ["admin-reviews"] });
    },
  });
};

export const useRejectReview = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/reviews/${id}/reject`, { method: "PATCH" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-moderation-queue"] });
      qc.invalidateQueries({ queryKey: ["admin-reviews"] });
    },
  });
};

export const useRunRatingSuspension = () =>
  useMutation({ mutationFn: () => fetcher("/jobs/rating-suspension", { method: "POST" }) });

export const useOverrideSuspension = (role: "riders" | "vendors") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/${role}/${id}/override-suspension`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-riders"] });
      qc.invalidateQueries({ queryKey: ["admin-vendors"] });
    },
  });
};

/* ── Service Zones ── */
export type ServiceZone = {
  id: number;
  name: string;
  city: string;
  lat: string;
  lng: string;
  radiusKm: string;
  isActive: boolean;
  appliesToRides: boolean;
  appliesToOrders: boolean;
  appliesToParcel: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export const useServiceZones = () =>
  useQuery<ServiceZone[]>({
    queryKey: ["admin-service-zones"],
    queryFn: () => fetcher("/service-zones"),
    staleTime: 30_000,
  });

export const useCreateServiceZone = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ServiceZone>) =>
      fetcher("/service-zones", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-service-zones"] }),
  });
};

export const useUpdateServiceZone = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<ServiceZone> & { id: number }) =>
      fetcher(`/service-zones/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-service-zones"] }),
  });
};

export const useDeleteServiceZone = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      fetcher(`/service-zones/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-service-zones"] }),
  });
};

export const useDeliveryAccess = () => {
  return useQuery({
    queryKey: ["admin-delivery-access"],
    queryFn: () => fetcher("/delivery-access"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useUpdateDeliveryMode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: string) =>
      fetcher("/delivery-access/mode", { method: "PUT", body: JSON.stringify({ mode }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-delivery-access"] });
    },
  });
};

export const useAddWhitelistEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; targetId: string; serviceType?: string; validUntil?: string; deliveryLabel?: string; notes?: string }) =>
      fetcher("/delivery-access/whitelist", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-delivery-access"] }),
  });
};

export const useBulkAddWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entries: any[]) =>
      fetcher("/delivery-access/whitelist/bulk", { method: "POST", body: JSON.stringify({ entries }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-delivery-access"] }),
  });
};

export const useUpdateWhitelistEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; deliveryLabel?: string; notes?: string; validUntil?: string; status?: string }) =>
      fetcher(`/delivery-access/whitelist/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-delivery-access"] }),
  });
};

export const useDeleteWhitelistEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher(`/delivery-access/whitelist/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-delivery-access"] }),
  });
};

export const useDeliveryAccessRequests = () => {
  return useQuery({
    queryKey: ["admin-delivery-requests"],
    queryFn: () => fetcher("/delivery-access/requests"),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useResolveDeliveryRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, notes }: { id: string; status: "approved" | "rejected"; notes?: string }) =>
      fetcher(`/delivery-access/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status, notes }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-delivery-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-delivery-access"] });
    },
  });
};

export const useDeliveryAccessAudit = () => {
  return useQuery({
    queryKey: ["admin-delivery-audit"],
    queryFn: () => fetcher("/delivery-access/audit"),
  });
};

export const useConditions = (filters?: Record<string, string>) => {
  const params = new URLSearchParams(filters || {}).toString();
  return useQuery({
    queryKey: ["admin-conditions", filters],
    queryFn: () => fetcher(`/conditions${params ? `?${params}` : ""}`),
    refetchInterval: REFETCH_INTERVAL,
  });
};

export const useUserConditions = (userId: string) => {
  return useQuery({
    queryKey: ["admin-conditions-user", userId],
    queryFn: () => fetcher(`/conditions/user/${userId}`),
    enabled: !!userId,
  });
};

export const useApplyCondition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, any>) =>
      fetcher("/conditions", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-conditions"] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["admin-vendors"] });
      qc.invalidateQueries({ queryKey: ["admin-riders"] });
    },
  });
};

export const useUpdateCondition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: any }) =>
      fetcher(`/conditions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-conditions"] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });
};

export const useDeleteCondition = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher(`/conditions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-conditions"] });
    },
  });
};

export const useBulkConditionAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[]; action: string; reason?: string }) =>
      fetcher("/conditions/bulk", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-conditions"] });
    },
  });
};

export const useConditionRules = () => {
  return useQuery({
    queryKey: ["admin-condition-rules"],
    queryFn: () => fetcher("/condition-rules"),
  });
};

export const useCreateConditionRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, any>) =>
      fetcher("/condition-rules", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-condition-rules"] });
    },
  });
};

export const useUpdateConditionRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: any }) =>
      fetcher(`/condition-rules/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-condition-rules"] });
    },
  });
};

export const useDeleteConditionRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher(`/condition-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-condition-rules"] });
    },
  });
};

export const useSeedDefaultRules = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher("/condition-rules/seed-defaults", { method: "POST", body: "{}" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-condition-rules"] });
    },
  });
};

export const useConditionSettings = () => {
  return useQuery({
    queryKey: ["admin-condition-settings"],
    queryFn: () => fetcher("/condition-settings"),
  });
};

export const useUpdateConditionSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, any>) =>
      fetcher("/condition-settings", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-condition-settings"] });
    },
  });
};

export const useEvaluateRules = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      fetcher(`/condition-rules/evaluate/${userId}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-conditions"] });
    },
  });
};

// ══════════════════════════════════════════════════════
// SMS GATEWAYS (Hybrid Firebase / Dynamic Failover)
// ══════════════════════════════════════════════════════

export const useSmsGateways = () =>
  useQuery({ queryKey: ["admin-sms-gateways"], queryFn: () => fetcher("/sms-gateways"), refetchInterval: 60_000 });

export const useCreateSmsGateway = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fetcher("/sms-gateways", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-sms-gateways"] }),
  });
};

export const useUpdateSmsGateway = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => fetcher(`/sms-gateways/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-sms-gateways"] }),
  });
};

export const useDeleteSmsGateway = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/sms-gateways/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-sms-gateways"] }),
  });
};

export const useToggleSmsGateway = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/sms-gateways/${id}/toggle`, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-sms-gateways"] }),
  });
};

// ══════════════════════════════════════════════════════
// OTP WHITELIST (Per-identity bypass for testers)
// ══════════════════════════════════════════════════════

/* Mirrors the row shape returned from `GET /admin/whitelist`. Keeping it
   here means consumers (the OTP Control page, future hooks, tests) all
   share one definition instead of redeclaring `any` shapes. */
export interface OtpWhitelistEntry {
  id: string;
  identifier: string;
  label?: string;
  bypassCode: string;
  isActive: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OtpWhitelistResponse {
  entries: OtpWhitelistEntry[];
  total?: number;
  page?: number;
  pages?: number;
}

export interface AddOtpWhitelistInput {
  identifier: string;
  label?: string;
  bypassCode?: string;
  expiresAt?: string;
}

export interface UpdateOtpWhitelistInput {
  id: string;
  label?: string;
  bypassCode?: string;
  isActive?: boolean;
  expiresAt?: string | null;
}

export const useOtpWhitelist = (page = 1) =>
  useQuery<OtpWhitelistResponse>({
    queryKey: ["admin-otp-whitelist", page],
    queryFn: () => fetcher(`/otp/whitelist?page=${page}`),
    refetchInterval: 30_000,
  });

export const useAddOtpWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    /* Was POSTing to `/whitelist`, which doesn't exist on the admin
       router — every "Add" call would 404. Aligned with the route in
       `artifacts/api-server/src/routes/admin/otp.ts`. */
    mutationFn: (data: AddOtpWhitelistInput) =>
      fetcher("/otp/whitelist", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-otp-whitelist"] }),
  });
};

export const useUpdateOtpWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateOtpWhitelistInput) =>
      fetcher(`/otp/whitelist/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-otp-whitelist"] }),
  });
};

export const useDeleteOtpWhitelist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetcher(`/otp/whitelist/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-otp-whitelist"] }),
  });
};

// ══════════════════════════════════════════════════════
// OTP ADMIN TOOLS: GENERATE + VERIFY
// ══════════════════════════════════════════════════════

export interface GenerateOtpInput {
  /** userId, phone, or email */
  identifier: string;
}

export interface GenerateOtpResult {
  otp: string;
  expiresAt: string;
  userId: string;
  phone: string | null;
  email: string | null;
  name: string | null;
}

export const useAdminGenerateOtp = () =>
  useMutation<GenerateOtpResult, Error, GenerateOtpInput>({
    mutationFn: (data) =>
      fetcher("/otp/generate", { method: "POST", body: JSON.stringify(data) }),
  });

export interface VerifyOtpInput {
  /** userId, phone, or email */
  identifier: string;
  otp: string;
}

export interface VerifyOtpResult {
  valid: boolean;
  reason?: string;
  userId?: string;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  expiresAt?: string | null;
}

export const useAdminVerifyOtp = () =>
  useMutation<VerifyOtpResult, Error, VerifyOtpInput>({
    mutationFn: (data) =>
      fetcher("/otp/verify", { method: "POST", body: JSON.stringify(data) }),
  });

// ══════════════════════════════════════════════════════
// USER SESSIONS (Remote logout / session revocation)
// ══════════════════════════════════════════════════════

export const useAdminUserSessions = (userId: string | null) =>
  useQuery({
    queryKey: ["admin-user-sessions", userId],
    queryFn: () => fetcher(`/users/${userId}/sessions`),
    enabled: !!userId,
  });

export const useRevokeUserSession = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, sessionId }: { userId: string; sessionId: string }) =>
      fetcher(`/users/${userId}/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["admin-user-sessions", vars.userId] }),
  });
};

export const useRevokeAllUserSessions = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => fetcher(`/users/${userId}/sessions`, { method: "DELETE" }),
    onSuccess: (_data, userId) => qc.invalidateQueries({ queryKey: ["admin-user-sessions", userId] }),
  });
};
