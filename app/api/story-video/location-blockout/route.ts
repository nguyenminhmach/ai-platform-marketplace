import { generateLocationBlockout } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách bấm nút "🧱 Dựng khối 3D" ở khung "Chọn vị trí đứng" (xem VideoTuYTuongClient.tsx) — chủ động
// kích hoạt, KHÔNG tự gọi lúc gắn ảnh (đã bàn kỹ với user: gọi quá sớm dễ tốn tiền cho ảnh khách chỉ
// gắn thử, chưa chắc dùng). Chỉ cần đăng nhập, không gắn với 1 job cụ thể nào — ảnh bối cảnh ở đây
// sống trong kho tham chiếu chung, dùng lại được nhiều lần (xem lib/reference-elements.ts).
export async function POST(req: Request) {
  const { imageUrl } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof imageUrl !== "string" || !imageUrl) {
    return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });
  }

  try {
    const result = await generateLocationBlockout(imageUrl);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
