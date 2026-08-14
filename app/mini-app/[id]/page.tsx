"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/lib/auth-context";

export default function MiniAppDetailPage() {
  const params = useParams<{ id: string }>();
  const app = MINI_APPS.find((item) => item.id === params.id);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  const [textFileError, setTextFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveCreditCost, setLiveCreditCost] = useState<number | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // "Thay trang phục": imageDataUrl dùng chung làm ảnh người mẫu, garmentImages là danh sách trang phục
  // tham chiếu riêng (tối đa 10) — kết quả trả về nhiều ảnh nên dùng state riêng, không dùng chung `result`.
  const [garmentImages, setGarmentImages] = useState<string[]>([]);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  type OutfitSwapModel = {
    key: "generic" | "fashn" | "fashn_max";
    label: string;
    pricePerImage: number;
    hasPrompt: boolean;
    defaultPrompt?: string;
  };
  const [outfitSwapModels, setOutfitSwapModels] = useState<OutfitSwapModel[]>([]);
  const [outfitSwapModelChoice, setOutfitSwapModelChoice] = useState<"generic" | "fashn" | "fashn_max" | null>(null);
  const [outfitSwapResults, setOutfitSwapResults] = useState<string[] | null>(null);
  const [outfitSwapStatusText, setOutfitSwapStatusText] = useState<string | null>(null);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (params.id === "thay-trang-phuc") {
      fetch("/api/outfit-swap")
        .then((res) => res.json())
        .then((data) => {
          const models: OutfitSwapModel[] = data.models ?? [];
          setOutfitSwapModels(models);
          // Mặc định FASHN nếu có bật, không thì lấy model còn lại đang bật
          const fashn = models.find((m) => m.key === "fashn");
          const defaultModel = fashn ?? models[0];
          setOutfitSwapModelChoice(defaultModel?.key ?? null);
          if (defaultModel?.defaultPrompt) setInput(defaultModel.defaultPrompt);
        })
        .catch(() => {});
    }
  }, [params.id]);

  // Ảnh/video có giá tính động theo chi phí thật + biên lợi nhuận, khác app text (giá cố định)
  useEffect(() => {
    if (params.id) {
      fetch(`/api/mini-app/${params.id}/price`)
        .then((res) => res.json())
        .then((data) => {
          if (data.dynamic) setLiveCreditCost(data.creditCost);
        })
        .catch(() => {});
    }
  }, [params.id]);

  if (!app) {
    return <CommunityMiniAppRunner miniAppId={params.id} />;
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
    // "Thay trang phục" upload ảnh này lên Storage riêng trước khi chạy (xem handleRunOutfitSwap) —
    // cap 3MB thay vì 4MB vì base64 encode phình ~33%, 1 ảnh 4MB có thể tự vượt giới hạn request của Vercel.
    const maxBytes = app?.inputType === "outfit-swap" ? 3 * 1024 * 1024 : 4 * 1024 * 1024;
    if (file.size > maxBytes) {
      setImageError(
        app?.inputType === "outfit-swap"
          ? "Ảnh tối đa 3MB, anh chọn ảnh nhỏ hơn giúp em nhé"
          : "Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé"
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleGarmentFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setGarmentError(null);
    const remainingSlots = 10 - garmentImages.length;
    if (remainingSlots <= 0) {
      setGarmentError("Tối đa 10 ảnh trang phục");
      return;
    }

    const filesToAdd = files.slice(0, remainingSlots);
    filesToAdd.forEach((file) => {
      if (!file.type.startsWith("image/")) {
        setGarmentError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
        return;
      }
      if (file.size > 3 * 1024 * 1024) {
        setGarmentError("Mỗi ảnh tối đa 3MB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => setGarmentImages((prev) => [...prev, reader.result as string]);
      reader.readAsDataURL(file);
    });
  }

  function removeGarmentImage(index: number) {
    setGarmentImages((prev) => prev.filter((_, i) => i !== index));
  }

  function pollOutfitSwapStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults(data.outputs);
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Thay trang phục thất bại, credit đã được hoàn");
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else {
          setOutfitSwapStatusText(`Đang xử lý ${data.doneCount}/${data.totalItems} bộ đồ...`);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function uploadOutfitSwapImage(dataUrl: string): Promise<string> {
    const res = await fetch("/api/outfit-swap/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user!.id, dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Không tải được ảnh lên");
    return data.url as string;
  }

  async function handleRunOutfitSwap() {
    if (!user || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice) return;
    setIsRunning(true);
    setOutfitSwapResults(null);
    setRunError(null);
    setOutfitSwapStatusText("Đang tải ảnh lên...");

    // Upload từng ảnh lên Storage TRƯỚC — gửi thẳng base64 gộp 6-7 ảnh trong 1 request chạy AI dễ
    // vượt giới hạn ~4.5MB/request của Vercel, bị chặn 413 (đã xảy ra thật, lặp lại liên tục).
    // Chưa trừ credit ở bước này nên lỗi ở đây luôn an toàn để bấm thử lại.
    let modelImageUrl: string;
    let garmentImageUrls: string[];
    try {
      [modelImageUrl, ...garmentImageUrls] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        ...garmentImages.map(uploadOutfitSwapImage),
      ]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setIsRunning(false);
      setOutfitSwapStatusText(null);
      return;
    }

    setOutfitSwapStatusText("Đang gửi yêu cầu...");

    try {
      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: garmentImageUrls,
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setOutfitSwapStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setOutfitSwapStatusText(
        `Đang xử lý ${garmentImages.length} bộ đồ, có thể mất khoảng 1-2 phút — anh có thể rời trang, quay lại vẫn thấy kết quả...`
      );
      pollOutfitSwapStatus(data.jobId);
    } catch {
      // Server có thể đã submit job xong (và trừ credit) nhưng phản hồi bị rớt mạng trước khi về
      // tới trình duyệt — không chắc chắn là lượt chạy thất bại, nên không giục chạy lại ngay kẻo
      // bị trừ credit 2 lần cho cùng 1 lượt.
      setRunError(
        "Mất kết nối khi nhận phản hồi từ server. Lượt chạy có thể đã thực hiện thành công — anh kiểm tra /wallet → \"Lịch sử kết quả\" trước khi bấm chạy lại."
      );
      setIsRunning(false);
      setOutfitSwapStatusText(null);
    }
  }

  // Chạy lại riêng 1 ảnh kết quả sai — thay vì bắt chạy lại nguyên cả lượt (tốn thêm credit cho cả
  // những ảnh vốn đã đúng). AI đôi khi ra sai ngẫu nhiên trên cùng 1 ảnh đầu vào, chạy lại có thể ra kết quả khác.
  function pollRetryOutfitSwapStatus(jobId: number, index: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputs?.[0]) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults((prev) => {
            if (!prev) return prev;
            const next = [...prev];
            next[index] = data.outputs[0];
            return next;
          });
          setRetryingIndex(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Chạy lại thất bại, credit đã được hoàn");
          setRetryingIndex(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRetryOutfitSwapItem(index: number) {
    if (!user || !imageDataUrl || !outfitSwapModelChoice || retryingIndex !== null) return;
    const garmentDataUrl = garmentImages[index];
    if (!garmentDataUrl) return;

    setRetryingIndex(index);
    setRunError(null);

    try {
      const [modelImageUrl, garmentImageUrl] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        uploadOutfitSwapImage(garmentDataUrl),
      ]);

      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: [garmentImageUrl],
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setRetryingIndex(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      pollRetryOutfitSwapStatus(data.jobId, index);
    } catch {
      setRunError("Không tải được ảnh lên, thử lại");
      setRetryingIndex(null);
    }
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
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

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !app) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
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

        {/* Demo input/output mẫu — Tập 5 mục 1.2: cần thấy ví dụ thật trước khi bỏ credit ra thử.
            Bỏ riêng cho "thay-trang-phuc" — card trang chủ đã có ảnh minh hoạ trực quan hơn rồi, mục
            text ở đây thành thừa/rối cho app này (các app khác vẫn giữ). */}
        {app.inputType !== "outfit-swap" && (
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
        )}

        {/* Khu vực nhập input thật + chạy */}
        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Thử ngay
          </h2>
          {app.inputType !== "outfit-swap" && (
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {app.inputLabel}
            </label>
          )}

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
          ) : app.inputType === "video-gen" ? (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={3}
                className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh khung hình đầu (không bắt buộc)
                  </p>
                  {imageDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh khung hình đầu" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh khung hình cuối (không bắt buộc)
                  </p>
                  {endFrameDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh khung hình cuối" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>
            </div>
          ) : app.inputType === "outfit-swap" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh trang phục tham chiếu (tối đa 10)
                  </p>
                  <p className="mb-1 text-xs text-amber-600 dark:text-amber-500">
                    App chỉ áp dụng phần ÁO trong ảnh này — quần/váy sẽ giữ nguyên theo ảnh người mẫu gốc.
                  </p>
                  {garmentImages.length > 0 && (
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      {garmentImages.map((url, index) => (
                        <div key={index} className="relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`Trang phục ${index + 1}`} className="aspect-square w-full rounded-md object-cover" />
                          <button
                            onClick={() => removeGarmentImage(index)}
                            aria-label="Xoá ảnh"
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {garmentImages.length < 10 && (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        Bấm để thêm ảnh trang phục ({garmentImages.length}/10)
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — mỗi ảnh tối đa 3MB</span>
                      <input type="file" accept="image/*" multiple onChange={handleGarmentFilesChange} className="hidden" />
                    </label>
                  )}
                  {garmentError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{garmentError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh người mẫu</p>
                  <p className="mb-1 text-xs text-amber-600 dark:text-amber-500">
                    Nên chọn ảnh mặc áo + quần/váy RỜI (không phải váy liền thân) để kết quả chính xác hơn khi chỉ đổi áo.
                  </p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh người mẫu" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        aria-label="Xoá ảnh"
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh người mẫu</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
              </div>

              {outfitSwapModels.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {outfitSwapModels.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setOutfitSwapModelChoice(m.key)}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                        outfitSwapModelChoice === m.key
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                          : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                      }`}
                    >
                      {m.label} — {m.pricePerImage} credit/ảnh
                    </button>
                  ))}
                </div>
              )}

              {outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.hasPrompt && (
                <>
                  <p className="mb-1 mt-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">{app.inputLabel}</p>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </>
              )}
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

          {app.inputType === "outfit-swap" && !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : app.inputType === "outfit-swap" ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {(() => {
                  const pricePerImage = outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? 0;
                  return (
                    <>
                      Thao tác này sẽ trừ{" "}
                      <strong className="text-zinc-900 dark:text-zinc-50">
                        {pricePerImage * garmentImages.length} credit
                      </strong>{" "}
                      ({garmentImages.length} × {pricePerImage} credit)
                    </>
                  );
                })()}
              </span>
              <button
                onClick={handleRunOutfitSwap}
                disabled={isRunning || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          ) : !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">
                  {liveCreditCost ?? app.creditCost} credit
                </strong>
              </span>
              <button
                onClick={app.inputType === "video-gen" ? handleRunVideo : handleRun}
                disabled={isRunning || (app.inputType === "image" ? !imageDataUrl : input.trim() === "")}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>
          )}

          {outfitSwapStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{outfitSwapStatusText}</p>
          )}

          {runError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>
          )}

          {outfitSwapResults && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Kết quả từ AI ({outfitSwapResults.length} ảnh)
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {outfitSwapResults.map((url, index) => (
                  <div key={index}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Kết quả ${index + 1}`} className="aspect-square w-full rounded-lg object-cover" />
                    <div className="mt-1 flex items-center justify-center gap-2">
                      <a
                        href={url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        Tải xuống
                      </a>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <button
                        onClick={() => handleRetryOutfitSwapItem(index)}
                        disabled={retryingIndex !== null}
                        title={`Chạy lại ảnh này (trừ thêm ${outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? ""} credit)`}
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        {retryingIndex === index ? "Đang chạy lại..." : "Chạy lại ảnh này"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setOutfitSwapResults(null);
                  setGarmentImages([]);
                  setImageDataUrl(null);
                }}
                className="mt-3 rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
              >
                Chạy lại với ảnh khác
              </button>
            </div>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {app.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result} alt="Ảnh do AI tạo" className="w-full max-w-md rounded-lg" />
              ) : app.outputType === "video" ? (
                <video src={result} controls className="w-full max-w-md rounded-lg" />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <div className="mt-3 flex gap-2">
                {app.outputType === "image" || app.outputType === "video" ? (
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
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
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

type CommunityAppInfo = {
  id: string;
  name: string;
  description: string;
  category: string;
  creditCost: number;
  developerName: string | null;
  outputType: "text" | "image" | "video";
};

function CommunityMiniAppRunner({ miniAppId }: { miniAppId: string }) {
  const { user } = useAuth();
  const [appInfo, setAppInfo] = useState<CommunityAppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch(`/api/mini-apps/community/${miniAppId}`)
      .then((res) => res.json())
      .then((data) => setAppInfo(data.app ?? null))
      .finally(() => setLoading(false));
  }, [miniAppId]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

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
      setImageError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleRun() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${appInfo.id}`, {
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

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: appInfo.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  if (loading) {
    return <div className="min-h-full bg-zinc-50 dark:bg-black" />;
  }

  if (!appInfo) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-600 dark:text-zinc-400">Không tìm thấy Mini App này.</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium underline">
          Quay lại Danh mục
        </Link>
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
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {CATEGORIES[appInfo.category as keyof typeof CATEGORIES] ?? appInfo.category}
          </span>
          {appInfo.developerName && (
            <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-400">
              Cộng đồng
            </span>
          )}
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{appInfo.name}</h1>
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">{appInfo.description}</p>
        <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          {appInfo.developerName && <span>Tạo bởi {appInfo.developerName}</span>}
        </div>

        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Thử ngay
          </h2>
          <div className="mb-4">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={appInfo.outputType === "text" ? "Nhập nội dung..." : "Mô tả bối cảnh/nội dung muốn tạo..."}
              rows={appInfo.outputType === "text" ? 4 : 3}
              className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />

            {appInfo.outputType === "image" && (
              <>
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Ảnh tham chiếu (không bắt buộc)
                </p>
                {imageDataUrl ? (
                  <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageDataUrl} alt="Ảnh tham chiếu đã chọn" className="h-20 w-20 rounded-md object-cover" />
                    <button
                      onClick={() => setImageDataUrl(null)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Xóa ảnh
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh tham chiếu</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                )}
                {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
              </>
            )}

            {appInfo.outputType === "video" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình đầu (không bắt buộc)</p>
                  {imageDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh khung hình đầu" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình cuối (không bắt buộc)</p>
                  {endFrameDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh khung hình cuối" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>
            )}
          </div>

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
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">{appInfo.creditCost} credit</strong>
              </span>
              <button
                onClick={appInfo.outputType === "video" ? handleRunVideo : handleRun}
                disabled={isRunning || input.trim() === ""}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>}

          {runError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {appInfo.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result} alt="Ảnh do AI tạo" className="w-full max-w-md rounded-lg" />
              ) : appInfo.outputType === "video" ? (
                <video src={result} controls className="w-full max-w-md rounded-lg" />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <div className="mt-3 flex gap-2">
                {appInfo.outputType === "image" || appInfo.outputType === "video" ? (
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
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}
