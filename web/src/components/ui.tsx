// Shared layout primitives for the FROSTMIND design language (see globals.css): streak-band page
// heroes, glass/white stat cards, panels with numbered headers, segmented controls.

import type { ReactNode } from "react";

/** "(01)" style index label used across the UI. */
export function Idx({ n, className = "" }: { n: number; className?: string }) {
  return <span className={`idx ${className}`}>({String(n).padStart(2, "0")})</span>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
  variant = "royal",
  page,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  variant?: "royal" | "deep";
  /** Slide-style footer counter, e.g. [1, 4] renders "01 / 04". */
  page?: [number, number];
}) {
  return (
    <section
      className={`${variant === "royal" ? "streaks" : "streaks-deep"} relative overflow-hidden border-b border-line px-5 pb-6 pt-8 sm:px-8 lg:px-10 lg:pt-10`}
    >
      <div className="relative mx-auto max-w-7xl">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="rise max-w-2xl">
            <p className="eyebrow !text-peri-100/80">{eyebrow}</p>
            <h1 className="display mt-2 text-[2.75rem] text-white sm:text-[3.5rem]">{title}</h1>
            {description && <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-peri-100/70">{description}</p>}
          </div>
          {actions && (
            <div className="rise flex flex-wrap items-center gap-2" style={{ "--i": 1 } as React.CSSProperties}>
              {actions}
            </div>
          )}
        </div>
        {children && <div className="mt-8">{children}</div>}
        <div className="mt-8 flex items-center justify-between text-[10px] text-peri-100/45">
          <span>
            <span className="font-semibold tracking-wider">FROSTMIND</span>
            <span className="ml-3">Cold-chain fleet console</span>
          </span>
          {page && (
            <span className="font-mono">
              {String(page[0]).padStart(2, "0")} / {String(page[1]).padStart(2, "0")}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl space-y-6 px-5 py-8 sm:px-8 lg:px-10">{children}</div>;
}

/** Stat card from the brand deck: icon tile, big condensed number, fading label chip. */
export function StatCard({
  icon,
  value,
  label,
  hint,
  highlight = false,
  index = 0,
  children,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  hint?: ReactNode;
  highlight?: boolean;
  index?: number;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rise flex min-h-[176px] flex-col p-5 ${highlight ? "highlight" : "glass text-white"}`}
      style={{ "--i": index + 1 } as React.CSSProperties}
    >
      <span className="icon-tile">{icon}</span>
      <p className="display num mt-auto pt-6 text-[2.6rem]">{value}</p>
      <span className="chip-fade mt-2 self-start">{label}</span>
      {children}
      {hint && (
        <p className={`mt-2 text-[11px] leading-snug ${highlight ? "text-ink-950/60" : "text-peri-100/60"}`}>{hint}</p>
      )}
    </div>
  );
}

export function Panel({
  title,
  index,
  subtitle,
  action,
  children,
  className = "",
  bodyClassName = "p-5",
}: {
  title?: ReactNode;
  index?: number;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel rise ${className}`} style={index != null ? ({ "--i": index } as React.CSSProperties) : undefined}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4 sm:flex-nowrap">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              {index != null && <Idx n={index} />}
              <h2 className="text-sm font-medium text-peri-50">{title}</h2>
            </div>
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-faint">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  onDark = false,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  /** true when placed on a streak hero rather than a navy panel */
  onDark?: boolean;
}) {
  return (
    <div
      className={`inline-flex flex-wrap gap-1 rounded-[4px] p-1 ${
        onDark ? "border border-white/20 bg-white/5 backdrop-blur" : "border border-line bg-ink-950/60"
      }`}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`rounded-[2px] px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? "bg-white text-ink-950 shadow-[0_0_18px_-6px_rgba(140,160,255,0.9)]" : "text-peri-100/70 hover:text-white"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Thin progress bar coloured by how far along it is. */
export function Meter({ fraction, className = "" }: { fraction: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  const color = pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-gradient-to-r from-royal-400 to-peri-200";
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-white/10 ${className}`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(pct, 1.5)}%` }} />
    </div>
  );
}
