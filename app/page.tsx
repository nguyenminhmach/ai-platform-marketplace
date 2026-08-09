"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, MINI_APPS, type MiniApp } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { Footer } from "@/components/Footer";
import { Sidebar } from "@/components/Sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";

const CATEGORY_FILTERS: Array<{ key: MiniApp["category"] | "tat-ca"; label: string }> = [
  { key: "tat-ca", label: "Tất cả" },
  { key: "anh", label: "Ảnh" },
  { key: "van-ban", label: "Văn bản" },
  { key: "video", label: "Video" },
  { key: "am-thanh", label: "Âm thanh" },
];

const QUICK_CHIPS: Array<{ label: string; query: string }> = [
  { label: "Mô tả", query: "mô tả sản phẩm" },
  { label: "Tóm tắt", query: "tóm tắt văn bản" },
  { label: "Caption", query: "caption" },
  { label: "Dịch", query: "dịch" },
  { label: "Cảm xúc", query: "cảm xúc" },
];

export default function Home() {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MiniApp["category"] | "tat-ca">("tat-ca");
  const [signupBonusCredits, setSignupBonusCredits] = useState(20);
  const [promoBannerEnabled, setPromoBannerEnabled] = useState(true);
  const resultsRef = useRef<HTMLDivElement>(null);

  function runSearch(value: string) {
    setQuery(value);
    setCategory("tat-ca");
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSignupBonusCredits(data.signupBonusCredits);
        setPromoBannerEnabled(data.promoBannerEnabled);
      })
      .catch(() => {});
  }, []);

  const filteredApps = useMemo(() => {
    return MINI_APPS.filter((app) => {
      const matchesCategory = category === "tat-ca" || app.category === category;
      const matchesQuery =
        query.trim() === "" ||
        app.name.toLowerCase().includes(query.trim().toLowerCase()) ||
        app.description.toLowerCase().includes(query.trim().toLowerCase());
      return matchesCategory && matchesQuery;
    });
  }, [query, category]);

  const popularApps = MINI_APPS.filter((app) => app.popular);

  return (
    <div className="flex min-h-full bg-zinc-50 dark:bg-black">
      <Sidebar />

      <div className="min-w-0 flex-1">
        {/* Header + Ví credit */}
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 md:hidden">
              AI Marketplace
            </span>
            <div className="ml-auto flex items-center gap-3">
              <ThemeToggle />
              <BalanceBadge />
              {user && (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {user.email?.[0]?.toUpperCase() ?? "A"}
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-10">
        {/* Banner khuyến mãi */}
        {promoBannerEnabled && (
          <section className="mb-8 flex flex-col items-start justify-between gap-4 rounded-xl bg-emerald-50 px-6 py-5 dark:bg-emerald-950/30 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold text-emerald-800 dark:text-emerald-300">
                Tặng {signupBonusCredits} credit cho tài khoản mới
              </p>
              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                Đủ dùng thử 2-3 Mini App miễn phí, không cần thẻ
              </p>
            </div>
            {!user && (
              <Link
                href="/login"
                className="shrink-0 rounded-full border border-emerald-600 px-4 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-500 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
              >
                Đăng ký ngay
              </Link>
            )}
          </section>
        )}

        {/* Hero ngắn */}
        <section className="mb-10">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Hàng chục công cụ AI, trả tiền theo lượt dùng
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Chọn Mini App bên dưới, chạy ngay — không cần cài đặt gì thêm.
          </p>
        </section>

        {/* Ô tìm Mini App dạng chat */}
        <section className="mb-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query);
            }}
            className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ví dụ: tóm tắt đoạn văn bản này giúp tôi..."
              className="w-full bg-transparent px-2 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-50 dark:placeholder:text-zinc-500"
            />
            <div className="mt-2 flex items-center justify-end border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <button
                type="submit"
                aria-label="Tìm Mini App"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip.label}
                onClick={() => runSearch(chip.query)}
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-50"
              >
                {chip.label}
              </button>
            ))}
          </div>
        </section>

        {/* Bộ lọc danh mục */}
        <section className="mb-8 flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((filter) => (
            <button
              key={filter.key}
              onClick={() => setCategory(filter.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                category === filter.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </section>

        {/* Mini App phổ biến nhất — chỉ hiện khi không tìm kiếm/lọc */}
        {query.trim() === "" && category === "tat-ca" && (
          <section className="mb-10">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Phổ biến nhất
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {popularApps.map((app) => (
                <MiniAppCard key={app.id} app={app} />
              ))}
            </div>
          </section>
        )}

        {/* Toàn bộ danh mục (đã lọc) */}
        <section ref={resultsRef}>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Tất cả Mini App
          </h2>
          {filteredApps.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Không tìm thấy Mini App phù hợp.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredApps.map((app) => (
                <MiniAppCard key={app.id} app={app} />
              ))}
            </div>
          )}
        </section>
        </main>
        <Footer />
      </div>
    </div>
  );
}

const ICON_CONFIG: Record<
  MiniApp["icon"],
  { bg: string; iconColor: string; path: React.ReactNode }
> = {
  photo: {
    bg: "bg-rose-50 dark:bg-rose-950/40",
    iconColor: "text-rose-600 dark:text-rose-400",
    path: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="2" />
        <circle cx="9" cy="10" r="1.5" />
        <path d="M21 16l-5.5-5.5L7 19" />
      </>
    ),
  },
  "file-text": {
    bg: "bg-sky-50 dark:bg-sky-950/40",
    iconColor: "text-sky-600 dark:text-sky-400",
    path: (
      <>
        <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" />
        <path d="M14 3v6h6M9 13h6M9 17h6" />
      </>
    ),
  },
  caption: {
    bg: "bg-violet-50 dark:bg-violet-950/40",
    iconColor: "text-violet-600 dark:text-violet-400",
    path: <path d="M21 11.5a8.5 8.5 0 01-11.8 7.8L3 21l1.8-6A8.5 8.5 0 1121 11.5z" />,
  },
  translate: {
    bg: "bg-teal-50 dark:bg-teal-950/40",
    iconColor: "text-teal-600 dark:text-teal-400",
    path: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.4 2.6 3.6 5.7 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.7-3.6-9S9.6 5.6 12 3z" />
      </>
    ),
  },
  sentiment: {
    bg: "bg-amber-50 dark:bg-amber-950/40",
    iconColor: "text-amber-600 dark:text-amber-400",
    path: (
      <>
        <path d="M9 3H5a2 2 0 00-2 2v4M15 3h4a2 2 0 012 2v4M9 21H5a2 2 0 01-2-2v-4M15 21h4a2 2 0 002-2v-4" />
        <path d="M8 12h8" />
      </>
    ),
  },
  sparkles: {
    bg: "bg-fuchsia-50 dark:bg-fuchsia-950/40",
    iconColor: "text-fuchsia-600 dark:text-fuchsia-400",
    path: (
      <>
        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
        <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
      </>
    ),
  },
  film: {
    bg: "bg-indigo-50 dark:bg-indigo-950/40",
    iconColor: "text-indigo-600 dark:text-indigo-400",
    path: (
      <>
        <rect x="2" y="5" width="14" height="14" rx="2" />
        <path d="M16 10l6-3v10l-6-3" />
      </>
    ),
  },
};

function MiniAppCard({ app }: { app: MiniApp }) {
  const iconConfig = ICON_CONFIG[app.icon];

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <div className={`relative flex h-16 items-center justify-center ${iconConfig.bg}`}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-6 w-6 ${iconConfig.iconColor}`}
        >
          {iconConfig.path}
        </svg>
        {app.popular && (
          <span className="absolute right-2 top-2 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
            Hot
          </span>
        )}
        {app.isNew && (
          <span className="absolute right-2 top-2 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
            Mới
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <span className="mb-2 w-fit rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {CATEGORIES[app.category]}
        </span>
        <h3 className="mb-1 font-semibold text-zinc-900 dark:text-zinc-50">{app.name}</h3>
        <p className="mb-2 flex-1 text-sm text-zinc-600 dark:text-zinc-400">{app.description}</p>
        <div className="mb-4 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span>⭐ {app.rating}</span>
          <span>·</span>
          <span>{app.usageCount.toLocaleString("vi-VN")} lượt dùng</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {app.creditCost} credit
          </span>
          <Link
            href={`/mini-app/${app.id}`}
            className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Xem chi tiết
          </Link>
        </div>
      </div>
    </div>
  );
}
