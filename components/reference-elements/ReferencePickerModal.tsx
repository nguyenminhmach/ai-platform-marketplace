"use client";

import { useEffect, useRef, useState } from "react";
import { NewElementModal, TYPE_LABEL, type ElementType, type ReferenceElement } from "@/components/reference-elements/NewElementModal";

// Modal "Higgsfield-style" dùng chung cho nút "+" và "@" ở thanh dưới cùng app/video-tu-y-tuong —
// xem wireframe "tải ảnh.jpg" (tab Tải lên) và "ảnh tham chiêu.jpg" (tab Hình ảnh tham chiếu). Chrome
// (nền tối, bo góc, canh giữa màn hình) khớp kiểu modal preset ánh sáng/máy quay đã có sẵn trong file
// (xem activePresetModal trong app/video-tu-y-tuong/page.tsx) để đồng bộ phong cách toàn trang.
//
// "+" mở modal ở tab "Tải lên"; "@" mở ở tab "Hình ảnh tham chiếu" VÀ có thêm hành vi chèn @element_id
// vào đúng vị trí con trỏ trong ô prompt (onInsertMention) — xem mục 8 trong spec.

type TabKey = "upload" | "reference" | "favorite";

const MAX_UPLOAD_PER_SESSION = 30;

type UploadEntry = { dataUrl: string; uploading: boolean; url?: string; error?: string };

export function ReferencePickerModal({
  defaultTab,
  onClose,
  compressImageFile,
  uploadImage,
  onAddImages,
  onInsertMention,
}: {
  defaultTab: TabKey;
  onClose: () => void;
  compressImageFile: (file: File) => Promise<string>;
  uploadImage: (dataUrl: string) => Promise<string>;
  onAddImages: (urls: string[]) => void;
  onInsertMention?: (elementId: string) => void;
}) {
  const [tab, setTab] = useState<TabKey>(defaultTab);

  // ----- Tab "Tải lên" -----
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remainingSlots = MAX_UPLOAD_PER_SESSION - uploads.length;
    if (remainingSlots <= 0) return;
    const toUpload = Array.from(files).slice(0, remainingSlots);
    for (const file of toUpload) {
      if (!file.type.startsWith("image/")) continue;
      const compact = await compressImageFile(file);
      setUploads((prev) => [...prev, { dataUrl: compact, uploading: true }]);
      try {
        const url = await uploadImage(compact);
        setUploads((prev) => prev.map((u) => (u.dataUrl === compact ? { ...u, uploading: false, url } : u)));
        onAddImages([url]);
      } catch (err) {
        setUploads((prev) =>
          prev.map((u) => (u.dataUrl === compact ? { ...u, uploading: false, error: err instanceof Error ? err.message : "Lỗi tải ảnh" } : u))
        );
      }
    }
  }

  // ----- Tab "Hình ảnh tham chiếu" -----
  const [elements, setElements] = useState<ReferenceElement[]>([]);
  const [elementsLoading, setElementsLoading] = useState(false);
  const [elementFilter, setElementFilter] = useState<ElementType | "tat-ca">("tat-ca");
  const [newElementOpen, setNewElementOpen] = useState(false);

  function loadElements() {
    setElementsLoading(true);
    const qs = elementFilter === "tat-ca" ? "" : `?type=${elementFilter}`;
    fetch(`/api/reference-elements${qs}`)
      .then((res) => res.json())
      .then((data) => setElements(data.elements ?? []))
      .catch(() => {})
      .finally(() => setElementsLoading(false));
  }

  useEffect(() => {
    if (tab === "reference") loadElements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, elementFilter]);

  function handlePickElement(el: ReferenceElement) {
    if (el.image_urls.length > 0) onAddImages([el.image_urls[0]]);
    onInsertMention?.(el.element_id);
    // Mở từ "@": chọn xong đóng luôn modal để khách quay lại viết tiếp prompt — mở từ "+" (không có
    // onInsertMention) thì chỉ thêm ảnh, không đóng, để khách chọn thêm ảnh khác nếu muốn.
    if (onInsertMention) onClose();
  }

  const REF_FILTERS: Array<{ key: ElementType | "tat-ca"; label: string; icon: string }> = [
    { key: "tat-ca", label: "Tất cả", icon: "@" },
    { key: "character", label: "Nhân vật", icon: "👤" },
    { key: "location", label: "Địa điểm", icon: "📍" },
    { key: "prop", label: "Đạo cụ", icon: "🎭" },
  ];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex h-[min(720px,85vh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tabs header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-1 rounded-full bg-zinc-900 p-1">
            {(
              [
                { key: "upload", label: "Tải lên" },
                { key: "reference", label: "Hình ảnh tham chiếu" },
                { key: "favorite", label: "Yêu thích" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  tab === t.key ? "bg-white text-zinc-900" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {tab === "upload" && (
            <div
              className="flex w-full flex-col overflow-y-auto p-5"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFiles(e.dataTransfer.files);
              }}
            >
              <p className="mb-3 text-xs text-zinc-500">Tối đa {MAX_UPLOAD_PER_SESSION} ảnh/lượt tải — bấm vào ảnh để xem cỡ lớn.</p>
              <div
                className={`grid grid-cols-6 gap-2 overflow-x-auto pb-2 ${dragOver ? "opacity-70" : ""}`}
                style={{ gridAutoFlow: uploads.length > 11 ? "column" : "row", gridTemplateRows: uploads.length > 11 ? "repeat(2, minmax(0,1fr))" : undefined }}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploads.length >= MAX_UPLOAD_PER_SESSION}
                  className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                >
                  <span className="text-2xl">☁️</span>
                  <span className="px-2 text-center text-[11px] font-medium leading-tight">Tải lên phương tiện</span>
                </button>
                {uploads.map((u, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setZoomed(u.dataUrl)}
                    className="relative aspect-square overflow-hidden rounded-xl border border-zinc-800"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u.dataUrl} alt="" className="h-full w-full object-cover" />
                    {u.uploading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] text-white">Đang tải...</div>
                    )}
                    {u.error && (
                      <div className="absolute inset-0 flex items-center justify-center bg-red-950/70 p-1 text-center text-[9px] text-red-200">
                        {u.error}
                      </div>
                    )}
                    {u.url && !u.uploading && (
                      <span className="absolute right-1 top-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                        ✓ đã thêm
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
          )}

          {tab === "reference" && (
            <>
              <div className="w-44 shrink-0 border-r border-zinc-800 p-4">
                <div className="space-y-1">
                  {REF_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setElementFilter(f.key)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                        elementFilter === f.key ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                      }`}
                    >
                      <span className="w-4 text-center text-xs">{f.icon}</span>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                  <button
                    type="button"
                    onClick={() => setNewElementOpen(true)}
                    className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-lg">+</span>
                    <span className="text-xs font-medium">Yếu tố mới</span>
                  </button>
                  {!elementsLoading &&
                    elements.map((el) => (
                      <button
                        type="button"
                        key={el.id}
                        onClick={() => handlePickElement(el)}
                        className="group relative aspect-square overflow-hidden rounded-xl border border-zinc-800"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={el.image_urls[0]} alt={el.name} className="h-full w-full object-cover" />
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-left">
                          <p className="truncate text-xs font-medium text-white">{el.name}</p>
                          <p className="truncate text-[10px] text-zinc-300">
                            @{el.element_id} · {TYPE_LABEL[el.type]}
                          </p>
                        </div>
                      </button>
                    ))}
                </div>
                {!elementsLoading && elements.length === 0 && (
                  <p className="mt-6 text-sm text-zinc-500">Chưa có phần tử nào — bấm &quot;+ Yếu tố mới&quot; để thêm nhân vật/địa điểm/đạo cụ dùng lại nhiều lần.</p>
                )}
                {elementsLoading && <p className="mt-6 text-sm text-zinc-500">Đang tải...</p>}
              </div>
            </>
          )}

          {tab === "favorite" && (
            <div className="flex w-full items-center justify-center p-5">
              <p className="text-sm text-zinc-500">Chưa có mục yêu thích nào.</p>
            </div>
          )}
        </div>
      </div>

      {zoomed && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/90 p-6" onClick={() => setZoomed(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomed} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}

      {newElementOpen && (
        <NewElementModal
          defaultType={elementFilter === "tat-ca" ? undefined : elementFilter}
          onClose={() => setNewElementOpen(false)}
          onCreated={(el) => {
            setElements((prev) => [el as unknown as ReferenceElement, ...prev]);
            setNewElementOpen(false);
          }}
        />
      )}
    </div>
  );
}
