"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Footer } from "@/components/Footer";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NewElementModal, TYPE_LABEL, type ElementType, type ReferenceElement } from "@/components/reference-elements/NewElementModal";

const FILTERS: Array<{ key: ElementType | "tat-ca"; label: string }> = [
  { key: "tat-ca", label: "Tất cả" },
  { key: "character", label: "Nhân vật" },
  { key: "location", label: "Địa điểm" },
  { key: "prop", label: "Đạo cụ" },
];

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
