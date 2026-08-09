import { randomUUID } from "crypto";
import { submitVideoJob } from "@/lib/ai-router";
import { InsufficientCreditError } from "@/lib/credit-system";

export async function POST(req: Request) {
  const { miniAppId, userId, prompt, startFrameDataUrl, endFrameDataUrl } = await req.json();

  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return Response.json({ error: "Thiếu mô tả video" }, { status: 400 });
  }

  try {
    const result = await submitVideoJob(
      miniAppId,
      userId,
      prompt,
      randomUUID(),
      startFrameDataUrl,
      endFrameDataUrl
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
