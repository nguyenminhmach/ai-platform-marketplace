import { classifyCharacterImage } from "@/lib/story-video";

// Cho khách tự "Kiểm tra ảnh" trước khi chạy cả job — gọi đúng bước phân loại AI dùng lúc submit thật
// (Gemini Flash, chi phí ~18đ/lần, không trừ credit khách) nhưng tách riêng để xem kết quả ngay,
// không phải đoán mò qua cả quy trình dài.
export async function POST(req: Request) {
  const { imageUrl } = await req.json();
  if (typeof imageUrl !== "string" || !imageUrl) return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });

  try {
    const isSheet = await classifyCharacterImage(imageUrl);
    return Response.json({ isSheet });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
