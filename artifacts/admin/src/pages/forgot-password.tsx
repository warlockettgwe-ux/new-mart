/**
 * Public "Forgot password?" page.
 * Posts the email to /api/admin/auth/forgot-password and always shows the
 * same generic confirmation regardless of whether the email exists. The
 * server-side rate limiter handles abuse.
 */
import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, Mail, AlertCircle } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
});

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  function validateEmail(value: string): string | null {
    const result = forgotPasswordSchema.safeParse({ email: value });
    if (result.success) return null;
    return result.error.flatten().fieldErrors.email?.[0] ?? null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fieldErr = validateEmail(email);
    setEmailError(fieldErr);
    setTouched(true);
    if (fieldErr) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!response.ok && response.status !== 200) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 400 && data?.error) {
          setError(String(data.error));
        } else {
          setSubmitted(true);
        }
      } else {
        setSubmitted(true);
      }
    } catch (err) {
      console.error("[forgot-password] network error:", err);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-card border rounded-2xl shadow-xl p-8">
          <div className="mb-6">
            <Link href="/login">
              <a className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-to-login">
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back to sign in
              </a>
            </Link>
          </div>

          <h1 className="text-2xl font-bold mb-2">Reset your password</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Enter the email associated with your admin account and we'll email
            you a single-use link to choose a new password. The link expires in
            30 minutes.
          </p>

          {submitted ? (
            <div className="space-y-4 text-center" data-testid="forgot-password-confirmation">
              <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
              </div>
              <h2 className="text-lg font-semibold">Check your email</h2>
              <p className="text-sm text-muted-foreground">
                If <span className="font-medium">{email}</span> matches an admin
                account, a password reset link has been sent. It expires in 30
                minutes and can only be used once.
              </p>
              <Link href="/login">
                <Button variant="outline" className="w-full" data-testid="button-back-to-login">
                  Return to sign in
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="email">
                  Email
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <Input
                    id="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (touched) setEmailError(validateEmail(e.target.value));
                    }}
                    onBlur={() => {
                      setTouched(true);
                      setEmailError(validateEmail(email));
                    }}
                    aria-invalid={!!emailError}
                    aria-describedby={emailError ? "email-error" : undefined}
                    placeholder="you@example.com"
                    className={`pl-9 h-11${emailError ? " border-destructive" : ""}`}
                    data-testid="input-forgot-email"
                  />
                </div>
                {emailError && (
                  <p id="email-error" className="flex items-center gap-1 text-sm text-destructive" role="alert">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {emailError}
                  </p>
                )}
              </div>

              {error && (
                <p className="text-sm text-destructive" data-testid="text-forgot-error">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                className="w-full h-11"
                disabled={submitting}
                data-testid="button-send-reset-link"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Send reset link
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </>
                )}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
