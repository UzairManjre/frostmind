// REST client for the FROSTMIND backend (../backend). All admin-panel reads require a JWT
// (see backend/README.md "Auth boundaries"); the token is passed in explicitly rather than
// pulled from a module-level singleton so this stays usable from both client components and
// (if ever needed) server code without relying on browser globals at import time.

import type { Alert, AlertType, CategoryInfo, ComplianceReport, FleetAnalytics, FleetShipment, SensorReading, Shipment } from "./types";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, token: string | null, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    // fetch() itself threw (TypeError: Failed to fetch, DNS failure, connection refused, etc.)
    // -- this is the "backend unreachable" case the empty/loading/error-state work (plan §4)
    // needs to distinguish from an HTTP-level error, so it gets its own status code (0, never a
    // real HTTP status) rather than being indistinguishable from a generic thrown Error.
    throw new ApiError(0, `Could not reach ${API_BASE} -- is the backend running and reachable?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      // non-JSON error body -- fall back to statusText
    }
    throw new ApiError(res.status, detail);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res.text() as unknown as Promise<T>;
}

export async function login(email: string, password: string): Promise<{ access_token: string }> {
  return request("/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function fetchMe(token: string): Promise<{ id: string; email: string; role: string }> {
  return request("/auth/me", token);
}

export async function fetchFleet(token: string): Promise<FleetShipment[]> {
  return request("/shipments", token);
}

export async function fetchShipment(token: string, id: string): Promise<Shipment> {
  return request(`/shipments/${id}`, token);
}

export async function fetchReadings(token: string, id: string, limit = 500): Promise<SensorReading[]> {
  return request(`/shipments/${id}/readings?limit=${limit}`, token);
}

export async function fetchShipmentAlerts(token: string, id: string): Promise<Alert[]> {
  return request(`/shipments/${id}/alerts`, token);
}

export async function fetchAlerts(
  token: string,
  opts: { type?: AlertType; acknowledged?: boolean; limit?: number } = {}
): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.acknowledged !== undefined) params.set("acknowledged", String(opts.acknowledged));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request(`/alerts${qs ? `?${qs}` : ""}`, token);
}

export async function acknowledgeAlert(token: string, id: string, acknowledged = true): Promise<Alert> {
  return request(`/alerts/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify({ acknowledged }),
  });
}

export async function fetchCategories(token: string | null = null): Promise<CategoryInfo[]> {
  return request("/categories", token);
}

/** Downloads the shipment's CSV audit report as a Blob (needs the Authorization header, so a
 * plain <a href> can't be used directly -- the caller turns this into an object URL).
 */
export async function downloadShipmentReport(token: string, id: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/shipments/${id}/report`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, `Could not reach ${API_BASE} -- is the backend running and reachable?`);
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}

/** Updates a shipment's per-shipment alert threshold overrides (plan §4 "Configurable alert
 * thresholds"). `null` clears an override back to the category default; `undefined`/omitted
 * leaves that field untouched -- callers should always pass both fields explicitly (one of
 * number|null) rather than omitting one, since this app's threshold form always edits both
 * together.
 */
export async function updateShipmentThresholds(
  token: string,
  id: string,
  overrides: { alert_rate_threshold_override: number | null; alert_deviation_threshold_override: number | null }
): Promise<Shipment> {
  return request(`/shipments/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(overrides),
  });
}

/** Fleet-wide alert/shipment analytics over a trailing window (plan §4 "fleet-level
 * analytics/trends view"). Backend contract: GET /analytics/fleet?days=N, JWT-protected like the
 * other admin-read endpoints.
 */
export async function fetchFleetAnalytics(token: string, days = 30): Promise<FleetAnalytics> {
  return request(`/analytics/fleet?days=${days}`, token);
}

// LLM orchestration (FROSTMIND_LLM_Orchestration_Plan.md) Role B -- generated fresh on every
// call, not cached. A `narrative: null` response is a real, documented outcome (Ollama
// unreachable/timeout/malformed output), not an error to throw on -- the caller shows a
// "couldn't generate right now, try again" state, never fabricates text.
export async function generateComplianceReport(token: string, shipmentId: string): Promise<ComplianceReport> {
  return request(`/shipments/${shipmentId}/compliance_report`, token, { method: "POST" });
}
