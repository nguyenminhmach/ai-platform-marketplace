import { checkSceneContinuity } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách tự bấm "Kiểm tra lệch ảnh đầu/cuối" trên 1 cảnh (chỉ áp dụng job bật chuyển động liên tục) —
// Gemini Flash rẻ, không trừ credit (cùng tiền lệ /api/story-video/classify-character).
export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { startImageUrl, endImageUrl } = await req.json();
  if (typeof startImageUrl !== "string" || !startImageUrl || typeof endImageUrl !== "string" || !endImageUrl) {
    return Response.json({ error: "Thiếu startImageUrl/endImageUrl" }, { status: 400 });
  }

  try {
    const result = await checkSceneContinuity(startImageUrl, endImageUrl);
    return Response.json(result);
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
