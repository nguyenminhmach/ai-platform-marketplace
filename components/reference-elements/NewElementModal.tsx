"use client";

import { useRef, useState } from "react";

// Form "Yếu tố mới" — dùng chung cho app/reference-elements/page.tsx (trang quản lý kho tham chiếu)
// VÀ app/video-tu-y-tuong/page.tsx (mở từ modal "@" ngay trong luồng viết prompt). Tách ra khỏi
// app/reference-elements/page.tsx để 2 nơi không bị lệch nhau (sửa 1 chỗ, cả 2 cùng hưởng).
//
// So với bản gốc chỉ nằm trong app/reference-elements/page.tsx: thêm 2 hành vi theo wireframe
// "các yếu tố.PNG"/"22.PNG" — (1) ảnh ĐANG CHỌN làm ảnh tham chiếu CHÍNH có viền vàng nổi bật, bấm vào
// ảnh phụ bất kỳ sẽ đổi ảnh đó thành ảnh chính; (2) giới hạn tối đa MAX_IMAGES ảnh/yếu tố khi tạo mới.

export type ElementType = "character" | "location" | "prop";

export type ReferenceElement = {
  id: number;
  type: ElementType;
  name: string;
  element_id: string;
  description: string | null;
  image_urls: string[];
  created_at: string;
};

export const TYPE_LABEL: Record<ElementType, string> = {
  character: "Nhân vật",
  location: "Địa điểm",
  prop: "Đạo cụ",
};

// Khớp mục 7 trong spec: "Giới hạn hiện tại: tối đa 5 ảnh/yếu tố khi tạo mới (mở rộng sau nếu cần)".
const MAX_IMAGES = 5;

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function slugifyElementId(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function NewElementModal({
  onClose,
  onCreated,
  defaultType,
}: {
  onClose: () => void;
  onCreated: (el: ReferenceElement) => void;
  defaultType?: ElementType;
}) {
  const [type, setType] = useState<ElementType>(defaultType ?? "character");
  const [name, setName] = useState("");
  const [elementId, setElementId] = useState("");
  const [elementIdTouched, setElementIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<{ dataUrl: string; uploading: boolean; url?: string }[]>([]);
  // Ảnh tham chiếu CHÍNH — mặc định ảnh đầu tiên tải lên (đúng hành vi cũ), nhưng khách bấm vào ảnh phụ
  // nào thì ảnh đó trở thành ảnh chính (xem 22.PNG: viền vàng quanh thumbnail đang chọn).
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remainingSlots = MAX_IMAGES - images.length;
    if (remainingSlots <= 0) {
      setError(`Tối đa ${MAX_IMAGES} ảnh/yếu tố`);
      return;
    }
    const toUpload = Array.from(files).slice(0, remainingSlots);
    for (const file of toUpload) {
      const dataUrl = await fileToDataUrl(file);
      const entry = { dataUrl, uploading: true };
      setImages((prev) => [...prev, entry]);
      try {
        const res = await fetch("/api/reference-elements/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Tải ảnh thất bại");
        setImages((prev) => prev.map((img) => (img.dataUrl === dataUrl ? { ...img, uploading: false, url: data.url } : img)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Tải ảnh thất bại");
        setImages((prev) => prev.filter((img) => img.dataUrl !== dataUrl));
      }
    }
  }

  function handleRemoveImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
    setPrimaryIndex((prev) => {
      if (index < prev) return prev - 1;
      if (index === prev) return 0;
      return prev;
    });
  }

  async function handleSubmit() {
    setError(null);
    const uploaded = images.filter((img) => img.url);
    if (!name.trim()) return setError("Nhập tên hiển thị");
    if (uploaded.length === 0) return setError("Cần ít nhất 1 ảnh");
    // Đẩy ảnh chính lên đầu mảng — trang danh sách (image_urls[0]) + lưới chọn tham chiếu đều hiển thị
    // ảnh đầu tiên làm thumbnail đại diện, nên "ảnh chính" = phần tử [0] khi lưu xuống DB.
    const clampedPrimary = Math.min(primaryIndex, images.length - 1);
    const primaryImg = images[clampedPrimary];
    const imageUrls = [primaryImg, ...images.filter((_, i) => i !== clampedPrimary)].filter((img) => img.url).map((img) => img.url as string);
    setSubmitting(true);
    try {
      const res = await fetch("/api/reference-elements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, name, elementId: elementId || undefined, description, imageUrls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Có lỗi xảy ra");
      onCreated(data.element);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Có lỗi xảy ra");
    } finally {
      setSubmitting(false);
    }
  }

  const hasUploading = images.some((img) => img.uploading);
  const atCap = images.length >= MAX_IMAGES;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Yếu tố mới</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Loại</p>
            <div className="flex gap-2">
              {(["character", "location", "prop"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-sm font-medium ${
                    type === t
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Tên</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!elementIdTouched) setElementId(slugifyElementId(e.target.value));
              }}
              placeholder="Tên hiển thị, ví dụ: Lan, Minh, Quán cà phê"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">ID phần tử (@tên dùng trong mô tả cảnh)</label>
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800">
              <span className="text-sm text-zinc-400">@</span>
              <input
                value={elementId}
                onChange={(e) => {
                  setElementIdTouched(true);
                  setElementId(slugifyElementId(e.target.value));
                }}
                placeholder="vi du lan"
                className="w-full bg-transparent text-sm text-zinc-900 outline-none dark:text-zinc-50"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Mô tả (tuỳ chọn)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mô tả yếu tố này (tuỳ chọn)"
              rows={2}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Ảnh tham chiếu {images.length > 0 && <span className="text-zinc-400">— bấm 1 ảnh để chọn làm ảnh chính</span>}
              </label>
              <span className="text-[11px] text-zinc-400">
                {images.length}/{MAX_IMAGES}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => {
                const isPrimary = i === Math.min(primaryIndex, images.length - 1);
                return (
                  <button
                    type="button"
                    key={i}
                    onClick={() => !img.uploading && setPrimaryIndex(i)}
                    className={`group relative h-20 w-20 overflow-hidden rounded-lg border-2 ${
                      isPrimary ? "border-amber-400 ring-2 ring-amber-400/60" : "border-zinc-200 dark:border-zinc-700"
                    }`}
                    title={isPrimary ? "Ảnh chính" : "Bấm để đặt làm ảnh chính"}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                    {isPrimary && (
                      <span className="absolute left-1 top-1 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-900">
                        Chính
                      </span>
                    )}
                    {img.uploading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] text-white">Đang tải...</div>
                    )}
                    {!img.uploading && (
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveImage(i);
                        }}
                        className="absolute right-1 top-1 hidden rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white group-hover:block"
                      >
                        Xoá
                      </span>
                    )}
                  </button>
                );
              })}
              {!atCap && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-20 w-20 flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 text-zinc-400 hover:border-zinc-400 dark:border-zinc-700"
                >
                  <span className="text-xl">+</span>
                </button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
            </div>
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
          >
            Huỷ bỏ
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || hasUploading || !name.trim() || images.filter((img) => img.url).length === 0}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {submitting ? "Đang tạo..." : "Tạo nên"}
          </button>
        </div>
      </div>
    </div>
  );
}
