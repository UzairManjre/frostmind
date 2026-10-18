"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { BellIcon, BoxIcon, ChartIcon, FileIcon, LogoutIcon, MenuIcon, SnowflakeIcon, TruckIcon } from "@/components/Icons";
import { Idx } from "@/components/ui";

const LINKS = [
  { href: "/", label: "Fleet", icon: TruckIcon },
  { href: "/alerts", label: "Alerts", icon: BellIcon },
  { href: "/analytics", label: "Analytics", icon: ChartIcon },
  { href: "/reports", label: "Reports", icon: FileIcon },
  { href: "/planner", label: "Load Planner", icon: BoxIcon },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/shipments");
  return pathname.startsWith(href);
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-[2px] bg-royal-500 text-white shadow-[0_0_24px_-4px_rgba(75,97,245,0.9)]">
        <SnowflakeIcon className="h-[18px] w-[18px]" />
      </span>
      <span className="leading-none">
        <span className="display block text-[1.45rem] font-normal tracking-wide text-white">FROSTMIND</span>
        <span className="mt-1 block text-[10px] text-faint">Cold-chain console</span>
      </span>
    </Link>
  );
}

export function NavBar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!user) return null;

  function handleLogout() {
    logout();
    router.push("/login");
  }

  const nav = (
    <ul className="space-y-1.5">
      {LINKS.map((link, i) => {
        const active = isActive(pathname, link.href);
        const Icon = link.icon;
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className={`group flex items-center gap-3 rounded-[3px] border px-3 py-2.5 text-[13px] transition-colors ${
                active
                  ? "border-white bg-white font-medium text-ink-950 shadow-[0_0_28px_-8px_rgba(140,160,255,0.9)]"
                  : "border-line text-peri-100/75 hover:border-line-strong hover:bg-white/[0.03] hover:text-white"
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? "text-royal-600" : "text-peri-100/50 group-hover:text-peri-100"}`} />
              <span className="flex-1">{link.label}</span>
              <Idx n={i + 1} className={active ? "!text-ink-950/50" : ""} />
            </Link>
          </li>
        );
      })}
    </ul>
  );

  const footer = (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] text-dim">
        <span className="live-dot" />
        Live &middot; auto-refreshing
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <div className="min-w-0">
          <p className="text-[10px] text-faint">Signed in as</p>
          <p className="truncate text-xs text-peri-100">{user.email}</p>
        </div>
        <button onClick={handleLogout} className="btn btn-ghost btn-sm !px-2" title="Log out" aria-label="Log out">
          <LogoutIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-ink-900/80 px-4 py-6 lg:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-royal-600/15 to-transparent" />
        <div className="relative px-1">
          <Brand />
        </div>
        <p className="relative mb-3 mt-10 px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Workspace</p>
        <nav className="relative">{nav}</nav>
        <div className="relative mt-auto px-1">{footer}</div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 border-b border-line bg-ink-900/90 px-5 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between">
          <Brand />
          <button
            onClick={() => setMobileOpen((o) => !o)}
            className="btn btn-ghost btn-sm !px-2"
            aria-label="Toggle navigation"
            aria-expanded={mobileOpen}
          >
            <MenuIcon className="h-4 w-4" />
          </button>
        </div>
        {mobileOpen && (
          <div className="mt-4 space-y-5 pb-2">
            <nav>{nav}</nav>
            {footer}
          </div>
        )}
      </header>
    </>
  );
}
