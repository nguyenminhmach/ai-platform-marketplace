import { randomUUID } from "crypto";
import { regenerateSceneVideo } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách chỉ ưng 1 phần video phân cảnh — tạo lại ĐÚNG 1 cảnh, trừ credit đúng bằng giá 1 cảnh video,
// không đụng các cảnh khác trong job. Mirror app/api/story-video/regenerate-scene/route.ts (ảnh).
export async function POST(req: Request) {
  const { sceneId, customPrompt } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof sceneId !== "number") return Response.json({ error: "Thiếu sceneId" }, { status: 400 });

  try {
    const result = await regenerateSceneVideo(userId, sceneId, randomUUID(), typeof customPrompt === "string" ? customPrompt : undefined);
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
