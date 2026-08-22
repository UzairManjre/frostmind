"use client";

// Shared empty/loading/error states (Prototype-to-Production plan §4: "The unglamorous 20% of
// the work that's most of what 'feels unfinished' actually comes from -- a blank fleet view, a
// failed API call, a slow load, all need a real state, not a blank screen"). Every data page
// (fleet, shipment detail, alerts, reports, analytics) renders through these three components
// instead of ad-hoc `<p>` tags, so "loading", "empty", and "error" look and behave the same
// everywhere.

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-10 text-slate-400">
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-sky-400"
        role="status"
        aria-label="Loading"
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-800 bg-slate-900/20 p-10 text-center">
      <svg
        className="h-9 w-9 text-slate-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M3 12h18" strokeDasharray="2 2" />
      </svg>
      <p className="font-medium text-slate-300">{title}</p>
      {hint && <p className="max-w-sm text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Renders a specific message for a network-unreachable failure (ApiError status 0, see
 * lib/api.ts) vs. an expired/invalid session (401) vs. any other error, each with an
 * appropriate recovery action -- "silent failure" is explicitly what plan §4 calls out to avoid.
 */
export function ErrorState({
  error,
  status,
  onRetry,
}: {
  error: string;
  status?: number | null;
  onRetry?: () => void;
}) {
  const { logout } = useAuth();
  const router = useRouter();

  let title = "Something went wrong";
  let detail = error;
  if (status === 0) {
    title = "Backend unreachable";
    detail = error;
  } else if (status === 401 || status === 403) {
    title = "Session expired";
    detail = "Your admin session is no longer valid. Log in again to continue.";
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-red-900/50 bg-red-950/20 p-8 text-center">
      <svg
        className="h-8 w-8 text-red-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
      <p className="font-medium text-red-300">{title}</p>
      <p className="max-w-md text-sm text-red-400/80">{detail}</p>
      <div className="mt-2 flex gap-2">
        {status === 401 || status === 403 ? (
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            className="rounded bg-red-800 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700"
          >
            Log out and sign in again
          </button>
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="rounded border border-red-800 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-900/40"
            >
              Retry
            </button>
          )
        )}
      </div>
    </div>
  );
}
