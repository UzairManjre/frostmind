"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const LINKS = [
  { href: "/", label: "Fleet" },
  { href: "/alerts", label: "Alerts" },
  { href: "/analytics", label: "Analytics" },
  { href: "/reports", label: "Reports" },
  { href: "/planner", label: "Load Planner" },
];

export function NavBar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  if (!user) return null;

  return (
    <nav className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-6 py-3">
      <div className="flex items-center gap-6">
        <span className="font-semibold tracking-tight text-sky-300">FROSTMIND admin</span>
        <div className="flex gap-4">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm ${
                pathname === link.href ? "text-white font-medium" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm text-slate-400">
        <span>{user.email}</span>
        <button
          onClick={() => {
            logout();
            router.push("/login");
          }}
          className="rounded border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
        >
          Log out
        </button>
      </div>
    </nav>
  );
}
