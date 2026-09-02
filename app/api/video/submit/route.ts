import { randomUUID } from "crypto";
import { submitVideoJob } from "@/lib/ai-router";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function POST(req: Request) {
  const { miniAppId, prompt, startFrameDataUrl, endFrameDataUrl, modelChoice, duration } = await req.json();

  // userId LUÔN lấy từ session đã xác thực (cookie), KHÔNG tin client gửi trong body.
  const userId = await getAuthenticatedUserId();
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
      modelChoice === "basic" || modelChoice === "premium" || modelChoice === "budget" ? modelChoice : undefined,
      // Số giây hợp lệ cho mỗi tier/model khác nhau (Kling 5/10, LTX-2.3 6/8/10/12/...) — chỉ chặn
      // format ở đây (chuỗi số nguyên dương ngắn), đối chiếu đúng mức tier hỗ trợ nằm ở submitVideoJob.
      typeof duration === "string" && /^[0-9]{1,3}$/.test(duration) ? duration : undefined
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
