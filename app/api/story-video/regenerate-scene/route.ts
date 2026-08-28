import { randomUUID } from "crypto";
import { regenerateSceneImage } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";

// Khách chỉ ưng 1 phần ảnh phân cảnh — tạo lại ĐÚNG 1 cảnh, trừ credit đúng bằng giá 1 ảnh, không
// đụng các cảnh khác trong job.
export async function POST(req: Request) {
  const { userId, sceneId } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof sceneId !== "number") return Response.json({ error: "Thiếu sceneId" }, { status: 400 });

  try {
    const result = await regenerateSceneImage(userId, sceneId, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
