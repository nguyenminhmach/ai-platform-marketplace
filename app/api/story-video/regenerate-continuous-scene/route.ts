import { randomUUID } from "crypto";
import { regenerateContinuousMotionSceneImage } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// "Tạo lại" ảnh cho ĐÚNG 1 vị trí khi job bật chuyển động liên tục — xem chú thích
// regenerateContinuousMotionSceneImage() trong lib/story-video.ts để hiểu vì sao dùng "position"
// (vị trí hiển thị trên UI) thay vì sceneId thẳng như regenerate-scene bình thường.
export async function POST(req: Request) {
  const { jobId, position } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number" || typeof position !== "number") {
    return Response.json({ error: "Thiếu jobId/position" }, { status: 400 });
  }

  try {
    const result = await regenerateContinuousMotionSceneImage(userId, jobId, position, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
