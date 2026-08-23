import { findExistingCharacterSheet } from "@/lib/story-video";

// Cho khách tự "Kiểm tra ảnh" trước khi chạy cả job — dò TẤT CẢ ảnh đã tải (không chỉ ảnh đầu, khách
// có thể tải nhiều ảnh và ảnh sheet có sẵn không nhất thiết là ảnh đầu tiên), gọi đúng bước phân loại
// AI dùng lúc submit thật (Gemini Flash, chi phí ~18đ/ảnh, không trừ credit khách).
export async function POST(req: Request) {
  const { imageUrls } = await req.json();
  if (!Array.isArray(imageUrls) || imageUrls.length === 0 || !imageUrls.every((u) => typeof u === "string" && u)) {
    return Response.json({ error: "Thiếu imageUrls" }, { status: 400 });
  }

  try {
    const sheetUrl = await findExistingCharacterSheet(imageUrls);
    return Response.json({ isSheet: !!sheetUrl, sheetIndex: sheetUrl ? imageUrls.indexOf(sheetUrl) : null });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
