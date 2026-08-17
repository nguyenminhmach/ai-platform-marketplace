import { randomUUID } from "crypto";
import { submitVideoJob } from "@/lib/ai-router";
import { InsufficientCreditError } from "@/lib/credit-system";

export async function POST(req: Request) {
  const { miniAppId, userId, prompt, startFrameDataUrl, endFrameDataUrl, modelChoice, duration } = await req.json();

  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return Response.json({ error: "Thiếu mô tả video" }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return Response.json({ error: "Mô tả video quá dài (tối đa 2000 ký tự) — AI sẽ từ chối xử lý, vui lòng rút ngắn lại" }, { status: 400 });
  }

  try {
    const result = await submitVideoJob(
      miniAppId,
      userId,
      prompt,
      randomUUID(),
      startFrameDataUrl,
      endFrameDataUrl,
      modelChoice === "basic" || modelChoice === "premium" ? modelChoice : undefined,
      duration === "5" || duration === "10" ? duration : undefined
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
