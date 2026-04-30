import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShoppingBag, Lock, Mail, ArrowRight, Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { z } from "zod";
import { useAdminAuth } from "@/lib/adminAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Login form schema — mirrors server-side validation rules.
 * Admin accounts may log in with either their email address or their username;
 * the server-side adminLogin service resolves both. The `email` field is
 * validated as a proper email address so the user gets instant feedback for
 * obvious typos before the request is ever sent.
 */
const loginSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required")
    .email("Please enter a valid email address"),
  password: z
    .string()
    .min(1, "Password is required")
    .min(8, "Password must be at least 8 characters"),
});

type LoginFields = z.infer<typeof loginSchema>;
type LoginErrors = Partial<Record<keyof LoginFields, string>>;

function parseLoginErrors(values: LoginFields): LoginErrors {
  const result = loginSchema.safeParse(values);
  if (result.success) return {};
  const flat = result.error.flatten().fieldErrors;
  return {
    email: flat.email?.[0],
    password: flat.password?.[0],
  };
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { state, login, clearError } = useAdminAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [errors, setErrors] = useState<LoginErrors>({});
  const [touched, setTouched] = useState({ email: false, password: false });

  const [totp, setTotp] = useState("");
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");

  useEffect(() => {
    if (state.user && state.accessToken) {
      setLocation("/dashboard");
    }
  }, [state.user, state.accessToken, setLocation]);

  useEffect(() => {
    if (state.error) {
      toast({
        title: "Login Error",
        description: state.error,
        variant: "destructive",
      });
      clearError();
    }
  }, [state.error, toast, clearError]);

  function validateField(field: keyof LoginFields, values: LoginFields) {
    const errs = parseLoginErrors(values);
    setErrors((prev) => ({ ...prev, [field]: errs[field] }));
  }

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const values: LoginFields = { email, password };
    const allErrors = parseLoginErrors(values);
    setErrors(allErrors);
    setTouched({ email: true, password: true });
    if (allErrors.email || allErrors.password) return;

    try {
      // The server login endpoint accepts email or username as the `username` field
      await login(email.trim().toLowerCase(), password);
      toast({ title: "Welcome back", description: "Successfully logged into admin panel." });
    } catch (err: any) {
      if (err.requiresMfa && err.tempToken) {
        setTempToken(err.tempToken);
        setStep("mfa");
        setTotp("");
        toast({ title: "MFA Required", description: "Please enter your authenticator code" });
      }
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totp.trim() || !tempToken) return;
    try {
      await login(email.trim().toLowerCase(), password, totp, tempToken);
      toast({ title: "Welcome back", description: "Successfully logged into admin panel." });
    } catch (_err) {
      // Handled by the error effect
    }
  };

  const handleBackToCredentials = () => {
    setStep("credentials");
    setTotp("");
    setTempToken(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <img
          src={`${import.meta.env.BASE_URL}images/login-bg.png`}
          alt="Background"
          className="w-full h-full object-cover opacity-40 mix-blend-overlay"
        />
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-blue-400/20 blur-[120px]" />
      </div>

      <div className="w-full max-w-md p-6 sm:p-8 z-10">
        <div className="bg-card rounded-3xl p-8 sm:p-10 shadow-2xl shadow-black/5 border border-border/50 animate-in zoom-in-95 duration-500">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-br from-primary to-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-primary/30">
              <ShoppingBag className="w-8 h-8 text-white" />
            </div>
            <h1 className="font-display text-3xl font-bold text-foreground">AJKMart Admin</h1>
            <p className="text-muted-foreground mt-2 font-medium">
              {step === "credentials" ? "Sign in with your email" : "Enter your authenticator code"}
            </p>
          </div>

          {step === "credentials" ? (
            <form onSubmit={handleCredentialsSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground ml-1" htmlFor="email">Email</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <Input
                    id="email"
                    type="email"
                    name="email"
                    inputMode="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (touched.email) validateField("email", { email: e.target.value, password });
                    }}
                    onBlur={() => {
                      setTouched((t) => ({ ...t, email: true }));
                      validateField("email", { email, password });
                    }}
                    aria-invalid={!!errors.email}
                    aria-describedby={errors.email ? "email-error" : undefined}
                    className={`pl-11 h-14 rounded-xl border-2 bg-background/50 focus:bg-background transition-colors text-lg${errors.email ? " border-destructive" : ""}`}
                    autoComplete="email"
                    autoFocus
                    disabled={state.isLoading}
                  />
                </div>
                {errors.email && (
                  <p id="email-error" className="flex items-center gap-1 text-sm text-destructive ml-1" role="alert">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {errors.email}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground ml-1" htmlFor="password">Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    name="password"
                    placeholder="Enter password..."
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (touched.password) validateField("password", { email, password: e.target.value });
                    }}
                    onBlur={() => {
                      setTouched((t) => ({ ...t, password: true }));
                      validateField("password", { email, password });
                    }}
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? "password-error" : undefined}
                    className={`pl-11 pr-12 h-14 rounded-xl border-2 bg-background/50 focus:bg-background transition-colors text-lg${errors.password ? " border-destructive" : ""}`}
                    autoComplete="current-password"
                    disabled={state.isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                {errors.password && (
                  <p id="password-error" className="flex items-center gap-1 text-sm text-destructive ml-1" role="alert">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {errors.password}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={state.isLoading}
                className="w-full h-14 rounded-xl text-base font-bold shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5 transition-all"
              >
                {state.isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </>
                )}
              </Button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setLocation("/forgot-password")}
                  className="text-sm font-medium text-primary hover:underline"
                  data-testid="link-forgot-password"
                >
                  Forgot password?
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleMfaSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground ml-1">Authenticator Code</label>
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="000000"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="h-14 rounded-xl border-2 bg-background/50 focus:bg-background transition-colors text-lg text-center font-mono tracking-widest"
                    autoComplete="off"
                    disabled={state.isLoading}
                    autoFocus
                    maxLength={6}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the 6-digit code from your authenticator app
                </p>
              </div>

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 h-12 rounded-xl"
                  onClick={handleBackToCredentials}
                  disabled={state.isLoading}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={state.isLoading || totp.length !== 6}
                  className="flex-1 h-12 rounded-xl font-bold shadow-lg shadow-primary/25"
                >
                  {state.isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      Verify
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </form>
          )}

          <p className="text-xs text-muted-foreground text-center mt-6 leading-relaxed">
            {step === "credentials" ? (
              <>
                Sign in with your admin email address.
                <br />
                Contact your system administrator if you need access.
              </>
            ) : (
              <>
                Don't have your authenticator code?
                <br />
                Contact your administrator for assistance.
              </>
            )}
          </p>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-8">
          AJKMart Admin © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
