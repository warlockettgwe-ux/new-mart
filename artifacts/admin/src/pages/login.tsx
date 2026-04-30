import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShoppingBag, Lock, User, ArrowRight, Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { useAdminAuth } from "@/lib/adminAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function validateUsername(value: string): string | null {
  if (!value.trim()) return "Username is required";
  if (value.trim().length < 3) return "Username must be at least 3 characters";
  return null;
}

function validatePassword(value: string): string | null {
  if (!value) return "Password is required";
  if (value.length < 8) return "Password must be at least 8 characters";
  return null;
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { state, login, clearError } = useAdminAuth();
  const { toast } = useToast();

  // Credentials form
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Field-level validation errors (shown on blur or submit)
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [touched, setTouched] = useState({ username: false, password: false });

  // MFA form
  const [totp, setTotp] = useState("");
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");

  // Mount
  useEffect(() => {
    if (state.user && state.accessToken) {
      setLocation("/dashboard");
    }
  }, [state.user, state.accessToken, setLocation]);

  // Handle errors
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

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate all fields on submit
    const uErr = validateUsername(username);
    const pErr = validatePassword(password);
    setUsernameError(uErr);
    setPasswordError(pErr);
    setTouched({ username: true, password: true });
    if (uErr || pErr) return;

    try {
      await login(username.trim(), password);
      toast({ title: "Welcome back", description: "Successfully logged into admin panel." });
    } catch (err: any) {
      if (err.requiresMfa && err.tempToken) {
        // MFA required - switch to MFA step
        setTempToken(err.tempToken);
        setStep("mfa");
        setTotp("");
        toast({
          title: "MFA Required",
          description: "Please enter your authenticator code",
        });
      }
      // Other errors are handled by the error effect above
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totp.trim() || !tempToken) return;

    try {
      await login(username, password, totp, tempToken);
      toast({ title: "Welcome back", description: "Successfully logged into admin panel." });
    } catch (err: any) {
      // Error handled by effect
    }
  };

  const handleBackToCredentials = () => {
    setStep("credentials");
    setTotp("");
    setTempToken(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      {/* Background decoration */}
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
              {step === "credentials" ? "Sign in with your credentials" : "Enter your authenticator code"}
            </p>
          </div>

          {step === "credentials" ? (
            <form onSubmit={handleCredentialsSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground ml-1">Username</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <Input
                    type="text"
                    name="username"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (touched.username) setUsernameError(validateUsername(e.target.value));
                    }}
                    onBlur={() => {
                      setTouched((t) => ({ ...t, username: true }));
                      setUsernameError(validateUsername(username));
                    }}
                    aria-invalid={!!usernameError}
                    aria-describedby={usernameError ? "username-error" : undefined}
                    className={`pl-11 h-14 rounded-xl border-2 bg-background/50 focus:bg-background transition-colors text-lg${usernameError ? " border-destructive" : ""}`}
                    autoComplete="username"
                    autoFocus
                    disabled={state.isLoading}
                  />
                </div>
                {usernameError && (
                  <p id="username-error" className="flex items-center gap-1 text-sm text-destructive ml-1" role="alert">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {usernameError}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground ml-1">Password</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <Input
                    type={showPassword ? "text" : "password"}
                    name="password"
                    placeholder="Enter password..."
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (touched.password) setPasswordError(validatePassword(e.target.value));
                    }}
                    onBlur={() => {
                      setTouched((t) => ({ ...t, password: true }));
                      setPasswordError(validatePassword(password));
                    }}
                    aria-invalid={!!passwordError}
                    aria-describedby={passwordError ? "password-error" : undefined}
                    className={`pl-11 pr-12 h-14 rounded-xl border-2 bg-background/50 focus:bg-background transition-colors text-lg${passwordError ? " border-destructive" : ""}`}
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
                {passwordError && (
                  <p id="password-error" className="flex items-center gap-1 text-sm text-destructive ml-1" role="alert">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {passwordError}
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
                Default super admin: <span className="font-semibold">admin</span> /{" "}
                <span className="font-semibold">Toqeerkhan@123.com</span>.
                <br />
                You can update them from the post-login popup.
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
