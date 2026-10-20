import { randomUUID } from "crypto";
import { getAuthenticatedUserId } from "@/lib/auth-server";
import { submitPromptImageJob } from "@/lib/prompt-image";
import { InsufficientCreditError } from "@/lib/credit-system";

// POST /api/prompt-image/submit — nút "tạo" ở tab "hình ảnh" (app/video-tu-y-tuong/page.tsx) gọi
// vào đây. Trả về ngay jobId (BẤT ĐỒNG BỘ, giống hệt /api/outfit-swap/submit) — frontend tự poll
// /api/prompt-image/status, không giữ request chờ Fal.ai xử lý xong (tránh bị Vercel kill ở mốc 60s).
export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }

  const { prompt, imageUrls, modelKey, aspectRatio, resolutionKey, projectId, maskUrl } = await req.json();
  if (typeof prompt !== "string" || !prompt.trim()) {
    return Response.json({ error: "Thiếu câu lệnh mô tả" }, { status: 400 });
  }

  try {
    const result = await submitPromptImageJob(
      userId,
      prompt,
      Array.isArray(imageUrls) ? imageUrls.filter((u: unknown) => typeof u === "string") : [],
      typeof modelKey === "string" ? modelKey : undefined,
      typeof aspectRatio === "string" ? aspectRatio : "1:1",
      typeof resolutionKey === "string" ? resolutionKey : undefined,
      randomUUID(),
      typeof projectId === "number" ? projectId : null,
      typeof maskUrl === "string" ? maskUrl : null
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit" }, { status: 402 });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
