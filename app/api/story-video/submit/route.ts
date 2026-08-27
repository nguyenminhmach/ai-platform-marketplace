import { randomUUID } from "crypto";
import { submitStoryVideoJob, MIN_SCENES, MAX_SCENES, MIN_CHARACTER_IMAGES, MAX_CHARACTER_IMAGES } from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";

const STORY_MAX_LENGTH = 2000;

// Bước chia phân cảnh (LLM) + submit N job ảnh song song đều chạy trong request này — cần thời gian
// chờ dài hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  const {
    userId,
    miniAppId,
    storyDescription,
    numScenes,
    characterImageUrls,
    imageModelKey,
    videoModelKey,
    autoVideo,
    aspectRatio,
    resolutionKey,
    durationKey,
    modelChatKey,
    reuseCharacterId,
    skipCharacterCreation,
  } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof miniAppId !== "string" || !miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  // Bước này (Tạo Character) chưa cần ý tưởng truyện — khách có thể gõ sau, ở bước "Tiếp tục chia
  // cảnh" (continueStoryVideoToSceneStage bắt buộc phải có mới cho chạy tiếp).
  if (typeof storyDescription !== "string") {
    return Response.json({ error: "storyDescription không hợp lệ" }, { status: 400 });
  }
  if (storyDescription.length > STORY_MAX_LENGTH) {
    return Response.json({ error: `Ý tưởng truyện quá dài (tối đa ${STORY_MAX_LENGTH} ký tự)` }, { status: 400 });
  }
  if (typeof numScenes !== "number" || numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    return Response.json({ error: `Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh` }, { status: 400 });
  }
  // Chọn Character từ thư viện đã lưu -> không cần ảnh tải lên mới, bỏ qua validate số lượng ảnh.
  const hasReuseCharacter = typeof reuseCharacterId === "number";
  if (
    !hasReuseCharacter &&
    (!Array.isArray(characterImageUrls) ||
      characterImageUrls.length < MIN_CHARACTER_IMAGES ||
      characterImageUrls.length > MAX_CHARACTER_IMAGES ||
      !characterImageUrls.every((u) => typeof u === "string" && u))
  ) {
    return Response.json({ error: `Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật` }, { status: 400 });
  }

  try {
    const result = await submitStoryVideoJob(
      userId,
      miniAppId,
      storyDescription.trim(),
      numScenes,
      Array.isArray(characterImageUrls) ? characterImageUrls : [],
      typeof imageModelKey === "string" ? imageModelKey : undefined,
      typeof videoModelKey === "string" ? videoModelKey : undefined,
      autoVideo === true,
      typeof aspectRatio === "string" && aspectRatio ? aspectRatio : "9:16",
      typeof resolutionKey === "string" ? resolutionKey : undefined,
      typeof durationKey === "string" ? durationKey : undefined,
      typeof modelChatKey === "string" ? modelChatKey : undefined,
      randomUUID(),
      hasReuseCharacter ? reuseCharacterId : undefined,
      skipCharacterCreation === true
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
