import { randomUUID } from "crypto";
import {
  submitStoryVideoJob,
  validateScriptSceneResult,
  validateScriptSceneResultMulti,
  MIN_SCENES,
  MAX_SCENES,
  MIN_CHARACTER_IMAGES,
  MAX_CHARACTER_IMAGES,
  MAX_STORY_CHARACTERS,
  MAX_ITEM_REFERENCES,
  REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS,
  type MultiCharacterInput,
  type ScriptSceneResult,
  type ScriptSceneResultMulti,
  type LocationMaskZone,
} from "@/lib/story-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";
import { attachJobToProject } from "@/lib/story-video-projects";

const STORY_MAX_LENGTH = 2000;
const CHARACTER_APPEARANCE_DESCRIPTION_MAX_LENGTH = 500;

// Không tin số lượng/nội dung client tự gửi — lọc chuỗi hợp lệ + cắt về đúng cận trên cho an toàn.
function parseItemReferenceUrls(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter((u): u is string => typeof u === "string" && u.trim().length > 0).slice(0, MAX_ITEM_REFERENCES);
  return filtered.length > 0 ? filtered : undefined;
}

// Nhiều nhân vật, nhiều vị trí trong 1 ảnh Bối cảnh — lọc mềm (không throw): bỏ qua bất kỳ phần tử nào
// sai định dạng/toạ độ ngoài [0,1]/position ngoài phạm vi số nhân vật thay vì chặn cả request, đúng
// tinh thần các field toạ độ tuỳ chọn khác trong app (vd item_reference_urls) — 1 vị trí lỗi không nên
// làm hỏng cả job.
function parseLocationMaskZones(raw: unknown, characterCount: number): LocationMaskZone[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const inRange01 = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const filtered = raw.filter((z): z is LocationMaskZone => {
    if (!z || typeof z !== "object") return false;
    const zone = z as Record<string, unknown>;
    return (
      typeof zone.position === "number" &&
      Number.isInteger(zone.position) &&
      zone.position >= 0 &&
      zone.position < characterCount &&
      inRange01(zone.xPct) &&
      inRange01(zone.yPct) &&
      inRange01(zone.wPct) &&
      inRange01(zone.hPct) &&
      (zone.wPct as number) > 0 &&
      (zone.hPct as number) > 0
    );
  });
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
    locationReferenceMaskUrl,
    locationReferenceMaskZones,
    itemReferenceUrls,
    continuousMotion,
    frameChainMode,
    preplannedActions,
    preplannedActionsMulti,
    characterAppearanceDescription,
    projectId,
    chapterIndex,
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
      // Chế độ "Mô tả bằng chữ" cho ĐÚNG nhân vật này — không cần ảnh, mirror validate ở luồng 1 nhân
      // vật bên dưới (mỗi nhân vật trong job có thể độc lập dùng ảnh thật HOẶC mô tả chữ).
      const trimmedDescription = typeof c?.appearanceDescription === "string" ? c.appearanceDescription.trim() : "";
      if (trimmedDescription) {
        if (trimmedDescription.length > CHARACTER_APPEARANCE_DESCRIPTION_MAX_LENGTH) {
          return Response.json(
            { error: `Mô tả nhân vật quá dài (tối đa ${CHARACTER_APPEARANCE_DESCRIPTION_MAX_LENGTH} ký tự)` },
            { status: 400 }
          );
        }
        continue;
      }
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
      appearanceDescription: typeof c.appearanceDescription === "string" && c.appearanceDescription.trim() ? c.appearanceDescription.trim() : undefined,
    }));
  }

  // Chế độ "Mô tả bằng chữ" (không có ảnh tham chiếu thật) — CHỈ áp dụng luồng 1 nhân vật.
  const trimmedAppearanceDescription =
    typeof characterAppearanceDescription === "string" ? characterAppearanceDescription.trim() : "";
  const hasAppearanceDescription = !isMultiCharacter && trimmedAppearanceDescription.length > 0;
  if (hasAppearanceDescription && trimmedAppearanceDescription.length > CHARACTER_APPEARANCE_DESCRIPTION_MAX_LENGTH) {
    return Response.json(
      { error: `Mô tả nhân vật quá dài (tối đa ${CHARACTER_APPEARANCE_DESCRIPTION_MAX_LENGTH} ký tự)` },
      { status: 400 }
    );
  }

  // Chọn Character từ thư viện đã lưu -> không cần ảnh tải lên mới, bỏ qua validate số lượng ảnh.
  const hasReuseCharacter = typeof reuseCharacterId === "number";
  if (
    !isMultiCharacter &&
    !hasReuseCharacter &&
    !hasAppearanceDescription &&
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
  // Bước "Tạo kịch bản" bản NHIỀU NHÂN VẬT — mirror khối trên, dùng đúng nhãn nhân vật (fallback "Nhân
  // vật N") đã tính lúc parse "characters" để validate mảng "characters" chỉ số trong từng hành động.
  let parsedPreplannedActionsMulti: ScriptSceneResultMulti[] | undefined;
  if (isMultiCharacter && preplannedActionsMulti !== undefined) {
    const characterLabels = parsedCharacters!.map((c, i) => c.label?.trim() || `Nhân vật ${i + 1}`);
    try {
      parsedPreplannedActionsMulti = validateScriptSceneResultMulti(preplannedActionsMulti, storyDescription, characterLabels);
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
      typeof locationReferenceMaskUrl === "string" && locationReferenceMaskUrl ? locationReferenceMaskUrl : undefined,
      parseLocationMaskZones(locationReferenceMaskZones, isMultiCharacter ? (parsedCharacters?.length ?? 0) : 1),
      // Frame-chaining và chuyển động liên tục (FLFV) loại trừ nhau — 2 cơ chế nối cảnh khác nhau,
      // không thể bật cùng lúc. frameChainMode ưu tiên nếu khách lỡ bật cả 2. Áp dụng cho cả luồng 1
      // lẫn nhiều nhân vật (submitMultiCharacterStoryVideoJob/runMultiCharacterSceneStage đã hỗ trợ).
      frameChainMode === true
        ? false
        : continuousMotion === true || (typeof videoModelKey === "string" && REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS.has(videoModelKey)),
      frameChainMode === true,
      parseItemReferenceUrls(itemReferenceUrls),
      parsedPreplannedActions,
      parsedPreplannedActionsMulti,
      hasAppearanceDescription ? trimmedAppearanceDescription : undefined
    );
    // Video nhiều chương: gắn job vào dự án ở đúng chương. Lỗi ở đây không làm hỏng job (credit đã trừ, job đã chạy).
    if (typeof projectId === "number" && typeof chapterIndex === "number") {
      await attachJobToProject(userId, projectId, result.jobId, chapterIndex).catch((e) =>
        console.error("[story-video] Không gắn được job vào dự án:", e)
      );
    }
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
