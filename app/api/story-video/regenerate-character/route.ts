import { randomUUID } from "crypto";
import { regenerateCharacter } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";

// Khách chưa ưng ảnh Character (job đang ở status "character_ready") — ép tạo lại từ đúng ảnh gốc đã
// tải lên lúc submit, trừ thêm credit cho lần tạo mới (không hoàn lần trước).
export async function POST(req: Request) {
  const { userId, jobId } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    const result = await regenerateCharacter(userId, jobId, randomUUID());
    return Response.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
