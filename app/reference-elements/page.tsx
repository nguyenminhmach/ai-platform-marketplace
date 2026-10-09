"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Footer } from "@/components/Footer";
import { ThemeToggle } from "@/components/ThemeToggle";

type ElementType = "character" | "location" | "prop";

type ReferenceElement = {
  id: number;
  type: ElementType;
  name: string;
  element_id: string;
  description: string | null;
  image_urls: string[];
  created_at: string;
};

const TYPE_LABEL: Record<ElementType, string> = {
  character: "Nhân vật",
  location: "Địa điểm",
  prop: "Đạo cụ",
};

const FILTERS: Array<{ key: ElementType | "tat-ca"; label: string }> = [
  { key: "tat-ca", label: "Tất cả" },
  { key: "character", label: "Nhân vật" },
  { key: "location", label: "Địa điểm" },
  { key: "prop", label: "Đạo cụ" },
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ReferenceElementsPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const [elements, setElements] = useState<ReferenceElement[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ElementType | "tat-ca">("tat-ca");
  const [modalOpen, setModalOpen] = useState(false);

  function loadElements() {
    if (!user) return;
    setLoading(true);
    fetch("/api/reference-elements")
      .then((res) => res.json())
      .then((data) => setElements(data.elements ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(loadElements, [user]);

  async function handleDelete(id: number) {
    if (!confirm("Xoá phần tử này? Không thể hoàn tác.")) return;
    const res = await fetch(`/api/reference-elements/${id}`, { method: "DELETE" });
    if (res.ok) setElements((prev) => prev.filter((el) => el.id !== id));
  }

  if (authLoading) return null;

  if (!user) {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">Anh cần đăng nhập để xem Hình ảnh tham chiếu.</p>
          <Link href="/login" className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
            Đăng nhập / Đăng ký
          </Link>
        </div>
      </div>
    );
  }

  const filteredElements = elements.filter((el) => filter === "tat-ca" || el.type === filter);

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
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

      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-50">Hình ảnh tham chiếu</h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Kho nhân vật/địa điểm/đạo cụ dùng chung cho mọi dự án — gọi lại bằng @tên khi viết ý tưởng truyện.
        </p>

        <div className="mb-6 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${
                filter === f.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          <button
            onClick={() => setModalOpen(true)}
            className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
          >
            <span className="text-3xl">+</span>
            <span className="text-sm font-medium">Yếu tố mới</span>
          </button>

          {!loading &&
            filteredElements.map((el) => (
              <div key={el.id} className="group relative overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={el.image_urls[0]} alt={el.name} className="aspect-square w-full object-cover" />
                <button
                  onClick={() => handleDelete(el.id)}
                  className="absolute right-1.5 top-1.5 rounded-full bg-black/60 px-2 py-1 text-xs text-white opacity-0 hover:bg-black/80 group-hover:opacity-100"
                >
                  Xoá
                </button>
                <div className="p-2">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{el.name}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    @{el.element_id} · {TYPE_LABEL[el.type]}
                  </p>
                </div>
              </div>
            ))}
        </div>

        {!loading && filteredElements.length === 0 && (
          <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">Chưa có phần tử nào — bấm &quot;+ Yếu tố mới&quot; để thêm.</p>
        )}
      </main>

      <Footer />

      {modalOpen && (
        <NewElementModal
          onClose={() => setModalOpen(false)}
          onCreated={(el) => {
            setElements((prev) => [el, ...prev]);
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function slugifyElementId(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function NewElementModal({ onClose, onCreated }: { onClose: () => void; onCreated: (el: ReferenceElement) => void }) {
  const [type, setType] = useState<ElementType>("character");
  const [name, setName] = useState("");
  const [elementId, setElementId] = useState("");
  const [elementIdTouched, setElementIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<{ dataUrl: string; uploading: boolean; url?: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
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

  async function handleSubmit() {
    setError(null);
    const imageUrls = images.filter((img) => img.url).map((img) => img.url as string);
    if (!name.trim()) return setError("Nhập tên hiển thị");
    if (imageUrls.length === 0) return setError("Cần ít nhất 1 ảnh");
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
            <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh tham chiếu</label>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="relative h-20 w-20 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.dataUrl} alt="" className="h-full w-full object-cover" />
                  {img.uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] text-white">Đang tải...</div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-20 w-20 flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 text-zinc-400 hover:border-zinc-400 dark:border-zinc-700"
              >
                <span className="text-xl">+</span>
              </button>
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
            disabled={submitting || hasUploading}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {submitting ? "Đang tạo..." : "Tạo nên"}
          </button>
        </div>
      </div>
    </div>
  );
}
