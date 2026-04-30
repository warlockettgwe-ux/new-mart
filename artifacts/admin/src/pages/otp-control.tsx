import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ElementType,
  type ReactNode,
} from "react";
import { PageHeader } from "@/components/shared";
import {
  Shield,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  Clock,
  AlertTriangle,
  Users,
  ChevronRight,
  UserCheck,
  UserX,
  Info,
  ListChecks,
  Plus,
  Trash2,
  CalendarDays,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { fetcher } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  useOtpWhitelist,
  useAddOtpWhitelist,
  useUpdateOtpWhitelist,
  useDeleteOtpWhitelist,
  useAdminGenerateOtp,
  useAdminVerifyOtp,
  type GenerateOtpResult,
  type VerifyOtpResult,
} from "@/hooks/use-admin";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { KeyRound, ShieldCheck } from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────────────
   CONSTANTS & TYPES
   ───────────────────────────────────────────────────────────────────────────── */

/** Single source of truth for the bypass-code shape. Must stay in sync with
 *  the backend regex in `artifacts/api-server/src/routes/admin/otp.ts`. */
const BYPASS_CODE_REGEX = /^[0-9]{6}$/;

/** Typed shape for errors thrown by the `fetcher` helper. */
interface ApiError {
  status?: number;
  message?: string;
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    ("status" in value || "message" in value)
  );
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(value: unknown, fallback = "Something went wrong"): string {
  if (
    isApiError(value) &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return value.message;
  }
  if (value instanceof Error) return value.message;
  return fallback;
}

/** Thin wrapper around `fetcher` that silently returns `null` on 401 and
 *  re-throws everything else so callers can handle it uniformly. */
async function api(method: string, path: string, body?: unknown) {
  try {
    return await fetcher(path, {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e: unknown) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

type OTPStatus = {
  isGloballyDisabled: boolean;
  disabledUntil: string | null;
  activeBypassCount: number;
};

type UserRow = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  otpBypassUntil: string | null;
};

type OtpWhitelistEntry = {
  id: string;
  identifier: string;
  label?: string;
  bypassCode: string;
  isActive: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** Keyed union — adding a new event type here forces a label update below. */
type OtpAuditEvent =
  | "login_otp_bypass"
  | "login_global_otp_bypass"
  | "otp_send_bypassed"
  | "admin_otp_global_disable"
  | "admin_otp_global_restore";

type AuditRow = {
  id: string;
  event: OtpAuditEvent;
  createdAt: string;
  ip: string;
  userId?: string | null;
  phone?: string | null;
  name?: string | null;
};

/* ─────────────────────────────────────────────────────────────────────────────
   PURE HELPERS
   ───────────────────────────────────────────────────────────────────────────── */

/** Robust active-bypass check.
 *  `new Date(invalid).getTime()` returns NaN; `NaN > Date.now()` is silently
 *  false which would mask malformed dates as "expired". We guard explicitly. */
function isBypassActive(otpBypassUntil: string | null | undefined): boolean {
  if (!otpBypassUntil) return false;
  const ts = new Date(otpBypassUntil).getTime();
  if (Number.isNaN(ts)) return false;
  return ts > Date.now();
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * BUG FIX #7 — Guard against invalid ISO strings so we never render the raw
 * browser "Invalid Date" string to the admin.
 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}


/* ─────────────────────────────────────────────────────────────────────────────
   HOOKS
   ───────────────────────────────────────────────────────────────────────────── */

function useCountdown(targetIso: string | null): number {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!targetIso) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const diff = Math.max(0, new Date(targetIso).getTime() - Date.now());
      setRemaining(diff);
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [targetIso]);

  return remaining;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SHARED UI PRIMITIVES
   ───────────────────────────────────────────────────────────────────────────── */

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-border bg-white p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  label,
  color,
}: {
  icon: ElementType;
  label: string;
  color: string;
}) {
  return (
    <div className={`flex items-center gap-2 mb-4 ${color}`}>
      <Icon className="w-4 h-4" />
      <h3 className="text-sm font-bold">{label}</h3>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN COMPONENT
   ───────────────────────────────────────────────────────────────────────────── */

export default function OtpControl() {
  const { toast } = useToast();

  /* ── Global suspension state ── */
  const [status, setStatus] = useState<OTPStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");
  const remaining = useCountdown(status?.disabledUntil ?? null);

  /* ── Per-user bypass state ── */
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [bypassMins, setBypassMins] = useState<Record<string, string>>({});

  /** Cancelled when a newer keystroke fires so a slow earlier response can't
   *  overwrite the latest results. */
  const searchAbortRef = useRef<AbortController | null>(null);

  /* ── Audit log state ── */
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  /* ─────────────────────────────────────────────────────────────────────────
     DATA LOADERS
     ───────────────────────────────────────────────────────────────────────── */

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const d = await api("GET", "/otp/status");
      if (d?.data) setStatus(d.data as OTPStatus);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const d = await api("GET", "/otp/audit?page=1");
      if (d?.data?.entries) {
        const AUDIT_EVENTS: OtpAuditEvent[] = [
          "login_otp_bypass",
          "login_global_otp_bypass",
          "otp_send_bypassed",
          "admin_otp_global_disable",
          "admin_otp_global_restore",
        ];
        const bypass = (d.data.entries as AuditRow[])
          .filter((e) => AUDIT_EVENTS.includes(e.event))
          .slice(0, 50);
        setAuditRows(bypass);
      }
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadAudit();
  }, [loadStatus, loadAudit]);

  /* ── Auto-refresh when countdown expires ──────────────────────────────────
     BUG FIX #5 + #9 — Two problems in the original code:
       1. No guard against repeated triggers: if the backend still returned the
          same "disabled" state after the 1 500 ms delay (expiry processor
          hadn't run yet), the effect immediately re-scheduled another
          setTimeout, creating a polling loop that hammered the server.
       2. The setTimeout cleanup (clearTimeout) was never returned from the
          effect, leaking a pending timer when the component unmounted.
     Fix: track which `disabledUntil` value we have already scheduled a
     refresh for via a ref. Once scheduled we don't reschedule until
     `disabledUntil` changes (i.e. a new suspension period begins). The
     cleanup function also cancels the pending timeout on unmount or dep change.
  ─────────────────────────────────────────────────────────────────────────── */
  const refreshedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      status?.isGloballyDisabled &&
      remaining === 0 &&
      status.disabledUntil &&
      refreshedForRef.current !== status.disabledUntil
    ) {
      refreshedForRef.current = status.disabledUntil;
      const t = setTimeout(loadStatus, 1_500);
      return () => clearTimeout(t);
    }
    return;
  }, [remaining, status?.isGloballyDisabled, status?.disabledUntil, loadStatus]);

  /* ─────────────────────────────────────────────────────────────────────────
     GLOBAL SUSPENSION ACTIONS
     ───────────────────────────────────────────────────────────────────────── */

  const suspend = async (mins: number) => {
    if (!mins || mins <= 0) return;
    try {
      const d = await api("POST", "/otp/disable", { minutes: mins });

      /**
       * BUG FIX #8 — `api()` returns null for 401 instead of throwing.
       * Previously the null check fell through to the else branch and showed a
       * generic "Failed" message. Now we surface a clearer "Unauthorised" error.
       */
      if (d === null) {
        toast({
          title: "Unauthorised",
          description: "Session may have expired. Please refresh.",
          variant: "destructive",
        });
        return;
      }

      if (d?.data) {
        toast({
          title: "OTP Suspended",
          description: `All OTPs suspended for ${mins} minute(s).`,
        });
        loadStatus();
        loadAudit();
      } else {
        toast({
          title: "Error",
          description: d?.error ?? "Failed to suspend OTP.",
          variant: "destructive",
        });
      }
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Failed to suspend OTP."),
        variant: "destructive",
      });
    }
  };

  /**
   * BUG FIX #1 — `restore` had no error handling. A failed DELETE request
   * would still show "OTPs Restored" and leave the UI in a stale state.
   */
  const restore = async () => {
    try {
      const d = await api("DELETE", "/otp/disable");
      if (d === null) {
        toast({
          title: "Unauthorised",
          description: "Session may have expired. Please refresh.",
          variant: "destructive",
        });
        return;
      }
      toast({ title: "OTPs Restored", description: "Global OTP suspension lifted." });
      loadStatus();
      loadAudit();
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Failed to restore OTPs."),
        variant: "destructive",
      });
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     PER-USER BYPASS ACTIONS
     ───────────────────────────────────────────────────────────────────────── */

  const searchUsers = useCallback(async () => {
    if (!query.trim() || query.trim().length < 2) return;

    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;

    setSearching(true);
    try {
      const d = await fetcher(
        `/users/search?q=${encodeURIComponent(query)}&limit=20`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      setUsers(
        (d?.users ?? []).map((u: UserRow) => ({
          id: u.id,
          name: u.name,
          phone: u.phone,
          email: u.email ?? null,
          otpBypassUntil: u.otpBypassUntil ?? null,
        })),
      );
    } catch (e: unknown) {
      /**
       * BUG FIX #6 — The original code had a redundant, type-unsafe second
       * check: `isApiError(e) && (e as { name?: string }).name === "AbortError"`.
       * `ApiError` has no `name` field so the cast was incorrect and could
       * accidentally swallow non-abort errors. A standard `DOMException` with
       * `name === "AbortError"` is the canonical abort signal in browser fetch;
       * the first branch is sufficient.
       */
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast({
        title: "Search failed",
        description: errorMessage(e, "Could not load users."),
        variant: "destructive",
      });
    } finally {
      if (searchAbortRef.current === ctrl) {
        searchAbortRef.current = null;
        setSearching(false);
      }
    }
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim().length >= 2) searchUsers();
    }, 400);
    return () => clearTimeout(t);
  }, [query, searchUsers]);

  /** Cancel in-flight search on unmount to prevent state updates on an
   *  unmounted component. */
  useEffect(() => () => { searchAbortRef.current?.abort(); }, []);

  /** Grant a timed OTP bypass to a single user. */
  const grantBypass = async (userId: string, mins: number) => {
    try {
      const d = await api("POST", `/users/${userId}/otp/bypass`, {
        minutes: mins,
      });
      if (d?.data?.bypassUntil) {
        toast({
          title: "Bypass Granted",
          description: `OTP bypass active for ${mins} minute(s).`,
        });
        setUsers((prev) =>
          prev.map((u) =>
            u.id === userId ? { ...u, otpBypassUntil: d.data.bypassUntil } : u,
          ),
        );

        /**
         * BUG FIX #4 — Clear the custom-minutes input for this user after a
         * successful grant so the field doesn't retain a stale value and the
         * admin doesn't accidentally re-submit the same duration.
         */
        setBypassMins((prev) => {
          const next = { ...prev };
          delete next[userId];
          return next;
        });

        loadStatus();
      } else {
        toast({
          title: "Error",
          description: d?.error ?? "Failed to grant bypass.",
          variant: "destructive",
        });
      }
    } catch (e: unknown) {
      if (isApiError(e) && e.status === 409) {
        toast({
          title: "Bypass already active",
          description: errorMessage(e, "User already has an active OTP bypass."),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Error",
        description: errorMessage(e, "Failed to grant bypass."),
        variant: "destructive",
      });
    }
  };

  /**
   * BUG FIX #2 — `cancelBypass` had no error handling: the success toast
   * fired and the optimistic state update ran even when the API call threw.
   * State is now updated only after a confirmed successful DELETE.
   */
  const cancelBypass = async (userId: string) => {
    try {
      await api("DELETE", `/users/${userId}/otp/bypass`);
      toast({ title: "Bypass Removed" });
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, otpBypassUntil: null } : u,
        ),
      );
      loadStatus();
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Failed to remove bypass."),
        variant: "destructive",
      });
    }
  };

  /**
   * BUG FIX #3 — Extracted the custom-bypass click handler from inline JSX
   * so we can validate the input and show a meaningful toast instead of
   * silently doing nothing when `parseInt` returns NaN (empty field or
   * non-numeric text).
   */
  const handleCustomBypass = (userId: string) => {
    const raw = bypassMins[userId]?.trim() ?? "";
    const m = parseInt(raw, 10);
    if (!raw || Number.isNaN(m) || m <= 0) {
      toast({
        title: "Invalid duration",
        description: "Enter a whole number of minutes greater than 0.",
        variant: "destructive",
      });
      return;
    }
    grantBypass(userId, m);
  };

  /** Audit event labels — keyed by the full `OtpAuditEvent` union so that
   *  adding a new event type produces a TypeScript compile error here. */
  const eventLabel: Record<OtpAuditEvent, string> = {
    login_otp_bypass: "Per-user bypass",
    login_global_otp_bypass: "Global suspension",
    otp_send_bypassed: "OTP send bypassed",
    admin_otp_global_disable: "Admin: OTP disabled",
    admin_otp_global_restore: "Admin: OTP restored",
  };

  /* ─────────────────────────────────────────────────────────────────────────
     RENDER
     ───────────────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader
        icon={Shield}
        title="OTP Global Control"
        subtitle="Single control panel for all OTP settings — no OTP controls exist elsewhere."
        iconBgClass="bg-indigo-100"
        iconColorClass="text-indigo-700"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              loadStatus();
              loadAudit();
            }}
            disabled={statusLoading}
            className="gap-1"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${statusLoading ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </Button>
        }
      />

      {/* ── 1. GLOBAL SUSPENSION STATUS ─────────────────────────────────── */}
      <Card>
        <SectionTitle
          icon={Shield}
          label="Global OTP Suspension"
          color="text-indigo-700"
        />

        {/* Status banner */}
        <div
          className={`rounded-xl p-4 mb-4 flex items-center gap-3 ${
            status?.isGloballyDisabled
              ? "bg-red-50 border-2 border-red-300"
              : "bg-green-50 border border-green-200"
          }`}
        >
          {status === null ? (
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          ) : status.isGloballyDisabled ? (
            <>
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-bold text-red-800">
                  OTPs are GLOBALLY SUSPENDED
                </p>
                <p className="text-xs text-red-700 mt-0.5">
                  All users can log in without OTP. Auto-restores in:{" "}
                  <span className="font-mono font-bold">
                    {fmtCountdown(remaining)}
                  </span>
                </p>
              </div>
              <Button size="sm" variant="destructive" onClick={restore}>
                Restore Now
              </Button>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-bold text-green-800">
                  OTPs are ACTIVE
                </p>
                <p className="text-xs text-green-700 mt-0.5">
                  {status.activeBypassCount > 0
                    ? `${status.activeBypassCount} user(s) have per-user bypass active.`
                    : "All users must verify OTP on login."}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Suspension controls */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <Info className="w-4 h-4 flex-shrink-0" />
            <span>
              Use during SMS/OTP delivery outages. OTP verification auto-resumes
              when the timer expires. New registrations during suspension will
              have <code>is_verified = false</code>.
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {(
              [
                { label: "30 min", mins: 30 },
                { label: "1 hour", mins: 60 },
                { label: "2 hours", mins: 120 },
                { label: "24 hours", mins: 1440 },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.mins}
                variant="outline"
                size="sm"
                className="border-red-300 text-red-700 hover:bg-red-50"
                onClick={() => suspend(opt.mins)}
                disabled={statusLoading}
              >
                Suspend for {opt.label}
              </Button>
            ))}

            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Custom mins"
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                className="w-28 h-8 text-xs"
                min={1}
                max={10080}
              />
              <Button
                variant="outline"
                size="sm"
                className="border-red-300 text-red-700 hover:bg-red-50 h-8"
                onClick={() => {
                  const m = parseInt(customMinutes, 10);
                  if (Number.isNaN(m) || m <= 0) {
                    toast({
                      title: "Invalid duration",
                      description:
                        "Enter a whole number of minutes greater than 0.",
                      variant: "destructive",
                    });
                    return;
                  }
                  suspend(m);
                }}
                disabled={!customMinutes || statusLoading}
              >
                Suspend
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* ── 2. PER-USER OTP BYPASS ──────────────────────────────────────── */}
      <Card>
        <SectionTitle
          icon={Users}
          label="Per-User OTP Bypass"
          color="text-blue-700"
        />
        <p className="text-xs text-muted-foreground mb-3">
          Users on this list always skip OTP — even when global OTP is ON. This
          is the highest-priority bypass.
        </p>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search user by name, phone, or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {searching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Searching…
          </div>
        )}

        {users.length > 0 && (
          <div className="space-y-2">
            {users.map((user) => {
              const bypassActive = isBypassActive(user.otpBypassUntil);
              return (
                <div
                  key={user.id}
                  className="rounded-xl border border-border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="text-sm font-semibold">
                        {user.name ?? "Unnamed"}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {user.phone ?? user.email ?? "—"}
                      </p>
                      {bypassActive && user.otpBypassUntil && (
                        <p className="text-[10px] text-green-700 mt-0.5">
                          Bypass until: {fmtDate(user.otpBypassUntil)}
                        </p>
                      )}
                    </div>
                    {bypassActive ? (
                      <Badge className="bg-green-100 text-green-700 border-green-200 shrink-0">
                        <UserCheck className="w-3 h-3 mr-1" /> Bypass Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="shrink-0">
                        <UserX className="w-3 h-3 mr-1" /> Normal OTP
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {bypassActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-red-300 text-red-700 hover:bg-red-50"
                        onClick={() => cancelBypass(user.id)}
                      >
                        <XCircle className="w-3 h-3 mr-1" /> Remove Bypass
                      </Button>
                    ) : (
                      <>
                        {([15, 60, 1440] as const).map((m) => (
                          <Button
                            key={m}
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => grantBypass(user.id, m)}
                          >
                            Bypass{" "}
                            {m < 60 ? `${m}m` : m === 60 ? "1h" : "24h"}
                          </Button>
                        ))}
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            placeholder="min"
                            value={bypassMins[user.id] ?? ""}
                            onChange={(e) =>
                              setBypassMins((p) => ({
                                ...p,
                                [user.id]: e.target.value,
                              }))
                            }
                            className="w-16 h-7 text-xs"
                            min={1}
                          />
                          {/* BUG FIX #3 — Replaced silent inline handler with
                              `handleCustomBypass` which validates the input and
                              shows a descriptive toast on failure. */}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => handleCustomBypass(user.id)}
                          >
                            Custom
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!searching && query.trim().length >= 2 && users.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No users found.
          </p>
        )}

        {!query.trim() && (
          <p className="text-xs text-muted-foreground text-center py-4 bg-muted/30 rounded-xl">
            Search a user above to manage their OTP bypass.
          </p>
        )}
      </Card>

      {/* ── 3. AUDIT LOG ────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle
          icon={Clock}
          label="No-OTP Login Audit"
          color="text-purple-700"
        />
        <p className="text-xs text-muted-foreground mb-3">
          Every login that skipped OTP (via per-user bypass or global
          suspension) is recorded here.
        </p>

        {auditLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : auditRows.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No no-OTP logins recorded yet.
          </div>
        ) : (
          <div className="space-y-1.5">
            {auditRows.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/20 text-xs"
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    row.event === "login_otp_bypass"
                      ? "bg-blue-500"
                      : row.event === "admin_otp_global_disable"
                        ? "bg-red-500"
                        : row.event === "admin_otp_global_restore"
                          ? "bg-green-500"
                          : "bg-orange-500"
                  }`}
                />
                <span className="font-mono text-muted-foreground">
                  {fmtDate(row.createdAt)}
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="font-semibold text-foreground truncate">
                  {row.name ?? row.phone ?? row.userId ?? "—"}
                </span>
                <Badge
                  variant="outline"
                  className="text-[10px] shrink-0 ml-auto"
                >
                  {eventLabel[row.event]}
                </Badge>
                <span className="text-muted-foreground font-mono shrink-0">
                  {row.ip}
                </span>
              </div>
            ))}
          </div>
        )}

        <Button
          size="sm"
          variant="ghost"
          className="mt-3 text-xs"
          onClick={loadAudit}
          disabled={auditLoading}
        >
          <RefreshCw
            className={`w-3 h-3 mr-1 ${auditLoading ? "animate-spin" : ""}`}
          />{" "}
          Refresh Log
        </Button>
      </Card>

      {/* ── 4. WHITELIST ────────────────────────────────────────────────── */}
      <WhitelistSection />

      {/* ── 5. GENERATE OTP ─────────────────────────────────────────────── */}
      <GenerateOtpSection />

      {/* ── 6. VERIFY OTP ───────────────────────────────────────────────── */}
      <VerifyOtpSection />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   WHITELIST SECTION
   ───────────────────────────────────────────────────────────────────────────── */

function WhitelistSection() {
  const { toast } = useToast();
  const { data, isLoading, refetch } = useOtpWhitelist();
  const addEntry = useAddOtpWhitelist();
  const updateEntry = useUpdateOtpWhitelist();
  const deleteEntry = useDeleteOtpWhitelist();

  const [identifier, setIdentifier] = useState("");
  const [label, setLabel] = useState("");

  /**
   * C-1 FIX — `bypassCode` is left empty by default. The backend generates a
   * CSPRNG code when no bypass code is supplied, eliminating the previous
   * `Math.random()`-based `generateBypassCode()` which is not cryptographically
   * secure. Admins may still enter a custom 6-digit code if needed.
   */
  const [bypassCode, setBypassCode] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; identifier: string } | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [adding, setAdding] = useState(false);

  const entries: OtpWhitelistEntry[] = data?.entries ?? [];

  async function handleAdd() {
    if (!identifier.trim()) {
      toast({ title: "Identifier required", variant: "destructive" });
      return;
    }

    /* Validate only when the admin has entered a custom code.
       If the field is empty, the backend auto-generates a CSPRNG code. */
    const code = bypassCode.trim();
    if (code && !BYPASS_CODE_REGEX.test(code)) {
      toast({
        title: "Invalid bypass code",
        description: "Use a 6-digit numeric code, or leave blank to auto-generate.",
        variant: "destructive",
      });
      return;
    }

    setAdding(true);
    try {
      const result = await addEntry.mutateAsync({
        identifier: identifier.trim(),
        label: label.trim() || undefined,
        /* Omit bypassCode entirely when empty — server generates CSPRNG. */
        bypassCode: code || undefined,
        /**
         * `<input type="datetime-local">` returns a naive "YYYY-MM-DDTHH:mm"
         * string with no timezone. Sending it as-is means the server parses it
         * as UTC while the admin intended local time. Wrapping via `Date →
         * toISOString()` makes the wire format unambiguous.
         */
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });

      /* The response now includes the server-generated (or echoed) bypass code. */
      const serverCode: string = result?.data?.entry?.bypassCode ?? code ?? "—";

      toast({
        title: "Added to whitelist",
        description: `Bypass code: ${serverCode} is active.`,
      });
      setIdentifier("");
      setLabel("");
      setBypassCode("");
      setExpiresAt("");
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Could not add whitelist entry."),
        variant: "destructive",
      });
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(entry: OtpWhitelistEntry) {
    try {
      await updateEntry.mutateAsync({ id: entry.id, isActive: !entry.isActive });
      toast({
        title: entry.isActive
          ? "Whitelist entry disabled"
          : "Whitelist entry enabled",
        description: entry.identifier,
      });
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Could not update whitelist entry."),
        variant: "destructive",
      });
    }
  }

  function handleDelete(id: string, entryIdentifier: string) {
    setPendingDelete({ id, identifier: entryIdentifier });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteEntry.mutateAsync(id);
      toast({ title: "Removed from whitelist" });
    } catch (e: unknown) {
      toast({
        title: "Error",
        description: errorMessage(e, "Could not delete entry."),
        variant: "destructive",
      });
    }
  }

  return (
    <Card>
      <SectionTitle
        icon={ListChecks}
        label="OTP Whitelist — Per-Identity Bypass"
        color="text-indigo-700"
      />
      <p className="text-xs text-muted-foreground mb-4">
        Phones or emails added here bypass real SMS. They accept the configured
        6-digit bypass code without sending a real OTP. Perfect for App Store
        reviewers and testers.
      </p>

      {/* Add form */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4 p-3 rounded-xl bg-muted/30 border">
        <Input
          className="rounded-xl h-9 text-sm"
          placeholder="Phone or email (identifier)"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <Input
          className="rounded-xl h-9 text-sm"
          placeholder="Label (e.g. Apple Reviewer)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          className="rounded-xl h-9 text-sm"
          placeholder="Bypass code (6 digits — blank = auto-generate)"
          value={bypassCode}
          onChange={(e) => setBypassCode(e.target.value)}
          maxLength={6}
        />
        <Input
          className="rounded-xl h-9 text-sm"
          type="datetime-local"
          placeholder="Expires (optional)"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
        />
        <div className="md:col-span-2">
          <Button
            size="sm"
            className="rounded-xl gap-1.5 w-full"
            onClick={handleAdd}
            disabled={adding}
          >
            {adding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}{" "}
            Add to Whitelist
          </Button>
        </div>
      </div>

      {/* Entries list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-6 text-sm text-muted-foreground">
          No whitelist entries yet.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-sm ${
                entry.isActive
                  ? "bg-indigo-50/50 border-indigo-200"
                  : "bg-muted/20 border-border opacity-60"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{entry.identifier}</p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {entry.label && (
                    <span className="text-xs text-muted-foreground">
                      {entry.label}
                    </span>
                  )}
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {entry.bypassCode}
                  </Badge>
                  {entry.expiresAt && (
                    <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                      <CalendarDays className="w-3 h-3" />
                      {new Date(entry.expiresAt) < new Date()
                        ? "Expired"
                        : `Expires ${new Date(entry.expiresAt).toLocaleDateString()}`}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {entry.isActive ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-gray-400" />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs rounded-lg"
                  onClick={() => handleToggle(entry)}
                >
                  {entry.isActive ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-lg text-red-500 hover:bg-red-50"
                  onClick={() => handleDelete(entry.id, entry.identifier)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="mt-3 text-xs"
        onClick={() => refetch()}
      >
        <RefreshCw className="w-3 h-3 mr-1" /> Refresh
      </Button>

      {/* Delete confirmation dialog — replaces window.confirm() (R-6) */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from whitelist?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{" "}
              <span className="font-semibold">{pendingDelete?.identifier}</span>{" "}
              from the OTP whitelist. They will be required to use real OTPs for
              future logins.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDelete(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={confirmDelete}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   GENERATE OTP SECTION (R-8)
   ───────────────────────────────────────────────────────────────────────────── */

function GenerateOtpSection() {
  const { toast } = useToast();
  const generate = useAdminGenerateOtp();
  const [identifier, setIdentifier] = useState("");
  const [result, setResult] = useState<GenerateOtpResult | null>(null);

  async function handleGenerate() {
    if (!identifier.trim()) {
      toast({ title: "Identifier required", description: "Enter a userId, phone, or email.", variant: "destructive" });
      return;
    }
    try {
      const res = await generate.mutateAsync({ identifier: identifier.trim() });
      setResult(res);
      toast({ title: "OTP Generated", description: `OTP for ${res.phone ?? res.email ?? res.userId} is ready.` });
    } catch (e: unknown) {
      toast({ title: "Error", description: errorMessage(e, "Could not generate OTP."), variant: "destructive" });
    }
  }

  return (
    <Card>
      <SectionTitle icon={KeyRound} label="Generate OTP for User" color="text-teal-700" />
      <p className="text-xs text-muted-foreground mb-4">
        Generate a fresh OTP for any user. The code is displayed here so you can share it with the user directly — useful when SMS delivery fails.
      </p>

      <div className="flex gap-2 mb-4">
        <Input
          className="flex-1 text-sm"
          placeholder="userId, phone, or email"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            setResult(null);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") handleGenerate(); }}
        />
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={generate.isPending || !identifier.trim()}
          className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white shrink-0"
        >
          {generate.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <KeyRound className="w-3.5 h-3.5" />
          )}
          Generate
        </Button>
      </div>

      {result && (
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-teal-700 font-medium">User</p>
            <p className="text-sm font-semibold text-foreground">
              {result.name ?? result.phone ?? result.email ?? result.userId}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-xs text-teal-700 font-medium">OTP Code</p>
            <p className="font-mono text-2xl font-bold tracking-widest text-teal-800 bg-white border border-teal-300 rounded-lg px-4 py-1">
              {result.otp}
            </p>
          </div>
          <p className="text-[10px] text-teal-600">
            Expires: {fmtDate(result.expiresAt)}
          </p>
        </div>
      )}
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   VERIFY OTP SECTION (R-8 + C-2)
   ───────────────────────────────────────────────────────────────────────────── */

function VerifyOtpSection() {
  const { toast } = useToast();
  const verify = useAdminVerifyOtp();
  const [identifier, setIdentifier] = useState("");
  const [otp, setOtp] = useState("");
  const [result, setResult] = useState<VerifyOtpResult | null>(null);

  async function handleVerify() {
    if (!identifier.trim()) {
      toast({ title: "Identifier required", description: "Enter a userId, phone, or email.", variant: "destructive" });
      return;
    }
    if (!otp.trim()) {
      toast({ title: "OTP required", variant: "destructive" });
      return;
    }
    try {
      const res = await verify.mutateAsync({ identifier: identifier.trim(), otp: otp.trim() });
      setResult(res);
    } catch (e: unknown) {
      toast({ title: "Error", description: errorMessage(e, "Could not verify OTP."), variant: "destructive" });
    }
  }

  return (
    <Card>
      <SectionTitle icon={ShieldCheck} label="Verify OTP" color="text-violet-700" />
      <p className="text-xs text-muted-foreground mb-4">
        Check whether an OTP code is valid for a given user without consuming it. Useful for debugging authentication issues.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
        <Input
          className="text-sm"
          placeholder="userId, phone, or email"
          value={identifier}
          onChange={(e) => { setIdentifier(e.target.value); setResult(null); }}
        />
        <Input
          className="text-sm font-mono"
          placeholder="OTP code (4–8 digits)"
          value={otp}
          onChange={(e) => { setOtp(e.target.value); setResult(null); }}
          maxLength={8}
          onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
        />
      </div>

      <Button
        size="sm"
        onClick={handleVerify}
        disabled={verify.isPending || !identifier.trim() || !otp.trim()}
        className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white mb-4"
      >
        {verify.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <ShieldCheck className="w-3.5 h-3.5" />
        )}
        Verify OTP
      </Button>

      {result !== null && (
        <div
          className={`rounded-xl border p-4 space-y-1.5 ${
            result.valid
              ? "bg-green-50 border-green-200"
              : "bg-red-50 border-red-200"
          }`}
        >
          <div className="flex items-center gap-2">
            {result.valid ? (
              <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-red-500 shrink-0" />
            )}
            <p className={`text-sm font-bold ${result.valid ? "text-green-800" : "text-red-800"}`}>
              {result.valid ? "OTP is valid" : "OTP is invalid"}
            </p>
          </div>
          {!result.valid && result.reason && (
            <p className="text-xs text-red-700 pl-7">{result.reason}</p>
          )}
          {result.name || result.phone || result.email ? (
            <p className="text-xs text-muted-foreground pl-7">
              User: {result.name ?? result.phone ?? result.email}
            </p>
          ) : null}
          {result.expiresAt && (
            <p className="text-xs text-muted-foreground pl-7">
              Expires: {fmtDate(result.expiresAt)}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}