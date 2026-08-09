"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";

export function BalanceBadge() {
  const { user, loading } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;

    function fetchBalance() {
      fetch(`/api/wallet?userId=${user!.id}`)
        .then((res) => res.json())
        .then((data) => setBalance(data.balance));
    }

    fetchBalance();
    window.addEventListener("balance-updated", fetchBalance);
    return () => window.removeEventListener("balance-updated", fetchBalance);
  }, [user]);

  if (loading) return null;

  if (!user) {
    return (
      <Link
        href="/login"
        className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
      >
        Đăng nhập
      </Link>
    );
  }

  return (
    <Link
      href="/wallet"
      className="flex items-center gap-3 rounded-full border border-zinc-200 bg-zinc-50 px-4 py-2 text-sm hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
    >
      <span className="text-zinc-500 dark:text-zinc-400">Số dư:</span>
      <span className="font-semibold text-zinc-900 dark:text-zinc-50">
        {balance === null ? "..." : balance.toLocaleString("vi-VN")} credit
      </span>
    </Link>
  );
}
