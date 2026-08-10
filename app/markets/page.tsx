"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CATEGORIES, type MiniApp } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { Footer } from "@/components/Footer";
import { ThemeToggle } from "@/components/ThemeToggle";

type CommunityApp = {
  id: string;
  name: string;
  description: string;
  category: MiniApp["category"];
  creditCost: number;
  developerName: string;
};

export default function MarketsPage() {
  const [apps, setApps] = useState<CommunityApp[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/mini-apps/community")
      .then((res) => res.json())
      .then((data) => setApps(data.apps ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">Mini App từ Nhà phát triển</h1>
        <p className="mb-8 text-sm text-zinc-600 dark:text-zinc-400">
          Mini App do cộng đồng nhà phát triển bên thứ 3 xây dựng và vận hành.
        </p>

        {loading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
        ) : apps.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Chưa có Mini App nào từ nhà phát triển.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {apps.map((app) => (
              <Link
                key={app.id}
                href={`/mini-app/${app.id}`}
                className="flex flex-col rounded-xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="mb-2 w-fit rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {CATEGORIES[app.category]}
                </span>
                <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">{app.name}</h3>
                <p className="mb-2 flex-1 text-sm text-zinc-600 dark:text-zinc-400">{app.description}</p>
                <p className="mb-4 text-xs text-zinc-400 dark:text-zinc-500">Tạo bởi {app.developerName}</p>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{app.creditCost} credit</span>
                  <span className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                    Xem chi tiết
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
