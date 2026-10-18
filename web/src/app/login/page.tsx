"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { API_BASE } from "@/lib/api";
import { SnowflakeIcon } from "@/components/Icons";

// Light sign-in screen modelled on the brand deck's closing slide: white canvas, royal-blue
// streak columns, condensed display headline.
export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("admin@frostmind.local");
  // Pre-filled with the seeded default admin password in local dev only, so the demo is one click.
  const [password, setPassword] = useState(process.env.NODE_ENV === "development" ? "frostmind-admin" : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/");
    }
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "mt-1.5 h-11 w-full rounded-[3px] border border-ink-950/15 bg-white px-3.5 text-sm text-ink-950 transition placeholder:text-ink-950/35 focus:border-royal-500 focus:outline-none focus:ring-4 focus:ring-royal-500/15";

  return (
    <div className="relative min-h-screen overflow-hidden bg-white text-ink-950 [color-scheme:light]">
      <div className="streaks-light pointer-events-none absolute inset-y-0 right-0 w-full opacity-40 lg:w-[62%] lg:opacity-100" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-8 sm:px-10">
        <header className="rise flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[2px] bg-royal-600 text-white">
            <SnowflakeIcon className="h-4 w-4" />
          </span>
          <span className="display text-xl font-normal tracking-wide">FROSTMIND</span>
        </header>

        <div className="flex flex-1 items-center py-12">
          <div className="w-full max-w-md">
            <p className="rise text-xs font-medium text-ink-950/60" style={{ "--i": 1 } as React.CSSProperties}>
              Cold-chain fleet console
            </p>
            <h1 className="rise display mt-3 text-[3.4rem] sm:text-[4.2rem]" style={{ "--i": 2 } as React.CSSProperties}>
              Every degree,
              <br />
              accounted for.
            </h1>
            <p className="rise mt-4 max-w-sm text-[13px] leading-relaxed text-ink-950/55" style={{ "--i": 3 } as React.CSSProperties}>
              Sign in to monitor live temperature, shelf life and alerts across every truck in your fleet.
            </p>

            <form
              onSubmit={handleSubmit}
              className="rise mt-9 space-y-4 rounded-[4px] border border-ink-950/10 bg-white/85 p-6 shadow-[0_30px_60px_-30px_rgba(34,54,217,0.45)] backdrop-blur"
              style={{ "--i": 4 } as React.CSSProperties}
            >
              <label className="block text-xs font-medium text-ink-950/70">
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={inputCls} />
              </label>
              <label className="block text-xs font-medium text-ink-950/70">
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className={inputCls}
                />
              </label>
              {error && (
                <p className="rounded-[3px] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="flex h-11 w-full items-center justify-center rounded-[3px] bg-ink-950 text-sm font-medium text-white transition hover:bg-royal-600 disabled:opacity-50"
              >
                {submitting ? "Signing in..." : "Sign in"}
              </button>
              <p className="text-[11px] leading-relaxed text-ink-950/45">
                Default seeded admin: <span className="font-mono">admin@frostmind.local</span> /{" "}
                <span className="font-mono">frostmind-admin</span> (see backend/README.md)
              </p>
            </form>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-ink-950/45">
          <span>
            <span className="font-semibold tracking-wider">FROSTMIND</span>
            <span className="ml-3">Cold-chain AIoT monitoring</span>
          </span>
          <span className="font-mono" suppressHydrationWarning>API: {API_BASE}</span>
        </footer>
      </div>
    </div>
  );
}
