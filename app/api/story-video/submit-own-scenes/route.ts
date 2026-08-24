import { randomUUID } from "crypto";
import { submitStoryVideoJobWithOwnImages, MIN_SCENES, MAX_SCENES } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";

const STORY_MAX_LENGTH = 2000;

// Khách đã có sẵn ảnh cho từng phân cảnh (tải lên thay vì để AI tạo) — bỏ qua bước Character + AI tạo
// ảnh phân cảnh hoàn toàn, Agent chỉ viết mô tả chuyển động cho từng ảnh rồi chạy thẳng tới bước video.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { userId, miniAppId, storyDescription, sceneImages, videoModelKey, autoVideo, aspectRatio, durationKey, modelChatKey } =
    await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof miniAppId !== "string" || !miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (typeof storyDescription !== "string" || !storyDescription.trim()) {
    return Response.json({ error: "Thiếu ý tưởng truyện" }, { status: 400 });
  }
  if (storyDescription.length > STORY_MAX_LENGTH) {
    return Response.json({ error: `Ý tưởng truyện quá dài (tối đa ${STORY_MAX_LENGTH} ký tự)` }, { status: 400 });
  }
  if (
    !Array.isArray(sceneImages) ||
    sceneImages.length < MIN_SCENES ||
    sceneImages.length > MAX_SCENES ||
    !sceneImages.every((s) => s && typeof s.imageUrl === "string" && s.imageUrl && (s.hint === undefined || typeof s.hint === "string"))
  ) {
    return Response.json({ error: `Cần từ ${MIN_SCENES} đến ${MAX_SCENES} ảnh phân cảnh` }, { status: 400 });
  }

  try {
    const result = await submitStoryVideoJobWithOwnImages(
      userId,
      miniAppId,
      storyDescription.trim(),
      sceneImages,
      typeof videoModelKey === "string" ? videoModelKey : undefined,
      autoVideo === true,
      typeof aspectRatio === "string" && aspectRatio ? aspectRatio : "9:16",
      typeof durationKey === "string" ? durationKey : undefined,
      typeof modelChatKey === "string" ? modelChatKey : undefined,
      randomUUID()
    );
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
