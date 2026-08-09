"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Stats = {
  userCount: number;
  totalRevenueVnd: number;
  totalCreditsSold: number;
  totalCreditsUsed: number;
  paidOrderCount: number;
  recentTransactions: {
    id: number;
    user_id: string;
    amount: number;
    type: string;
    mini_app_id: string | null;
    created_at: string;
  }[];
  recentUsers: { user_id: string; credit_balance: number; created_at: string }[];
};

const TYPE_LABEL: Record<string, string> = {
  topup: "Nạp credit",
  usage: "Sử dụng",
  refund: "Hoàn credit",
  bonus: "Thưởng",
};

function formatVnd(amount: number) {
  return amount.toLocaleString("vi-VN") + "đ";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string) {
  return id.slice(0, 8) + "...";
}

type Settings = { signupBonusCredits: number; promoBannerEnabled: boolean };

export default function AdminPage() {
  const [authState, setAuthState] = useState<"checking" | "loggedOut" | "loggedIn">("checking");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  async function loadStats() {
    const res = await fetch("/api/admin/stats");
    if (res.status === 401) {
      setAuthState("loggedOut");
      return;
    }
    const data = await res.json();
    setStats(data);
    setAuthState("loggedIn");
  }

  async function loadSettings() {
    const res = await fetch("/api/admin/settings");
    if (!res.ok) return;
    const data = await res.json();
    setSettings(data);
  }

  useEffect(() => {
    loadStats();
    loadSettings();
  }, []);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    setSettingsSaved(false);
    setSettingsError(null);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSavingSettings(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setSettingsError(data.error ?? "Không lưu được cấu hình");
      return;
    }
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setLoginError("Sai mật khẩu");
      return;
    }
    setPassword("");
    loadStats();
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setStats(null);
    setAuthState("loggedOut");
  }

  if (authState === "checking") return null;

  if (authState === "loggedOut") {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-6 dark:bg-black">
        <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="mb-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">Trang quản trị</h1>
          <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">Nhập mật khẩu để xem dashboard.</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mật khẩu quản trị"
                className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 pr-10 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
            </div>
            {loginError && <p className="text-sm text-red-600 dark:text-red-400">{loginError}</p>}
            <button
              type="submit"
              className="w-full rounded-full bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Đăng nhập
            </button>
          </form>
          <Link href="/" className="mt-4 block text-center text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500">
            ← Quay lại Danh mục
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Trang quản trị</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              ← Danh mục
            </Link>
            <button onClick={handleLogout} className="text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              Đăng xuất
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {!stats ? (
          <p className="text-zinc-500 dark:text-zinc-400">Đang tải...</p>
        ) : (
          <>
            <section className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Tổng người dùng" value={stats.userCount.toLocaleString("vi-VN")} />
              <StatCard label="Doanh thu (đã thanh toán)" value={formatVnd(stats.totalRevenueVnd)} />
              <StatCard label="Credit đã bán" value={stats.totalCreditsSold.toLocaleString("vi-VN")} />
              <StatCard label="Credit đã dùng" value={stats.totalCreditsUsed.toLocaleString("vi-VN")} />
            </section>

            <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Cấu hình
              </h2>
              {!settings ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải...</p>
              ) : (
                <form onSubmit={handleSaveSettings} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      Credit tặng khi đăng ký
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={settings.signupBonusCredits}
                      onChange={(e) => setSettings({ ...settings, signupBonusCredits: Number(e.target.value) })}
                      className="w-40 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                  <label className="flex items-center gap-2 pb-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      checked={settings.promoBannerEnabled}
                      onChange={(e) => setSettings({ ...settings, promoBannerEnabled: e.target.checked })}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
                    />
                    Hiện banner khuyến mãi trên trang chủ
                  </label>
                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {savingSettings ? "Đang lưu..." : "Lưu cấu hình"}
                  </button>
                  {settingsSaved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Đã lưu ✓</span>}
                  {settingsError && <span className="text-sm text-red-600 dark:text-red-400">{settingsError}</span>}
                </form>
              )}
            </section>

            <section className="mb-10">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Giao dịch gần đây
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Loại</th>
                      <th className="px-4 py-3 font-medium">User</th>
                      <th className="px-4 py-3 font-medium">Mini App</th>
                      <th className="px-4 py-3 font-medium">Thời gian</th>
                      <th className="px-4 py-3 text-right font-medium">Credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {stats.recentTransactions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                          Chưa có giao dịch nào.
                        </td>
                      </tr>
                    ) : (
                      stats.recentTransactions.map((tx) => (
                        <tr key={tx.id} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{TYPE_LABEL[tx.type] ?? tx.type}</td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{shortId(tx.user_id)}</td>
                          <td className="px-4 py-3 text-zinc-900 dark:text-zinc-50">{tx.mini_app_id ?? "—"}</td>
                          <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{formatDate(tx.created_at)}</td>
                          <td
                            className={`px-4 py-3 text-right font-medium ${
                              tx.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-900 dark:text-zinc-50"
                            }`}
                          >
                            {tx.amount > 0 ? "+" : ""}
                            {tx.amount}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Người dùng gần đây
              </h2>
              <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">User ID</th>
                      <th className="px-4 py-3 font-medium">Ngày tham gia</th>
                      <th className="px-4 py-3 text-right font-medium">Số dư credit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {stats.recentUsers.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                          Chưa có người dùng nào.
                        </td>
                      </tr>
                    ) : (
                      stats.recentUsers.map((u) => (
                        <tr key={u.user_id} className="bg-white dark:bg-zinc-950">
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">{shortId(u.user_id)}</td>
                          <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{formatDate(u.created_at)}</td>
                          <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                            {u.credit_balance.toLocaleString("vi-VN")}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{value}</p>
    </div>
  );
}
