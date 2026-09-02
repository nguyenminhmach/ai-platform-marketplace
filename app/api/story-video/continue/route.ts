import { randomUUID } from "crypto";
import { continueStoryVideoToVideoStage } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách bấm "Tạo video" sau khi xem trước ảnh phân cảnh (job đang ở status "images_ready") — trừ
// riêng phần credit video rồi submit các job video song song. Submit job video không chờ trong
// request này (chỉ gọi Fal.ai queue, trả về ngay), nhưng vẫn để dư thời gian như route submit chính.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { jobId } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    const result = await continueStoryVideoToVideoStage(userId, jobId, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
