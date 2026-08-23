import { findExistingCharacterSheet } from "@/lib/story-video";

// Cho khách tự "Kiểm tra ảnh" trước khi chạy cả job — gọi đúng bước phân loại AI dùng lúc submit thật
// (Gemini Flash, chi phí ~18đ/ảnh, không trừ credit khách). Khớp đúng quy tắc thật của
// submitStoryVideoJob: chỉ báo "đã là Character" khi tải ĐÚNG 1 ảnh và ảnh đó là sheet sẵn — từ 2 ảnh
// trở lên luôn coi là cần tạo mới (dùng toàn bộ ảnh làm tư liệu), không tự động bỏ qua ảnh thường.
export async function POST(req: Request) {
  const { imageUrls } = await req.json();
  if (!Array.isArray(imageUrls) || imageUrls.length === 0 || !imageUrls.every((u) => typeof u === "string" && u)) {
    return Response.json({ error: "Thiếu imageUrls" }, { status: 400 });
  }

  try {
    const sheetUrl = imageUrls.length === 1 ? await findExistingCharacterSheet(imageUrls) : null;
    return Response.json({ isSheet: !!sheetUrl, sheetIndex: sheetUrl ? imageUrls.indexOf(sheetUrl) : null });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
