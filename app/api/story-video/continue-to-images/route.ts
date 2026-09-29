import { randomUUID } from "crypto";
import { continueStoryVideoToImageStage } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Bước 2 của luồng preview miễn phí (luồng 1 nhân vật) — khách đã xem bố cục Agent chọn ở status
// "scenes_ready" (xem continue-to-scenes/route.ts), bấm "Tạo ảnh" mới gọi route này: trừ credit phần
// ảnh (+ video nếu auto_video) rồi submit ảnh thật cho từng cảnh đã chia sẵn.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { jobId } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    const result = await continueStoryVideoToImageStage(userId, jobId, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
