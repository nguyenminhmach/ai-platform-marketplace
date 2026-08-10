"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { CREDIT_PACKAGES } from "@/lib/mock-wallet";
import { Footer } from "@/components/Footer";
import { ThemeToggle } from "@/components/ThemeToggle";

type TxRow = {
  id: number;
  amount: number;
  type: "topup" | "usage" | "refund" | "bonus";
  mini_app_id: string | null;
  created_at: string;
};

const TYPE_LABEL: Record<TxRow["type"], string> = {
  topup: "Nạp credit",
  usage: "Sử dụng",
  refund: "Hoàn credit",
  bonus: "Thưởng",
};

const FILTERS: Array<{ key: TxRow["type"] | "tat-ca"; label: string }> = [
  { key: "tat-ca", label: "Tất cả" },
  { key: "topup", label: "Nạp credit" },
  { key: "usage", label: "Sử dụng" },
  { key: "refund", label: "Hoàn credit" },
  { key: "bonus", label: "Thưởng" },
];

function formatVnd(amount: number) {
  return amount.toLocaleString("vi-VN") + "đ";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type OrderInfo = {
  orderCode: string;
  qrUrl: string;
  amountVnd: number;
  credits: number;
};

type SubOrderInfo = {
  orderCode: string;
  qrUrl: string;
  amountVnd: number;
  durationDays: number;
};

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export default function WalletPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<TxRow[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [filter, setFilter] = useState<TxRow["type"] | "tat-ca">("tat-ca");
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [orderPaid, setOrderPaid] = useState(false);

  const [subscriptionEnabled, setSubscriptionEnabled] = useState(false);
  const [subscriptionPriceVnd, setSubscriptionPriceVnd] = useState(0);
  const [subscriptionDurationDays, setSubscriptionDurationDays] = useState(30);
  const [subActive, setSubActive] = useState(false);
  const [subExpiresAt, setSubExpiresAt] = useState<string | null>(null);
  const [subOrder, setSubOrder] = useState<SubOrderInfo | null>(null);
  const [creatingSubOrder, setCreatingSubOrder] = useState(false);
  const [subOrderPaid, setSubOrderPaid] = useState(false);

  function loadSubscriptionStatus() {
    if (!user) return;
    fetch(`/api/subscription/status?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => {
        setSubActive(data.active);
        setSubExpiresAt(data.expiresAt);
      });
  }

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSubscriptionEnabled(data.subscriptionEnabled);
        setSubscriptionPriceVnd(data.subscriptionPriceVnd);
        setSubscriptionDurationDays(data.subscriptionDurationDays);
      })
      .catch(() => {});
    loadSubscriptionStatus();
  }, [user]);

  // Polling đơn gia hạn thuê bao — cùng pattern với đơn nạp credit
  useEffect(() => {
    if (!subOrder || subOrderPaid) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/subscription/status?orderCode=${subOrder.orderCode}`);
      const data = await res.json();
      if (data.status === "paid") {
        setSubOrderPaid(true);
        clearInterval(interval);
        loadSubscriptionStatus();
        window.dispatchEvent(new Event("balance-updated"));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [subOrder, subOrderPaid]);

  async function handleSubscribe() {
    if (!user) return;
    setCreatingSubOrder(true);
    try {
      const res = await fetch("/api/subscription/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Không tạo được đơn gia hạn");
        return;
      }
      setSubOrder(data);
      setSubOrderPaid(false);
    } finally {
      setCreatingSubOrder(false);
    }
  }

  function loadWallet() {
    if (!user) return;
    fetch(`/api/wallet?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => {
        setBalance(data.balance);
        setTransactions(data.transactions);
        setDataLoading(false);
      });
  }

  useEffect(loadWallet, [user]);

  // Polling — hỏi mỗi 3 giây xem đơn hàng đã được Sepay báo thanh toán chưa
  useEffect(() => {
    if (!order || orderPaid) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/topup/status?orderCode=${order.orderCode}`);
      const data = await res.json();
      if (data.status === "paid") {
        setOrderPaid(true);
        clearInterval(interval);
        loadWallet();
        window.dispatchEvent(new Event("balance-updated"));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [order, orderPaid]);

  async function handleSelectPackage(pkgId: string) {
    setSelectedPackage(pkgId);
    setOrder(null);
    setOrderPaid(false);
  }

  async function handleCheckout() {
    if (!user || !selectedPackage) return;
    setCreatingOrder(true);
    try {
      const res = await fetch("/api/topup/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, packageId: selectedPackage }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Không tạo được đơn hàng");
        return;
      }
      setOrder(data);
    } finally {
      setCreatingOrder(false);
    }
  }

  if (authLoading) return null;

  if (!user) {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">Anh cần đăng nhập để xem Ví.</p>
          <Link href="/login" className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
            Đăng nhập / Đăng ký
          </Link>
        </div>
      </div>
    );
  }

  const filteredTransactions = transactions.filter((tx) => filter === "tat-ca" || tx.type === filter);

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{user.email}</span>
            <button
              onClick={() => signOut()}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <section className="mb-10 rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Số dư hiện tại</p>
          <p className="my-2 text-4xl font-bold text-zinc-900 dark:text-zinc-50">
            {dataLoading ? "..." : (balance ?? 0).toLocaleString("vi-VN")}{" "}
            <span className="text-xl font-medium text-zinc-500 dark:text-zinc-400">credit</span>
          </p>
        </section>

        {subscriptionEnabled && (
          <section className="mb-12">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Gói không giới hạn
            </h2>
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              {subActive ? (
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-emerald-600 dark:text-emerald-400">Đang có gói không giới hạn</p>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      Hết hạn: {subExpiresAt ? formatDateShort(subExpiresAt) : "—"}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
                  Chạy không giới hạn mọi Mini App trong {subscriptionDurationDays} ngày, không cần lo hết credit.
                </p>
              )}

              <div className="mb-4 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                  {formatVnd(subscriptionPriceVnd)}
                </span>
                <span className="text-sm text-zinc-500 dark:text-zinc-400">/ {subscriptionDurationDays} ngày</span>
              </div>

              {!subOrder && (
                <button
                  onClick={handleSubscribe}
                  disabled={creatingSubOrder}
                  className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  {creatingSubOrder ? "Đang tạo đơn..." : subActive ? "Gia hạn thêm" : "Đăng ký gói không giới hạn"}
                </button>
              )}

              {subOrder && (
                <div className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
                  {subOrderPaid ? (
                    <div>
                      <p className="mb-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                        Kích hoạt thành công!
                      </p>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        Đã gia hạn thêm {subOrder.durationDays} ngày.
                      </p>
                      <button
                        onClick={() => setSubOrder(null)}
                        className="mt-4 rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                      >
                        Đóng
                      </button>
                    </div>
                  ) : (
                    <div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={subOrder.qrUrl}
                        alt={`Mã QR gia hạn đơn ${subOrder.orderCode}`}
                        className="mx-auto mb-4 w-56 rounded-lg border border-zinc-200 dark:border-zinc-700"
                      />
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        Quét mã bằng app ngân hàng — nội dung chuyển khoản đã tự điền sẵn mã đơn
                      </p>
                      <p className="mt-1 font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                        {subOrder.orderCode}
                      </p>
                      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{formatVnd(subOrder.amountVnd)}</p>
                      <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
                        Đang tự động kiểm tra thanh toán mỗi 3 giây...
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        <section className="mb-12">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Nạp thêm credit
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CREDIT_PACKAGES.map((pkg) => (
              <button
                key={pkg.id}
                onClick={() => handleSelectPackage(pkg.id)}
                className={`relative flex flex-col items-center rounded-xl border p-5 text-center transition-colors ${
                  selectedPackage === pkg.id
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    : "border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
                }`}
              >
                {pkg.isBestValue && (
                  <span className="absolute -top-3 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">
                    Phổ biến nhất
                  </span>
                )}
                <p className="mt-2 text-2xl font-bold">{pkg.credits.toLocaleString("vi-VN")}</p>
                <p
                  className={`mb-3 text-xs ${
                    selectedPackage === pkg.id ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-500 dark:text-zinc-400"
                  }`}
                >
                  credit
                </p>
                <p className="text-lg font-semibold">{formatVnd(pkg.priceVnd)}</p>
              </button>
            ))}
          </div>

          {selectedPackage && !order && (
            <div className="mt-4 flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                Đã chọn gói{" "}
                <strong>
                  {CREDIT_PACKAGES.find((p) => p.id === selectedPackage)?.credits.toLocaleString("vi-VN")} credit
                </strong>
              </span>
              <button
                onClick={handleCheckout}
                disabled={creatingOrder}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {creatingOrder ? "Đang tạo đơn..." : "Thanh toán qua VietQR"}
              </button>
            </div>
          )}

          {order && (
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
              {orderPaid ? (
                <div>
                  <p className="mb-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                    Thanh toán thành công!
                  </p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Đã cộng {order.credits} credit vào Ví của anh.
                  </p>
                  <button
                    onClick={() => {
                      setOrder(null);
                      setSelectedPackage(null);
                    }}
                    className="mt-4 rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                  >
                    Đóng
                  </button>
                </div>
              ) : (
                <div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={order.qrUrl}
                    alt={`Mã QR thanh toán đơn ${order.orderCode}`}
                    className="mx-auto mb-4 w-56 rounded-lg border border-zinc-200 dark:border-zinc-700"
                  />
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Quét mã bằng app ngân hàng — nội dung chuyển khoản đã tự điền sẵn mã đơn
                  </p>
                  <p className="mt-1 font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                    {order.orderCode}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{formatVnd(order.amountVnd)}</p>
                  <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
                    Đang tự động kiểm tra thanh toán mỗi 3 giây...
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Lịch sử giao dịch
            </h2>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    filter === f.key
                      ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Loại</th>
                  <th className="px-4 py-3 font-medium">Mini App</th>
                  <th className="px-4 py-3 font-medium">Thời gian</th>
                  <th className="px-4 py-3 text-right font-medium">Số credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {dataLoading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                      Đang tải...
                    </td>
                  </tr>
                ) : filteredTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                      Không có giao dịch nào.
                    </td>
                  </tr>
                ) : (
                  filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="bg-white dark:bg-zinc-950">
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{TYPE_LABEL[tx.type]}</td>
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
      </main>
      <Footer />
    </div>
  );
}
