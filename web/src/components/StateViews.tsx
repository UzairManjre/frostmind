"use client";

// Shared empty/loading/error states (Prototype-to-Production plan §4: "The unglamorous 20% of
// the work that's most of what 'feels unfinished' actually comes from -- a blank fleet view, a
// failed API call, a slow load, all need a real state, not a blank screen"). Every data page
// (fleet, shipment detail, alerts, reports, analytics) renders through these three components
// instead of ad-hoc `<p>` tags, so "loading", "empty", and "error" look and behave the same
// everywhere.

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { BoxIcon } from "@/components/Icons";

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="panel flex flex-col items-center justify-center gap-4 p-12 text-dim">
      <div className="flex h-6 items-end gap-1" role="status" aria-label="Loading">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="w-1 animate-pulse rounded-full bg-gradient-to-t from-royal-500 to-peri-200"
            style={{ height: `${10 + ((i * 7) % 14)}px`, animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
      <p className="text-xs">{label}</p>
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-[4px] border border-dashed border-line-strong bg-white/[0.015] p-10 text-center">
      <span className="icon-tile mb-2 !h-10 !w-10 !bg-white/[0.06] text-peri-100/70">
        <BoxIcon className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-peri-50">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-faint">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
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
    <div className="flex flex-col items-center justify-center gap-2 rounded-[4px] border border-danger/30 bg-danger/[0.06] p-10 text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-[2px] bg-danger/15 text-danger">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" />
          <path d="M12 16h.01" />
        </svg>
      </span>
      <p className="text-sm font-medium text-peri-50">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-dim">{detail}</p>
      <div className="mt-3 flex gap-2">
        {status === 401 || status === 403 ? (
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            className="btn btn-primary btn-sm"
          >
            Log out and sign in again
          </button>
        ) : (
          onRetry && (
            <button onClick={onRetry} className="btn btn-ghost btn-sm">
              Retry
            </button>
          )
        )}
      </div>
    </div>
  );
}
