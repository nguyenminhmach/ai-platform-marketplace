"use client";

import Link from "next/link";
import { useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Footer } from "@/components/Footer";

// Trang công khai, KHÔNG cần đăng nhập — mồi kéo traffic mới (dán link này lên Facebook Group/TikTok),
// tách khỏi luồng /mini-app/[id] (luồng đó bắt đăng nhập + trừ credit). Route API riêng
// /api/free-trial/remove-bg tự giới hạn theo IP+cookie, không đụng tới hệ thống credit.
export default function ThuMienPhiPage() {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    setResult(null);
    setRunError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setImageError("Ảnh tối đa 3MB, anh chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleRemoveBg() {
    if (!imageDataUrl) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch("/api/free-trial/remove-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.resultUrl);
    } catch {
      setRunError("Không kết nối được tới server");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← AI Marketplace
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/login"
              className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
            >
              Đăng nhập
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
          Miễn phí — không cần đăng ký
        </span>
        <h1 className="mb-2 mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Xoá nền ảnh sản phẩm</h1>
        <p className="mb-6 text-zinc-600 dark:text-zinc-400">
          Tải ảnh sản phẩm lên, AI tự động xoá nền, tải về ảnh nền trong suốt dùng ngay cho bài đăng bán hàng. Không cần
          tài khoản, không mất phí.
        </p>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh gốc</p>
              {imageDataUrl ? (
                <div className="relative aspect-square w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageDataUrl} alt="Ảnh gốc" className="h-full w-full rounded-lg object-cover" />
                  <button
                    onClick={() => {
                      setImageDataUrl(null);
                      setResult(null);
                    }}
                    className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                  >
                    Xóa
                  </button>
                </div>
              ) : (
                <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả</p>
              {result ? (
                <div
                  className="aspect-square w-full rounded-lg"
                  style={{
                    backgroundImage:
                      "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)",
                    backgroundSize: "16px 16px",
                    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result} alt="Kết quả đã xoá nền" className="h-full w-full rounded-lg object-contain" />
                </div>
              ) : (
                <div className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center text-xs text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500">
                  {isRunning ? "Đang xoá nền..." : "Kết quả sẽ hiện ở đây"}
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-zinc-400 dark:text-zinc-500">Tối đa 3 lượt miễn phí/ngày</p>
            <button
              onClick={handleRemoveBg}
              disabled={!imageDataUrl || isRunning}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {isRunning ? "Đang xử lý..." : "Xoá nền ngay"}
            </button>
          </div>
          {runError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{runError}</p>}

          {result && (
            <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <a
                href={`/api/download?url=${encodeURIComponent(result)}&filename=xoa-nen.png`}
                download
                className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
              >
                Tải xuống
              </a>
            </div>
          )}
        </div>

        <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
            Đây chỉ là 1 trong hàng chục Mini App AI trên nền tảng — tạo ảnh quảng cáo, thay trang phục, tạo video, viết
            caption... Đăng ký để nhận credit dùng thử miễn phí cho mọi tính năng.
          </p>
          <Link
            href="/login"
            className="inline-block rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
          >
            Đăng ký miễn phí
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
