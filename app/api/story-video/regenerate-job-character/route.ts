import { randomUUID } from "crypto";
import { regenerateJobCharacter } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách chưa ưng ảnh Character của ĐÚNG 1 người trong job nhiều nhân vật — mirror
// app/api/story-video/regenerate-character/route.ts (job 1 nhân vật) nhưng nhắm đúng 1 "position".
export async function POST(req: Request) {
  const { jobId, position } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });
  if (typeof position !== "number") return Response.json({ error: "Thiếu position" }, { status: 400 });

  try {
    const result = await regenerateJobCharacter(userId, jobId, position, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
