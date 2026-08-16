import { randomUUID } from "crypto";
import { submitDialogueVideoJob } from "@/lib/dialogue-video";
import { InsufficientCreditError } from "@/lib/credit-system";

const LINE_MAX_LENGTH = 400;

export async function POST(req: Request) {
  const { userId, miniAppId, aImageUrl, aLine, bImageUrl, bLine } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof miniAppId !== "string" || !miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (typeof aImageUrl !== "string" || !aImageUrl) return Response.json({ error: "Thiếu ảnh nhân vật A" }, { status: 400 });
  if (typeof bImageUrl !== "string" || !bImageUrl) return Response.json({ error: "Thiếu ảnh nhân vật B" }, { status: 400 });
  if (typeof aLine !== "string" || !aLine.trim()) return Response.json({ error: "Thiếu lời thoại nhân vật A" }, { status: 400 });
  if (typeof bLine !== "string" || !bLine.trim()) return Response.json({ error: "Thiếu lời thoại nhân vật B" }, { status: 400 });
  if (aLine.length > LINE_MAX_LENGTH || bLine.length > LINE_MAX_LENGTH) {
    return Response.json({ error: `Lời thoại tối đa ${LINE_MAX_LENGTH} ký tự mỗi người` }, { status: 400 });
  }

  try {
    const result = await submitDialogueVideoJob(
      userId,
      miniAppId,
      aImageUrl,
      aLine.trim(),
      bImageUrl,
      bLine.trim(),
      randomUUID()
    );
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
