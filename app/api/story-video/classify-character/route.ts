import { classifyAllAreSheets } from "@/lib/story-video";

// Cho khách tự "Kiểm tra ảnh" trước khi chạy cả job — gọi đúng bước phân loại AI dùng lúc submit thật
// (Gemini Flash, chi phí ~18đ/ảnh, không trừ credit khách). Khớp đúng quy tắc thật của
// submitStoryVideoJob: chỉ báo "đã là Character" khi TOÀN BỘ ảnh tải lên đều đã là sheet sẵn (không
// lẫn ảnh thường nào) — chỉ cần 1 ảnh thường lẫn vào là coi như cần tạo mới (dùng toàn bộ ảnh làm tư
// liệu), không tự động bỏ qua ảnh thường.
export async function POST(req: Request) {
  const { imageUrls } = await req.json();
  if (!Array.isArray(imageUrls) || imageUrls.length === 0 || !imageUrls.every((u) => typeof u === "string" && u)) {
    return Response.json({ error: "Thiếu imageUrls" }, { status: 400 });
  }

  try {
    const isSheet = await classifyAllAreSheets(imageUrls);
    return Response.json({ isSheet });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
