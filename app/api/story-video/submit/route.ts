import { randomUUID } from "crypto";
import {
  submitStoryVideoJob,
  validateScriptSceneResult,
  MIN_SCENES,
  MAX_SCENES,
  MIN_CHARACTER_IMAGES,
  MAX_CHARACTER_IMAGES,
  MAX_STORY_CHARACTERS,
  MAX_ITEM_REFERENCES,
  REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS,
  type MultiCharacterInput,
  type ScriptSceneResult,
} from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

const STORY_MAX_LENGTH = 2000;

// Không tin số lượng/nội dung client tự gửi — lọc chuỗi hợp lệ + cắt về đúng cận trên cho an toàn.
function parseItemReferenceUrls(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter((u): u is string => typeof u === "string" && u.trim().length > 0).slice(0, MAX_ITEM_REFERENCES);
  return filtered.length > 0 ? filtered : undefined;
}

// Bước chia phân cảnh (LLM) + submit N job ảnh song song đều chạy trong request này — cần thời gian
// chờ dài hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  const {
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
    genreKey,
    characters,
    locationReferenceUrl,
    itemReferenceUrls,
    continuousMotion,
    frameChainMode,
    preplannedActions,
  } = await req.json();

  const userId = await getAuthenticatedUserId();
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

  // Nhiều nhân vật (>=2) — validate riêng, bỏ qua hẳn validate 1-nhân-vật bên dưới (characterImageUrls
  // lúc này không dùng tới, mỗi nhân vật tự mang ảnh riêng trong "characters").
  const isMultiCharacter = Array.isArray(characters) && characters.length >= 2;
  let parsedCharacters: MultiCharacterInput[] | undefined;
  if (isMultiCharacter) {
    if (characters.length > MAX_STORY_CHARACTERS) {
      return Response.json({ error: `Tối đa ${MAX_STORY_CHARACTERS} nhân vật` }, { status: 400 });
    }
    for (const c of characters) {
      const hasReuse = typeof c?.reuseCharacterId === "number";
      if (
        !hasReuse &&
        (!Array.isArray(c?.imageUrls) ||
          c.imageUrls.length < MIN_CHARACTER_IMAGES ||
          c.imageUrls.length > MAX_CHARACTER_IMAGES ||
          !c.imageUrls.every((u: unknown) => typeof u === "string" && u))
      ) {
        return Response.json({ error: `Mỗi nhân vật cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh` }, { status: 400 });
      }
    }
    parsedCharacters = characters.map((c: Record<string, unknown>) => ({
      imageUrls: Array.isArray(c.imageUrls) ? (c.imageUrls as string[]) : [],
      reuseCharacterId: typeof c.reuseCharacterId === "number" ? c.reuseCharacterId : undefined,
      skipCharacterCreation: c.skipCharacterCreation === true,
      label: typeof c.label === "string" ? c.label : undefined,
      itemReferenceUrls: parseItemReferenceUrls(c.itemReferenceUrls),
    }));
  }

  // Chọn Character từ thư viện đã lưu -> không cần ảnh tải lên mới, bỏ qua validate số lượng ảnh.
  const hasReuseCharacter = typeof reuseCharacterId === "number";
  if (
    !isMultiCharacter &&
    !hasReuseCharacter &&
    (!Array.isArray(characterImageUrls) ||
      characterImageUrls.length < MIN_CHARACTER_IMAGES ||
      characterImageUrls.length > MAX_CHARACTER_IMAGES ||
      !characterImageUrls.every((u) => typeof u === "string" && u))
  ) {
    return Response.json({ error: `Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật` }, { status: 400 });
  }

  // Bước "Tạo kịch bản" — CHỈ luồng 1 nhân vật, AI tự vẽ ảnh (isMultiCharacter=false). Không tin trực
  // tiếp giá/duration_key nào trong đây — chỉ giữ lại các field mô tả (description/camera_view/...),
  // submitStoryVideoJob/runSceneStage sẽ tự chạy lại planStoryVideoScenes() để tính giá thật.
  let parsedPreplannedActions: ScriptSceneResult[] | undefined;
  if (!isMultiCharacter && preplannedActions !== undefined) {
    try {
      parsedPreplannedActions = validateScriptSceneResult(preplannedActions, storyDescription);
    } catch (err) {
      return Response.json(
        { error: `Kịch bản không hợp lệ, vui lòng bấm "Tạo kịch bản" lại: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 }
      );
    }
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
      skipCharacterCreation === true,
      typeof genreKey === "string" ? genreKey : undefined,
      parsedCharacters,
      typeof locationReferenceUrl === "string" && locationReferenceUrl ? locationReferenceUrl : undefined,
      // Frame-chaining (v1: chỉ 1 nhân vật) và chuyển động liên tục (FLFV) loại trừ nhau — 2 cơ chế
      // nối cảnh khác nhau, không thể bật cùng lúc. frameChainMode ưu tiên nếu khách lỡ bật cả 2.
      !isMultiCharacter && frameChainMode === true
        ? false
        : continuousMotion === true || (typeof videoModelKey === "string" && REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS.has(videoModelKey)),
      !isMultiCharacter && frameChainMode === true,
      parseItemReferenceUrls(itemReferenceUrls),
      parsedPreplannedActions
    );
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" },
      { status: 500 }
    );
  }
}
