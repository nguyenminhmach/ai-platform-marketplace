"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { MINI_APPS } from "@/lib/mock-mini-apps";

type TxRow = {
  id: number;
  amount: number;
  type: "topup" | "usage" | "refund" | "bonus";
  mini_app_id: string | null;
  created_at: string;
};

function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "hôm qua" : `${days} ngày trước`;
}

export function Sidebar() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [recentRuns, setRecentRuns] = useState<TxRow[]>([]);

  useEffect(() => {
    if (!user) {
      setRecentRuns([]);
      return;
    }
    fetch(`/api/wallet?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => {
        const usageRows: TxRow[] = (data.transactions ?? []).filter(
          (tx: TxRow) => tx.type === "usage"
        );
        setRecentRuns(usageRows.slice(0, 3));
      })
      .catch(() => {});
  }, [user]);

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-white px-4 py-5 dark:border-zinc-800 dark:bg-zinc-950 md:flex">
      <Link href="/" className="mb-6 flex items-center gap-2 px-1">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5 text-emerald-600 dark:text-emerald-400">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l7 3v6c0 4.5-3 8.3-7 9.5-4-1.2-7-5-7-9.5V5l7-3z" />
        </svg>
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">AI Marketplace</span>
      </Link>

      <nav className="mb-6 space-y-1">
        <Link
          href="/"
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            pathname === "/"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          Mini Apps
        </Link>

        <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 dark:text-zinc-600">
          <span className="flex items-center gap-2.5">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <rect x="4" y="8" width="16" height="12" rx="2" />
              <path d="M12 8V4m-3 0h6" />
              <circle cx="9" cy="14" r="1" />
              <circle cx="15" cy="14" r="1" />
            </svg>
            Agent của tôi
          </span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
            Sắp có
          </span>
        </div>

        <Link
          href="/wallet"
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            pathname === "/wallet"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" d="M12 7v5l3.5 2" />
          </svg>
          Lịch sử chạy
        </Link>
      </nav>

      {user && recentRuns.length > 0 && (
        <div className="space-y-3 border-t border-zinc-100 pt-4 dark:border-zinc-900">
          {recentRuns.map((tx) => {
            const app = MINI_APPS.find((a) => a.id === tx.mini_app_id);
            return (
              <Link
                key={tx.id}
                href={app ? `/mini-app/${app.id}` : "/wallet"}
                className="block rounded-lg px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <p className="truncate text-sm text-zinc-700 dark:text-zinc-300">
                  {app?.name ?? tx.mini_app_id}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {Math.abs(tx.amount)} credit · {relativeTime(tx.created_at)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </aside>
  );
}
