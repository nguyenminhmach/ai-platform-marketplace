"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CATEGORIES, MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";

export default function MiniAppDetailPage() {
  const params = useParams<{ id: string }>();
  const app = MINI_APPS.find((item) => item.id === params.id);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [textFileError, setTextFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  if (!app) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-600 dark:text-zinc-400">Không tìm thấy Mini App này.</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium underline">
          Quay lại Danh mục
        </Link>
      </div>
    );
  }

  const relatedApps = MINI_APPS.filter(
    (item) => item.category === app.category && item.id !== app.id
  ).slice(0, 3);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setImageError("Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleTextFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setTextFileError(null);
    if (!file.type.startsWith("text/") && !file.name.toLowerCase().endsWith(".txt")) {
      setTextFileError("Chỉ nhận file .txt");
      return;
    }
    if (file.size > 1 * 1024 * 1024) {
      setTextFileError("File tối đa 1MB, anh chọn file nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setInput(reader.result as string);
    reader.readAsText(file);
  }

  async function handleRun() {
    if (!user) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${app!.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, userId: user.id, imageDataUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.output);
      window.dispatchEvent(new Event("balance-updated"));
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
            ← Quay lại Danh mục
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Header Mini App */}
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {CATEGORIES[app.category]}
          </span>
          {app.popular && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              Hot
            </span>
          )}
          {app.isNew && (
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
              Mới
            </span>
          )}
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{app.name}</h1>
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">{app.description}</p>
        <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          <span>⭐ {app.rating}/5</span>
          <span>{app.usageCount.toLocaleString("vi-VN")} lượt đã chạy</span>
        </div>

        {/* Demo input/output mẫu — Tập 5 mục 1.2: cần thấy ví dụ thật trước khi bỏ credit ra thử */}
        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Ví dụ minh hoạ
          </h2>
          <div className="mb-3">
            <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Input mẫu</p>
            <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {app.demoInput}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả AI trả về</p>
            <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-300">
              {app.demoOutput}
            </p>
          </div>
        </section>

        {/* Khu vực nhập input thật + chạy */}
        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Thử ngay
          </h2>
          <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {app.inputLabel}
          </label>

          {app.inputType === "image" ? (
            <div className="mb-4">
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để chọn ảnh sản phẩm
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : app.inputType === "image-gen" ? (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={3}
                className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Ảnh sản phẩm tham chiếu (không bắt buộc)
              </p>
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm tham chiếu đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để tải ảnh sản phẩm thật (tuỳ chọn)
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={4}
                className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <div className="mt-2 flex items-center gap-2">
                <label className="cursor-pointer text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Hoặc tải file .txt lên
                  <input type="file" accept=".txt,text/plain" onChange={handleTextFileChange} className="hidden" />
                </label>
                {textFileError && <p className="text-xs text-red-600 dark:text-red-400">{textFileError}</p>}
              </div>
            </div>
          )}

          {!user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ <strong className="text-zinc-900 dark:text-zinc-50">{app.creditCost} credit</strong>
              </span>
              <button
                onClick={handleRun}
                disabled={isRunning || (app.inputType === "image" ? !imageDataUrl : input.trim() === "")}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {runError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {app.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result} alt="Ảnh do AI tạo" className="w-full max-w-md rounded-lg" />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <div className="mt-3 flex gap-2">
                {app.outputType === "image" ? (
                  <a
                    href={result}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Tải xuống
                  </a>
                ) : (
                  <button className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                    Tải xuống
                  </button>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setInput("");
                    setImageDataUrl(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Gợi ý Mini App liên quan — Tập 5 mục 4.1 */}
        {relatedApps.length > 0 && (
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Mini App liên quan
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {relatedApps.map((related) => (
                <Link
                  key={related.id}
                  href={`/mini-app/${related.id}`}
                  className="rounded-xl border border-zinc-200 bg-white p-4 text-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-50">{related.name}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{related.creditCost} credit</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
