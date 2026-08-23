import { randomUUID } from "crypto";
import { continueStoryVideoToSceneStage } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";

// Khách bấm "Tiếp tục chia cảnh" sau khi xem/duyệt ảnh Character (job đang ở status "character_ready")
// — trừ credit phần ảnh rồi chạy chia cảnh (LLM) + submit ảnh cho từng cảnh. Cần thời gian chờ dài hơn
// mặc định (chờ LLM chia cảnh xong trong request này).
export const maxDuration = 60;

export async function POST(req: Request) {
  const { userId, jobId, modelChatKey } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    const result = await continueStoryVideoToSceneStage(
      userId,
      jobId,
      typeof modelChatKey === "string" ? modelChatKey : undefined,
      randomUUID()
    );
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
