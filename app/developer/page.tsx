"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { CATEGORIES, type MiniApp } from "@/lib/mock-mini-apps";
import { Footer } from "@/components/Footer";
import { ThemeToggle } from "@/components/ThemeToggle";

type Developer = {
  id: string;
  displayName: string;
  status: "pending" | "approved" | "suspended";
  revenueSharePct: number;
  createdAt: string;
};

type DevApp = {
  id: string;
  name: string;
  description: string;
  category: MiniApp["category"];
  credit_cost: number;
  review_status: "draft" | "pending_review" | "approved" | "rejected" | "suspended";
  created_at: string;
};

const REVIEW_STATUS_LABEL: Record<DevApp["review_status"], string> = {
  draft: "Bản nháp",
  pending_review: "Đang chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Bị từ chối",
  suspended: "Tạm ẩn",
};

const REVIEW_STATUS_COLOR: Record<DevApp["review_status"], string> = {
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  pending_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  suspended: "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
};

export default function DeveloperPage() {
  const { user, loading: authLoading } = useAuth();
  const [developer, setDeveloper] = useState<Developer | null>(null);
  const [devLoading, setDevLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [apps, setApps] = useState<DevApp[]>([]);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "van-ban" as MiniApp["category"],
    creditCost: 10,
    endpointUrl: "",
    apiKey: "",
  });

  function loadDeveloper() {
    if (!user) return;
    setDevLoading(true);
    fetch(`/api/developer/me?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => setDeveloper(data.developer))
      .finally(() => setDevLoading(false));
  }

  function loadApps() {
    if (!user) return;
    fetch(`/api/developer/mini-apps?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => setApps(data.apps ?? []));
  }

  useEffect(() => {
    loadDeveloper();
    loadApps();
  }, [user]);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setRegistering(true);
    setRegisterError(null);
    const res = await fetch("/api/developer/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, displayName }),
    });
    const data = await res.json();
    setRegistering(false);
    if (!res.ok) {
      setRegisterError(data.error ?? "Không đăng ký được");
      return;
    }
    loadDeveloper();
  }

  async function handleSubmitApp(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    setSubmitError(null);
    const res = await fetch("/api/developer/mini-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, ...form }),
    });
    const data = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setSubmitError(data.error ?? "Không nộp được Mini App");
      return;
    }
    setShowSubmitForm(false);
    setForm({ name: "", description: "", category: "van-ban", creditCost: 10, endpointUrl: "", apiKey: "" });
    loadApps();
  }

  if (authLoading || devLoading) return null;

  if (!user) {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">Anh cần đăng nhập để vào trang Nhà phát triển.</p>
          <Link href="/login" className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
            Đăng nhập / Đăng ký
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Nhà phát triển</h1>

        {!developer ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              Đăng ký làm nhà phát triển để tự tạo Mini App và ăn chia doanh thu trên mỗi lượt khách chạy app của anh.
            </p>
            <form onSubmit={handleRegister} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Tên hiển thị
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Tên nhà phát triển"
                  className="w-64 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                />
              </div>
              <button
                type="submit"
                disabled={registering || !displayName.trim()}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {registering ? "Đang gửi..." : "Đăng ký làm nhà phát triển"}
              </button>
            </form>
            {registerError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{registerError}</p>}
          </section>
        ) : (
          <>
            <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-zinc-900 dark:text-zinc-50">{developer.displayName}</p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    Ăn chia doanh thu: <strong>{developer.revenueSharePct}%</strong>
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    developer.status === "approved"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                      : developer.status === "pending"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                  }`}
                >
                  {developer.status === "approved" ? "Đã duyệt" : developer.status === "pending" ? "Đang chờ duyệt" : "Tạm khoá"}
                </span>
              </div>
              {developer.status === "pending" && (
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                  Tài khoản đang chờ admin duyệt — sau khi duyệt xong anh mới nộp Mini App được.
                </p>
              )}
            </section>

            {developer.status === "approved" && (
              <section className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Mini App của tôi
                  </h2>
                  <button
                    onClick={() => setShowSubmitForm((v) => !v)}
                    className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                  >
                    {showSubmitForm ? "Đóng" : "+ Nộp Mini App mới"}
                  </button>
                </div>

                {showSubmitForm && (
                  <form
                    onSubmit={handleSubmitApp}
                    className="mb-4 space-y-3 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Tên Mini App</label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Mô tả</label>
                      <textarea
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        rows={2}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Danh mục</label>
                        <select
                          value={form.category}
                          onChange={(e) => setForm({ ...form, category: e.target.value as MiniApp["category"] })}
                          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        >
                          {Object.entries(CATEGORIES).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">Giá đề xuất (credit)</label>
                        <input
                          type="number"
                          min={1}
                          value={form.creditCost}
                          onChange={(e) => setForm({ ...form, creditCost: Number(e.target.value) })}
                          className="w-32 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        Endpoint Workflow Dify (https://...)
                      </label>
                      <input
                        type="text"
                        value={form.endpointUrl}
                        onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
                        placeholder="https://api.dify.ai/v1/workflows/run"
                        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">API Key</label>
                      <input
                        type="password"
                        value={form.apiKey}
                        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      {submitting ? "Đang nộp..." : "Nộp để duyệt"}
                    </button>
                    {submitError && <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>}
                  </form>
                )}

                {apps.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Chưa nộp Mini App nào.</p>
                ) : (
                  <div className="space-y-2">
                    {apps.map((app) => (
                      <div
                        key={app.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        <div>
                          <p className="font-medium text-zinc-900 dark:text-zinc-50">{app.name}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            {CATEGORIES[app.category]} · {app.credit_cost} credit
                          </p>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-xs font-medium ${REVIEW_STATUS_COLOR[app.review_status]}`}>
                          {REVIEW_STATUS_LABEL[app.review_status]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
