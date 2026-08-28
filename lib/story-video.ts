// Pipeline "Video từ ý tưởng truyện" — 1-3 ảnh nhân vật + 1 ý tưởng truyện, AI chia 2-8 phân cảnh
// rồi với mỗi cảnh: (1) model ảnh (khách chọn từ catalog nhiều nhà cung cấp) tạo ảnh giữ đúng nhân
// vật -> (2) model video (khách chọn từ catalog) động hoá ảnh đó -> (3) ffmpeg ghép N clip lại theo
// đúng thứ tự thành 1 video hoàn chỉnh. Mỗi cảnh là 1 hàng trong story_video_scenes, xử lý song song,
// chờ đủ cả N hàng mới sang bước kế tiếp — cùng khuôn với lib/dialogue-video.ts.
//
// Chia 3 nấc: submitStoryVideoJob() xử lý bước "Tạo Character" trước tiên rồi DỪNG ở "character_ready"
// (chỉ trừ credit nếu thực sự phải tạo Character mới) — khách xem/duyệt ảnh Character, ưng mới gọi
// continueStoryVideoToSceneStage() (trừ credit phần ảnh, chạy chia cảnh + tạo ảnh từng cảnh dùng
// Character làm tham chiếu) rồi DỪNG ở "images_ready" — khách xem ảnh từng cảnh, ưng mới gọi
// continueStoryVideoToVideoStage() (trừ credit phần video) để chạy tiếp video + ghép. Nếu khách chọn
// "tự động tạo video luôn" (autoVideo=true) thì continueStoryVideoToSceneStage trừ gộp cả ảnh+video và
// tự chạy hết tới cuối, không dừng ở images_ready.

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { chmodSync } from "fs";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, getCreditBalance, InsufficientCreditError } from "@/lib/credit-system";
import { callOpenRouter, recordGenerationHistory } from "@/lib/ai-router";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

const execFileAsync = promisify(execFile);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export const MIN_SCENES = 1;
export const MAX_SCENES = 8;
export const MIN_CHARACTER_IMAGES = 1;
// Không giới hạn số ảnh nhân vật theo yêu cầu — chỉ giữ 1 trần an toàn kỹ thuật (tránh payload quá
// lớn/timeout, và một số model multi-image như Nano Banana Pro tự giới hạn tối đa 14 ảnh ở phía Fal.ai).
export const MAX_CHARACTER_IMAGES = 20;

const SCENE_SPLIT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (nhân vật đang làm gì, ở đâu, bối cảnh gì), giữ nguyên nhân vật chính xuyên suốt các cảnh.
Với MỖI cảnh, xác định thêm góc camera đang nhìn thấy nhân vật rõ nhất, chỉ được chọn ĐÚNG 1 trong 6 giá trị sau (viết y hệt, chữ thường): "front" (chính diện), "three_quarter_left" (nghiêng 3/4 trái), "three_quarter_right" (nghiêng 3/4 phải), "side" (nhìn ngang hẳn 1 bên), "back" (quay lưng lại camera), "face" (cận mặt).
Quy tắc khi mô tả không nói rõ góc quay: nếu không nói gì đặc biệt về hướng, mặc định "front". Nếu chỉ nói "quay đầu"/"nhìn sang" (không nói "quay người"/"quay lưng"), coi là góc "three_quarter_left" hoặc "three_quarter_right" tương ứng hướng nhìn, KHÔNG phải "back". Chỉ chọn "back" khi mô tả rõ ràng nhân vật quay LƯNG/CẢ NGƯỜI lại camera.
Chỉ trả về DUY NHẤT 1 mảng JSON gồm đúng N phần tử, mỗi phần tử là 1 object có 2 khoá "description" (chuỗi tiếng Anh mô tả cảnh, dùng để tạo ảnh AI) và "camera_view" (1 trong 6 giá trị ở trên) — không kèm markdown fence, không giải thích, không đánh số.
Ví dụ format: [{"description": "a young woman walking into a coffee shop, morning light", "camera_view": "front"}, {"description": "she turns her head and looks outside the window, smiling", "camera_view": "three_quarter_left"}]`;

// Bước "Tạo Character" — chạy trước khi chia cảnh: biến (các) ảnh gốc khách tải lên (thường 1 góc,
// ánh sáng/nền lộn xộn) thành 1 ảnh sheet nhiều góc chuẩn (chính diện/3-4 trái/3-4 phải/nghiêng/sau
// lưng/cận mặt), dùng LÀM tham chiếu chung cho mọi lần gọi model ảnh phân cảnh sau đó — giúp nhân vật
// đồng nhất qua các cảnh tốt hơn nhiều so với dùng thẳng ảnh gốc lộn xộn mỗi lần. Cố định GPT Image 2
// (đã kiểm chứng qua nghiên cứu: model này dựng được bố cục nhiều-panel-trong-1-ảnh khá tin cậy qua 1
// lần gọi duy nhất — tính giá theo ĐỘ PHÂN GIẢI OUTPUT, không theo số panel trong ảnh).
const CHARACTER_SHEET_MODEL = "fal-ai/gpt-image-2/edit";
// Giá GPT Image 2 @1024px đã tra fal.ai (xem migration-story-video-gpt-image2-resolution.sql) — cố
// định 1 mức giá, không cho khách chọn độ phân giải riêng cho bước này (giữ đơn giản, đủ dùng làm
// ảnh tham chiếu nội bộ, không phải ảnh xuất bản cuối cùng).
const CHARACTER_PROVIDER_COST_VND = 5700;
const CHARACTER_SHEET_PROMPT =
  "You are given one or more reference images of the SAME person — they may be ordinary photos and/or an existing multi-panel character sheet. Do NOT simply copy, crop, or pass through any single input image as-is, even if one of them already looks like a finished sheet. Always render a brand-new single image from scratch: one wide landscape canvas on a neutral light-gray studio background, divided into 6 equal panels labeled 1) FRONT VIEW (full body), 2) 3/4 LEFT VIEW (full body), 3) 3/4 RIGHT VIEW (full body), 4) SIDE VIEW (full body), 5) BACK VIEW (full body), 6) FACE CLOSE-UP. Extract the person's face, hairstyle, outfit, and body proportions by combining evidence from ALL provided reference images equally, and keep them identical and consistent across all six panels — do not invent a different person. Even, soft studio lighting, photorealistic, sharp focus.";

// Phân loại ảnh khách vừa tải lên: đã là 1 sheet nhiều góc (không cần tạo lại, dùng thẳng) hay chỉ là
// 1 ảnh chụp thường (cần chạy bước Tạo Character). Dùng Gemini Flash (đã có sẵn qua callOpenRouter,
// chi phí ~18đ/lần — rẻ hơn ảnh Character ~300 lần) thay vì đoán bằng heuristic không đáng tin.
const CHARACTER_CLASSIFY_SYSTEM_PROMPT = `Bạn là trợ lý phân loại ảnh. Nhìn ảnh được cung cấp và trả lời DUY NHẤT 1 từ, không giải thích, không thêm chữ nào khác:
- "SHEET" nếu ảnh là 1 tấm ghép nhiều ô/panel thể hiện nhiều góc nhìn khác nhau (chính diện, nghiêng, sau lưng...) của CÙNG một người.
- "PHOTO" nếu ảnh chỉ là 1 bức ảnh chụp thường (1 người, 1 góc, không chia ô).`;

export async function classifyCharacterImage(imageUrl: string): Promise<boolean> {
  try {
    const { output } = await callOpenRouter(
      "google/gemini-3-flash-preview",
      30,
      CHARACTER_CLASSIFY_SYSTEM_PROMPT,
      "Phân loại ảnh này.",
      imageUrl
    );
    // maxTokens nhỏ trước đây (10) có thể cắt cụt câu trả lời trước khi ra hết chữ "SHEET" -> nới token
    // + so khớp bằng includes (không chỉ startsWith) để không bỏ lỡ khi model có thêm chữ thừa dù đã
    // yêu cầu trả đúng 1 từ.
    const cleaned = output.trim().toUpperCase();
    const isSheet = cleaned.includes("SHEET");
    if (!isSheet && !cleaned.includes("PHOTO")) {
      console.error(`[classifyCharacterImage] Phản hồi không rõ ràng, coi như ảnh thường: "${output}"`);
    }
    return isSheet;
  } catch (err) {
    // Lỗi gọi AI phân loại -> coi như ảnh thường, chạy bước Tạo Character cho chắc (an toàn hơn bỏ qua).
    console.error("[classifyCharacterImage] Lỗi gọi AI phân loại:", err);
    return false;
  }
}

// Dò TẤT CẢ ảnh khách tải lên (không chỉ ảnh đầu) — khách có thể tải nhiều ảnh, trong đó 1 ảnh nào đó
// (không nhất thiết ảnh đầu tiên) đã là sheet nhiều góc sẵn. Trả về URL ảnh sheet đầu tiên tìm được,
// hoặc null nếu không ảnh nào là sheet (cần chạy bước Tạo Character từ toàn bộ ảnh).
export async function findExistingCharacterSheet(imageUrls: string[]): Promise<string | null> {
  for (const url of imageUrls) {
    if (await classifyCharacterImage(url)) return url;
  }
  return null;
}

// Kiểm tra TOÀN BỘ ảnh vừa tải lên (không chỉ 1 ảnh) — chỉ true khi TẤT CẢ đều đã là sheet nhiều góc
// sẵn (không có ảnh thường lẫn vào). Dùng để quyết định có thể bỏ qua bước tạo Character MỚI hay
// không, khác với findExistingCharacterSheet (chỉ cần tìm thấy 1 ảnh là sheet, dùng cho nút "Kiểm tra
// ảnh" xem trước).
export async function classifyAllAreSheets(imageUrls: string[]): Promise<boolean> {
  for (const url of imageUrls) {
    if (!(await classifyCharacterImage(url))) return false;
  }
  return true;
}

export async function computeCharacterCreditCost(): Promise<{ providerCostVnd: number; creditCost: number }> {
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const creditCost = computeDynamicCreditCost(CHARACTER_PROVIDER_COST_VND, marginPercent, vndPerCredit);
  return { providerCostVnd: CHARACTER_PROVIDER_COST_VND, creditCost };
}

export type ImageModelEntry = {
  key: string;
  provider: string;
  label: string;
  model: string;
  provider_cost_vnd: number;
  multi_image: boolean;
  enabled: boolean;
  aspect_ratios?: string[];
  // Có thì frontend hiện dropdown "Độ phân giải", giá đổi theo lựa chọn — model không có field này
  // (vd Flux Kontext) chỉ dùng 1 giá cố định provider_cost_vnd, không hiện dropdown.
  resolution_price_vnd?: Record<string, number>;
};

export type VideoModelEntry = {
  key: string;
  provider: string;
  label: string;
  model: string;
  provider_cost_vnd: number;
  enabled: boolean;
  aspect_ratios?: string[];
  // Có thì frontend hiện dropdown "Thời lượng", giá đổi theo lựa chọn — cùng khuôn
  // provider_cost_vnd_by_duration đã dùng cho app "Tạo video quảng cáo ngắn" (lib/ai-router.ts).
  duration_price_vnd?: Record<string, number>;
};

export type SceneRow = {
  id: number;
  job_id: number;
  position: number;
  scene_description: string | null;
  image_fal_request_id: string | null;
  image_url: string | null;
  video_fal_request_id: string | null;
  video_url: string | null;
};

type JobRow = {
  id: number;
  user_id: string;
  mini_app_id: string;
  status: string;
  updated_at: string;
  auto_video: boolean;
  image_credit_tx_id: number | null;
  video_credit_tx_id: number | null;
  character_credit_tx_id: number | null;
  image_provider_cost_vnd_per_scene: number | null;
  video_provider_cost_vnd_per_scene: number | null;
  num_scenes: number;
  story_description: string;
  character_image_urls: string[];
  character_sheet_url: string | null;
  character_fal_request_id: string | null;
  image_model: string | null;
  video_model: string | null;
  aspect_ratio: string | null;
  image_resolution_key: string | null;
  video_duration_key: string | null;
};

async function getMiniAppModelConfig(miniAppId: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("credit_cost, model_config").eq("id", miniAppId).single();
  if (!data) throw new Error("Không tìm thấy Mini App");
  return data as {
    credit_cost: number;
    model_config: {
      image_models: ImageModelEntry[];
      video_models: VideoModelEntry[];
      prompt_helper_instructions?: string;
      character_prompt?: string;
    };
  };
}

// Prompt tạo Character — admin sửa được qua /admin (model_config.character_prompt), rỗng thì dùng bản
// mặc định 6 góc (CHARACTER_SHEET_PROMPT).
async function resolveCharacterPrompt(miniAppId: string): Promise<string> {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const override = miniApp.model_config.character_prompt;
  return override?.trim() ? override.trim() : CHARACTER_SHEET_PROMPT;
}

// Chọn đúng entry theo key nếu còn bật (enabled) — key thiếu/sai/bị tắt thì rơi về entry bật đầu
// tiên trong catalog (giữ app luôn chạy được kể cả khi admin vừa tắt model khách đang chọn dở).
function resolveModelEntry<T extends { key: string; enabled: boolean }>(entries: T[], key: string | undefined): T {
  const found = key ? entries.find((e) => e.key === key && e.enabled) : undefined;
  const fallback = found ?? entries.find((e) => e.enabled);
  if (!fallback) throw new Error("Không có model nào đang bật trong catalog");
  return fallback;
}

// Chọn key trong 1 bảng giá theo lựa chọn/độ phân giải/thời lượng — key thiếu/sai thì rơi về key
// đầu tiên trong bảng (giữ app luôn tính được giá kể cả khi frontend gửi key cũ không còn tồn tại).
function resolvePricedKey(priceMap: Record<string, number>, key: string | undefined): { key: string; costVnd: number } {
  const resolvedKey = key && priceMap[key] !== undefined ? key : Object.keys(priceMap)[0];
  return { key: resolvedKey, costVnd: priceMap[resolvedKey] };
}

async function resolveCosts(
  miniAppId: string,
  numScenes: number,
  imageModelKey?: string,
  videoModelKey?: string,
  resolutionKey?: string,
  durationKey?: string
) {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const imageEntry = resolveModelEntry(miniApp.model_config.image_models, imageModelKey);
  const videoEntry = resolveModelEntry(miniApp.model_config.video_models, videoModelKey);

  let imageProviderCostVnd = imageEntry.provider_cost_vnd;
  let resolvedResolutionKey: string | undefined;
  if (imageEntry.resolution_price_vnd) {
    const resolved = resolvePricedKey(imageEntry.resolution_price_vnd, resolutionKey);
    resolvedResolutionKey = resolved.key;
    imageProviderCostVnd = resolved.costVnd;
  }

  let videoProviderCostVnd = videoEntry.provider_cost_vnd;
  let resolvedDurationKey: string | undefined;
  if (videoEntry.duration_price_vnd) {
    const resolved = resolvePricedKey(videoEntry.duration_price_vnd, durationKey);
    resolvedDurationKey = resolved.key;
    videoProviderCostVnd = resolved.costVnd;
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const imageCost = computeDynamicCreditCost(imageProviderCostVnd * numScenes, marginPercent, vndPerCredit);
  const videoCost = computeDynamicCreditCost(videoProviderCostVnd * numScenes, marginPercent, vndPerCredit);
  return {
    imageEntry,
    videoEntry,
    imageCost,
    videoCost,
    totalCost: imageCost + videoCost,
    imageProviderCostVnd,
    videoProviderCostVnd,
    resolvedResolutionKey,
    resolvedDurationKey,
    promptHelperInstructions: miniApp.model_config.prompt_helper_instructions,
  };
}

export async function computeStoryVideoCreditCost(
  miniAppId: string,
  numScenes: number,
  imageModelKey?: string,
  videoModelKey?: string,
  resolutionKey?: string,
  durationKey?: string
): Promise<{ imageCost: number; videoCost: number; totalCost: number }> {
  const { imageCost, videoCost, totalCost } = await resolveCosts(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);
  return { imageCost, videoCost, totalCost };
}

// Body request Fal.ai theo model ảnh — mỗi model có field tên khác nhau đã tra kỹ docs thật (tránh
// lặp lỗi 422 do gửi sai tên field từng gặp với LTX):
// - GPT Image 2 edit: image_size (không nhận aspect_ratio riêng, dùng "auto" giữ tỉ lệ ảnh gốc).
// - Nano Banana Pro edit: resolution nhận "1K"/"2K"/"4K".
// - Còn lại (Flux Kontext...): aspect_ratio thường.
function buildImageRequestBody(
  model: string,
  prompt: string | null,
  characterImageUrls: string[],
  multiImage: boolean,
  aspectRatio: string,
  resolutionKey?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt };
  if (multiImage) body.image_urls = characterImageUrls;
  else body.image_url = characterImageUrls[0];

  if (model === "fal-ai/gpt-image-2/edit") {
    // Không nhận aspect_ratio riêng — field điều khiển kích thước là image_size, nhận preset chuỗi
    // hoặc object {width,height} tuỳ độ phân giải. Giá thật đổi theo mức này (đã tra docs).
    if (resolutionKey === "4K") body.image_size = { width: 3840, height: 2160 };
    else if (resolutionKey === "1024") body.image_size = "square_hd";
    else body.image_size = "auto";
    return body;
  }
  body.aspect_ratio = aspectRatio;
  if (resolutionKey) body.resolution = resolutionKey;
  return body;
}

// Body request Fal.ai theo model video — VEO cần hậu tố "s" cho duration ("6s", không phải "6"),
// Hailuo cố định resolution "768P" để khớp đúng giá đã nghiên cứu, còn lại theo mẫu Kling/LTX sẵn có.
function buildVideoRequestBody(model: string, prompt: string | null, imageUrl: string, aspectRatio: string, durationKey?: string): Record<string, unknown> {
  if (model === "fal-ai/veo3/image-to-video") {
    return { prompt, image_url: imageUrl, duration: `${durationKey ?? "6"}s`, generate_audio: false };
  }
  if (model === "fal-ai/minimax/hailuo-02/standard/image-to-video") {
    return { prompt, image_url: imageUrl, duration: durationKey ?? "6", resolution: "768P" };
  }
  const body: Record<string, unknown> = { prompt, image_url: imageUrl, aspect_ratio: aspectRatio };
  if (durationKey) body.duration = durationKey;
  return body;
}

async function submitFalJob(model: string, body: Record<string, unknown>, webhookUrl: string): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const res = await fetch(`https://queue.fal.run/${model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown Fal.ai error");
    throw new Error(`Fal.ai lỗi: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.request_id as string;
}

function extractVideoUrl(falPayload: Record<string, unknown>): string | undefined {
  const inner = falPayload.payload as Record<string, unknown> | undefined;
  return (
    (inner?.video as { url?: string } | undefined)?.url ??
    (falPayload.video as { url?: string } | undefined)?.url ??
    (inner?.video_url as string | undefined) ??
    (falPayload.video_url as string | undefined)
  );
}

function extractImageUrl(falPayload: Record<string, unknown>): string | undefined {
  const inner = falPayload.payload as Record<string, unknown> | undefined;
  const images = (inner?.images ?? falPayload.images) as { url?: string }[] | undefined;
  return images?.[0]?.url ?? (inner?.image as { url?: string } | undefined)?.url ?? (falPayload.image as { url?: string } | undefined)?.url;
}

// Chia truyện thành đúng numScenes phân cảnh qua LLM — callOpenRouter không ép response_format nên
// phải tự phòng thủ: bóc markdown fence nếu có, parse JSON, kiểm tra đúng kiểu + đúng số lượng, sai
// thì thử lại 1 lần với nhắc nhở nghiêm ngặt hơn trước khi báo lỗi hẳn.
// "Model chat" — LLM thực thi bước chia cảnh, tách biệt với "Agent" (persona/hướng dẫn). Whitelist
// cứng 2 model đã kiểm chứng (đúng danh sách MODEL_OPTIONS admin dùng cho app tự tạo dạng text) —
// không cho truyền chuỗi model tuỳ ý từ client để tránh gọi nhầm model lạ/tốn phí ngoài ý muốn.
const ALLOWED_CHAT_MODELS = ["google/gemini-3-flash-preview", "anthropic/claude-sonnet-4.6"];

export type SceneSplitResult = { description: string; camera_view: CharacterAngleKey };

export async function splitStoryIntoScenes(
  storyDescription: string,
  numScenes: number,
  customInstructions?: string,
  modelChatKey?: string
): Promise<SceneSplitResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  // "Agent xử lý" — admin thêm hướng dẫn phong cách/chủ đề qua model_config.prompt_helper_instructions
  // (đúng field/UI đã dùng cho nút "AI viết giúp mô tả" ở app video-gen). Nối THÊM vào cuối, không
  // thay hẳn — bắt buộc giữ nguyên yêu cầu "chỉ trả JSON đúng N phần tử" để pipeline không gãy.
  const basePrompt = SCENE_SPLIT_SYSTEM_PROMPT.replace("N phân cảnh", `${numScenes} phân cảnh`);
  const systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  async function attempt(reminder?: string): Promise<SceneSplitResult[]> {
    const userInput = reminder
      ? `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng. Chỉ trả về mảng JSON gồm đúng ${numScenes} object {description, camera_view}, không thêm gì khác.)`
      : storyDescription;
    const { output } = await callOpenRouter(chatModel, 800, systemPrompt, userInput);
    const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("not-json");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== numScenes ||
      !parsed.every(
        (s) =>
          s &&
          typeof s === "object" &&
          typeof (s as { description?: unknown }).description === "string" &&
          (s as { description: string }).description.trim() &&
          CHARACTER_ANGLE_LABELS.includes((s as { camera_view?: unknown }).camera_view as CharacterAngleKey)
      )
    ) {
      throw new Error("wrong-shape");
    }
    return parsed as SceneSplitResult[];
  }

  try {
    return await attempt();
  } catch {
    try {
      return await attempt("retry");
    } catch {
      throw new Error("AI không chia được phân cảnh hợp lệ, vui lòng thử lại hoặc viết ý tưởng rõ ràng hơn");
    }
  }
}

type SceneStageInput = Pick<
  JobRow,
  | "id"
  | "mini_app_id"
  | "auto_video"
  | "image_provider_cost_vnd_per_scene"
  | "video_provider_cost_vnd_per_scene"
  | "num_scenes"
  | "image_model"
  | "aspect_ratio"
  | "image_resolution_key"
  | "character_sheet_url"
>;

// Trừ credit phần ảnh (+ video nếu auto_video) rồi chạy chia cảnh (LLM) + submit ảnh cho từng cảnh,
// dùng character_sheet_url làm tham chiếu chung — tách riêng để dùng chung cho 2 nơi gọi: (1)
// continueStoryVideoToSceneStage (khách bấm "Tiếp tục chia cảnh" sau khi duyệt Character mới tạo),
// (2) submitStoryVideoJob khi Character đã chắc chắn 100% ngay từ đầu (chọn từ thư viện, hoặc TOÀN BỘ
// ảnh tải lên đã là sheet sẵn) — bỏ qua hẳn màn xem trước, chạy thẳng 1 lượt nếu đã có Ý tưởng truyện.
async function runSceneStage(
  userId: string,
  job: SceneStageInput,
  finalStoryDescription: string,
  modelChatKey: string | undefined,
  idempotencyKey: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");
  if (!job.image_provider_cost_vnd_per_scene || !job.video_provider_cost_vnd_per_scene) {
    throw new Error("Thiếu dữ liệu giá của job");
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const imageCost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);
  const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, job.auto_video ? imageCost + videoCost : imageCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  await supabase
    .from("story_video_jobs")
    .update({ status: "splitting_story", image_credit_tx_id: deduction.txId, story_description: finalStoryDescription })
    .eq("id", job.id);

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    const scenes = await splitStoryIntoScenes(finalStoryDescription, job.num_scenes, miniApp.model_config.prompt_helper_instructions, modelChatKey);

    const { data: sceneRows, error: sceneError } = await supabase
      .from("story_video_scenes")
      .insert(
        scenes.map((scene, index) => ({
          job_id: job.id,
          position: index,
          scene_description: scene.description,
          camera_view: scene.camera_view,
        }))
      )
      .select("id, position, scene_description");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    await Promise.all(
      sceneRows.map(async (row) => {
        const body = buildImageRequestBody(
          job.image_model as string,
          row.scene_description,
          [job.character_sheet_url as string],
          imageEntry?.multi_image ?? false,
          job.aspect_ratio ?? "9:16",
          job.image_resolution_key ?? undefined
        );
        const requestId = await submitFalJob(
          job.image_model as string,
          body,
          `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&sceneId=${row.id}&stage=image`
        );
        await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", row.id);
      })
    );

    await supabase.from("story_video_jobs").update({ status: "generating_images" }).eq("id", job.id);
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Bước 1: nhận request khách bấm "Chạy ngay" -> xử lý Character (chọn từ thư viện / phân loại ảnh đã
// là sheet / tạo mới qua GPT Image 2). Nếu Character đã chắc chắn 100% (chọn từ thư viện, hoặc TOÀN
// BỘ ảnh tải lên đã là sheet sẵn — không ảnh thường nào lẫn vào) VÀ khách đã gõ sẵn Ý tưởng truyện,
// chạy thẳng luôn sang chia cảnh + tạo ảnh trong 1 lượt (runSceneStage), không dừng ở màn xem trước
// Character nữa — vì không có gì cần khách duyệt (Character này không phải AI vừa tạo mới). Nếu vẫn
// còn phải tạo Character mới, hoặc Ý tưởng truyện chưa có, giữ nguyên hành vi cũ: dừng ở
// "character_ready" chờ khách xem/duyệt rồi bấm "Tiếp tục chia cảnh" (continueStoryVideoToSceneStage).
export async function submitStoryVideoJob(
  userId: string,
  miniAppId: string,
  storyDescription: string,
  numScenes: number,
  characterImageUrls: string[],
  imageModelKey: string | undefined,
  videoModelKey: string | undefined,
  autoVideo: boolean,
  aspectRatio: string,
  resolutionKey: string | undefined,
  durationKey: string | undefined,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  reuseCharacterId?: number,
  skipCharacterCreation?: boolean
): Promise<{ jobId: number; newBalance: number }> {
  if (numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
  }

  const supabase = getSupabaseAdmin();

  // Chọn từ thư viện đã lưu -> biết chắc 100% đây là Character chuẩn (chính hệ thống tạo ra trước
  // đó), bỏ qua hoàn toàn bước validate/phân loại ảnh tải lên mới.
  let reusedImageUrl: string | null = null;
  let reusedAngleUrls: CharacterAngleUrls | null = null;
  if (reuseCharacterId) {
    const { data: saved } = await supabase
      .from("story_characters")
      .select("id, user_id, image_url, angle_urls")
      .eq("id", reuseCharacterId)
      .single();
    if (!saved || saved.user_id !== userId) throw new Error("Không tìm thấy Character đã lưu");
    reusedImageUrl = saved.image_url;
    reusedAngleUrls = (saved.angle_urls as CharacterAngleUrls | null) ?? null;
  } else if (characterImageUrls.length < MIN_CHARACTER_IMAGES || characterImageUrls.length > MAX_CHARACTER_IMAGES) {
    throw new Error(`Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật`);
  }

  const { imageEntry, videoEntry, imageProviderCostVnd, videoProviderCostVnd, resolvedResolutionKey, resolvedDurationKey } =
    await resolveCosts(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "pending",
      story_description: storyDescription,
      num_scenes: numScenes,
      character_image_urls: characterImageUrls,
      image_model: imageEntry.model,
      video_model: videoEntry.model,
      auto_video: autoVideo,
      aspect_ratio: aspectRatio,
      image_resolution_key: resolvedResolutionKey ?? null,
      video_duration_key: resolvedDurationKey ?? null,
      image_provider_cost_vnd_per_scene: imageProviderCostVnd,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
    })
    .select("id")
    .single();

  if (insertError || !job) throw new Error(insertError?.message ?? "Không tạo được job");

  const finalStoryDescription = storyDescription.trim();
  const sceneStageJob: SceneStageInput = {
    id: job.id,
    mini_app_id: miniAppId,
    auto_video: autoVideo,
    image_provider_cost_vnd_per_scene: imageProviderCostVnd,
    video_provider_cost_vnd_per_scene: videoProviderCostVnd,
    num_scenes: numScenes,
    image_model: imageEntry.model,
    aspect_ratio: aspectRatio,
    image_resolution_key: resolvedResolutionKey ?? null,
    character_sheet_url: null,
  };

  let characterTxId: number | null = null;
  try {
    if (reusedImageUrl) {
      await supabase
        .from("story_video_jobs")
        .update({
          status: "character_ready",
          character_sheet_url: reusedImageUrl,
          character_source: "reused",
          character_angle_urls: reusedAngleUrls,
        })
        .eq("id", job.id);
      if (finalStoryDescription) {
        sceneStageJob.character_sheet_url = reusedImageUrl;
        return { jobId: job.id, ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey)) };
      }
    } else {
      // Khách chủ động tick "Bỏ qua tạo Character" — dùng thẳng ảnh đầu tiên đã tải làm tham chiếu
      // duy nhất cho mọi cảnh sau này, bỏ qua hẳn bước phân loại + tạo sheet mới (tiết kiệm credit,
      // nhưng chỉ có đúng 1 góc ảnh nên các cảnh cần góc khác dễ kém đồng nhất hơn — đã cảnh báo
      // khách ở giao diện trước khi tick).
      const skipEntirely = skipCharacterCreation === true;
      // Kiểm tra TOÀN BỘ ảnh tải lên (không chỉ ảnh đầu) — chỉ dùng thẳng khi TẤT CẢ đều đã là sheet
      // sẵn (rõ ràng không cần tạo mới). Nếu có lẫn dù chỉ 1 ảnh thường: luôn tạo Character mới dùng
      // TOÀN BỘ ảnh làm tư liệu — tránh bỏ sót ảnh thường khách muốn AI tham chiếu thêm.
      const allAreSheets = skipEntirely ? true : await classifyAllAreSheets(characterImageUrls);
      if (allAreSheets) {
        const sheetUrl = characterImageUrls[0];
        await supabase
          .from("story_video_jobs")
          .update({
            status: "character_ready",
            character_sheet_url: sheetUrl,
            character_source: skipEntirely ? "skipped" : "uploaded_sheet",
          })
          .eq("id", job.id);
        if (finalStoryDescription) {
          sceneStageJob.character_sheet_url = sheetUrl;
          return { jobId: job.id, ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey)) };
        }
      } else {
        const { creditCost } = await computeCharacterCreditCost();
        const deduction = await deductCredit(userId, creditCost, miniAppId, idempotencyKey);
        if (!deduction.success) throw new InsufficientCreditError();
        characterTxId = deduction.txId ?? null;

        const characterPrompt = await resolveCharacterPrompt(miniAppId);
        const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, characterImageUrls, true, "1:1", undefined);
        const requestId = await submitFalJob(
          CHARACTER_SHEET_MODEL,
          body,
          `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&stage=character`
        );
        await supabase
          .from("story_video_jobs")
          .update({
            status: "generating_character",
            character_source: "generated",
            character_credit_tx_id: characterTxId,
            character_fal_request_id: requestId,
          })
          .eq("id", job.id);
      }
    }
  } catch (err) {
    await supabase
      .from("story_video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (characterTxId) await refundCredit(characterTxId);
    throw err;
  }

  return { jobId: job.id, newBalance: await getCreditBalance(userId) };
}

// Khách bấm "Tiếp tục chia cảnh" sau khi xem/duyệt ảnh Character (job đang ở "character_ready") — trừ
// credit phần ảnh (đã snapshot provider_cost_vnd/cảnh lúc submit) rồi chạy chia cảnh (LLM) + submit
// ảnh cho từng cảnh, dùng character_sheet_url làm tham chiếu chung thay vì ảnh gốc lộn xộn.
export async function continueStoryVideoToSceneStage(
  userId: string,
  jobId: number,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  storyDescription?: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "character_ready") throw new Error("Job không ở trạng thái sẵn sàng chia cảnh");
  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");

  // Bước Tạo Character không cần ý tưởng truyện, nên khách có thể chưa nhập lúc submit — bắt buộc
  // nhập ở đây trước khi chia cảnh (thứ dùng thật). Cho phép ghi đè/cập nhật nếu khách vừa gõ/sửa lại
  // ngay tại màn hình xem trước Character.
  const finalStoryDescription = storyDescription?.trim() || job.story_description?.trim();
  if (!finalStoryDescription) throw new Error("Thiếu ý tưởng truyện");

  return runSceneStage(userId, job, finalStoryDescription, modelChatKey, idempotencyKey);
}

const SCENE_PROMPT_FROM_IMAGE_SYSTEM =
  "You are a screenwriter writing a short motion prompt (1-2 sentences, English) for the given image, to be used as an image-to-video generation prompt. Base it on: what's visible in the image, the overall story context provided, and the customer's hint if given. Return ONLY the motion description, no explanation, no extra text.";

async function generateSceneDescriptionFromImage(
  imageUrl: string,
  hint: string | undefined,
  storyDescription: string,
  modelChatKey: string | undefined
): Promise<string> {
  const userPrompt = `Ý tưởng truyện tổng thể: ${storyDescription}${hint ? `\nGợi ý riêng cho cảnh này: ${hint}` : ""}\nViết mô tả chuyển động ngắn cho ảnh này.`;
  const { output } = await callOpenRouter(modelChatKey || "google/gemini-3-flash-preview", 120, SCENE_PROMPT_FROM_IMAGE_SYSTEM, userPrompt, imageUrl);
  return output.trim();
}

// Khách đã có sẵn ảnh cho từng phân cảnh (tải lên thay vì để AI tạo) -> bỏ qua hoàn toàn bước Character
// + bước AI tạo ảnh phân cảnh (không cần model ảnh, không tốn credit ảnh) — chỉ cần Agent viết mô tả
// chuyển động (dựa vào ảnh + gợi ý tuỳ chọn của khách + Ý tưởng truyện) để dùng làm prompt tạo VIDEO.
// Dừng ở "images_ready" (hoặc chạy thẳng tới video nếu autoVideo) giống hệt luồng AI tự tạo, dùng
// chung toàn bộ phần hiển thị/tiếp tục phía sau — không cần thêm status hay UI kết quả riêng.
export async function submitStoryVideoJobWithOwnImages(
  userId: string,
  miniAppId: string,
  storyDescription: string,
  sceneImages: { imageUrl: string; hint?: string }[],
  videoModelKey: string | undefined,
  autoVideo: boolean,
  aspectRatio: string,
  durationKey: string | undefined,
  modelChatKey: string | undefined,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  const numScenes = sceneImages.length;
  if (numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
  }
  const finalStoryDescription = storyDescription.trim();
  if (!finalStoryDescription) throw new Error("Thiếu ý tưởng truyện");

  const supabase = getSupabaseAdmin();
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const videoEntry = resolveModelEntry(miniApp.model_config.video_models, videoModelKey);

  let videoProviderCostVnd = videoEntry.provider_cost_vnd;
  let resolvedDurationKey: string | undefined;
  if (videoEntry.duration_price_vnd) {
    const resolved = resolvePricedKey(videoEntry.duration_price_vnd, durationKey);
    resolvedDurationKey = resolved.key;
    videoProviderCostVnd = resolved.costVnd;
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const videoCost = computeDynamicCreditCost(videoProviderCostVnd * numScenes, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, videoCost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "splitting_story",
      story_description: finalStoryDescription,
      num_scenes: numScenes,
      character_image_urls: [],
      video_model: videoEntry.model,
      auto_video: autoVideo,
      aspect_ratio: aspectRatio,
      video_duration_key: resolvedDurationKey ?? null,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
      video_credit_tx_id: deduction.txId,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await safeRefund(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được job");
  }

  try {
    const scenes = await Promise.all(
      sceneImages.map(async (s, index) => {
        const description = await generateSceneDescriptionFromImage(s.imageUrl, s.hint, finalStoryDescription, modelChatKey);
        return { job_id: job.id, position: index, scene_description: description, image_url: s.imageUrl };
      })
    );
    const { error: sceneError } = await supabase.from("story_video_scenes").insert(scenes);
    if (sceneError) throw new Error(sceneError.message);

    if (autoVideo) {
      const sceneRows = await getScenes(job.id);
      await proceedToVideoStage(job.id, sceneRows);
    } else {
      await supabase.from("story_video_jobs").update({ status: "images_ready" }).eq("id", job.id);
    }
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { jobId: job.id, newBalance: await getCreditBalance(userId) };
}

// Khách chưa ưng ảnh Character (job đang ở "character_ready") -> ép tạo lại từ đúng ảnh gốc đã tải
// lên lúc submit. Không hoàn credit lần tạo trước (đã tốn phí gọi model thật, coi là chi phí đã chi
// để thử) — chỉ tính thêm credit cho lần tạo mới.
export async function regenerateCharacter(userId: string, jobId: number, idempotencyKey: string): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "character_ready") throw new Error("Job không ở trạng thái xem trước Character");
  if (!job.character_image_urls || job.character_image_urls.length === 0) {
    throw new Error("Job này không có ảnh gốc để tạo lại (đang dùng Character đã lưu từ thư viện)");
  }

  const { creditCost } = await computeCharacterCreditCost();
  const deduction = await deductCredit(userId, creditCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const characterPrompt = await resolveCharacterPrompt(job.mini_app_id);
    const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, job.character_image_urls, true, "1:1", undefined);
    const requestId = await submitFalJob(CHARACTER_SHEET_MODEL, body, `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character`);
    await supabase
      .from("story_video_jobs")
      .update({
        status: "generating_character",
        character_source: "generated",
        character_credit_tx_id: deduction.txId,
        character_fal_request_id: requestId,
      })
      .eq("id", jobId);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// jobId (tuỳ chọn): nếu có, lấy luôn character_angle_urls đã cắt sẵn từ job đó gán vào Character lưu
// mới — tránh phải cắt lại từ đầu mỗi lần dùng lại Character này sau này.
export async function saveStoryCharacter(userId: string, imageUrl: string, label?: string, jobId?: number): Promise<number> {
  const supabase = getSupabaseAdmin();
  let angleUrls: CharacterAngleUrls | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select("user_id, character_angle_urls")
      .eq("id", jobId)
      .single();
    if (job && job.user_id === userId) angleUrls = (job.character_angle_urls as CharacterAngleUrls | null) ?? null;
  }
  const { data, error } = await supabase
    .from("story_characters")
    .insert({ user_id: userId, image_url: imageUrl, label: label?.trim() || null, angle_urls: angleUrls })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được Character");
  return data.id;
}

export async function listStoryCharacters(
  userId: string
): Promise<{ id: number; imageUrl: string; label: string | null; createdAt: string }[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("story_characters")
    .select("id, image_url, label, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ id: r.id, imageUrl: r.image_url, label: r.label, createdAt: r.created_at }));
}

export async function deleteStoryCharacter(userId: string, characterId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("story_characters").delete().eq("id", characterId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// refund_credit (RPC) tự chặn hoàn credit trùng qua unique constraint trên idempotency_key
// "{txId}-refund" — nếu 2 lượt gọi failJob() gần như đồng thời cùng hoàn 1 tx (vd Fal.ai gửi trùng
// webhook báo lỗi cho cùng 1 cảnh), lượt thua sẽ nhận lỗi 23505 (duplicate key). Đây KHÔNG phải lỗi
// thật — tx đó đã được hoàn đúng bởi lượt thắng — nên bỏ qua an toàn, không quăng lỗi lên trên.
async function safeRefund(txId: number) {
  try {
    await refundCredit(txId);
  } catch (err) {
    if ((err as { code?: string })?.code !== "23505") throw err;
  }
}

async function failJob(jobId: number, message: string) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select("status, image_credit_tx_id, video_credit_tx_id, character_credit_tx_id")
    .eq("id", jobId)
    .single();
  // Job đã bị đánh fail bởi 1 lượt gọi khác rồi (race) -> đã hoàn credit xong, không cần làm lại.
  if (job?.status === "failed") return;
  await supabase.from("story_video_jobs").update({ status: "failed", error_message: message }).eq("id", jobId);

  // Chỉ hoàn ĐÚNG phần credit của giai đoạn đang dở dang lúc lỗi — dựa vào status NGAY TRƯỚC KHI lỗi
  // (job.status đã select ở trên, trước dòng update phía trên). Trước đây hoàn cả 3 loại tx bất kể
  // đã set hay chưa, nên nếu lỗi xảy ra ở bước VIDEO (sau khi ảnh phân cảnh đã tạo xong, khách đã xem
  // được) thì credit ảnh cũng bị hoàn nhầm dù ảnh đã giao thành công — không đúng, khách đã nhận đúng
  // sản phẩm ảnh rồi thì không nên hoàn lại phần đó.
  if (!job?.image_credit_tx_id && !job?.character_credit_tx_id && job?.video_credit_tx_id) {
    // Job "ảnh phân cảnh tự tải lên" (submitStoryVideoJobWithOwnImages) — chỉ trừ duy nhất 1 loại
    // credit (video) ngay từ đầu, không theo mô hình 3 nấc Character/ảnh/video của luồng AI thường
    // (không có image/character tx nào để suy theo status) — hoàn thẳng luôn.
    await safeRefund(job.video_credit_tx_id);
    return;
  }

  if (job?.status === "generating_videos" || job?.status === "stitching") {
    if (job.video_credit_tx_id) await safeRefund(job.video_credit_tx_id);
  } else if (job?.status === "splitting_story" || job?.status === "generating_images") {
    if (job.image_credit_tx_id) await safeRefund(job.image_credit_tx_id);
  } else {
    if (job?.character_credit_tx_id) await safeRefund(job.character_credit_tx_id);
  }
}

async function getScenes(jobId: number): Promise<SceneRow[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("story_video_scenes").select("*").eq("job_id", jobId).order("position", { ascending: true });
  return (data as SceneRow[]) ?? [];
}

export { getScenes as getStoryVideoScenes };

const CHARACTER_ANGLE_LABELS = ["front", "three_quarter_left", "three_quarter_right", "side", "back", "face"] as const;
export type CharacterAngleKey = (typeof CHARACTER_ANGLE_LABELS)[number];
export type CharacterAngleUrls = Record<CharacterAngleKey, string>;

// Cắt Character sheet (1 ảnh gộp 6 ô, bố cục CỐ ĐỊNH 3 cột x 2 hàng đúng theo CHARACTER_SHEET_PROMPT:
// hàng 1 = front/3-4 trái/3-4 phải, hàng 2 = nghiêng/sau lưng/cận mặt) thành 6 ảnh riêng theo toạ độ
// cố định — không cần AI "nhìn" ảnh để tìm vị trí từng góc, vì bố cục luôn giống nhau khi CHÍNH APP
// tự vẽ ra sheet này. CHỈ dùng cho sheet do app tạo (character_source = 'generated') — sheet khách tự
// tải lên (uploaded_sheet) không đảm bảo đúng bố cục 3x2 này nên không cắt, để null.
async function cropCharacterSheetIntoAngles(sheetUrl: string, userId: string): Promise<CharacterAngleUrls | null> {
  // Log rõ từng lý do fail — không để im lặng trả null như failJob() từng làm với ffmpeg trước đây,
  // khiến không biết bucket chưa tạo (migration chưa chạy) hay lỗi thật khác đang xảy ra.
  try {
    const res = await fetch(sheetUrl);
    if (!res.ok) {
      console.error(`[crop-character] Tải ảnh sheet thất bại: ${res.status} ${sheetUrl}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) {
      console.error(`[crop-character] Không đọc được kích thước ảnh sheet: ${sheetUrl}`);
      return null;
    }

    const cellWidth = Math.floor(metadata.width / 3);
    const cellHeight = Math.floor(metadata.height / 2);
    const supabase = getSupabaseAdmin();
    const urls: Partial<CharacterAngleUrls> = {};

    for (let i = 0; i < CHARACTER_ANGLE_LABELS.length; i++) {
      const label = CHARACTER_ANGLE_LABELS[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const cropped = await sharp(buffer)
        .extract({ left: col * cellWidth, top: row * cellHeight, width: cellWidth, height: cellHeight })
        .jpeg({ quality: 90 })
        .toBuffer();
      const filePath = `${userId}/${label}-${randomUUID()}.jpg`;
      const { error } = await supabase.storage
        .from("story-video-character-angles")
        .upload(filePath, cropped, { contentType: "image/jpeg", upsert: true });
      if (error) {
        console.error(`[crop-character] Upload "${label}" lỗi (có thể do chưa chạy migration tạo bucket): ${error.message}`);
        return null;
      }
      const { data: publicUrlData } = supabase.storage.from("story-video-character-angles").getPublicUrl(filePath);
      urls[label] = publicUrlData.publicUrl;
    }
    return urls as CharacterAngleUrls;
  } catch (err) {
    console.error(`[crop-character] Lỗi cắt Character sheet:`, err);
    return null;
  }
}

// Gọi khi Fal.ai tạo xong ảnh Character sheet (job-level, không phải per-scene) -> dừng ở
// "character_ready" chờ khách xem trước, bấm "Tạo lại" hoặc "Tiếp tục chia cảnh".
export async function applyCharacterStageResult(jobId: number, falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi tạo Character: ${String(falPayload.error ?? "")}`);
    return;
  }

  const imageUrl = extractImageUrl(falPayload);
  if (!imageUrl) {
    await failJob(jobId, "Không tìm thấy URL ảnh Character trong phản hồi Fal.ai");
    return;
  }

  const { data: jobRow } = await supabase.from("story_video_jobs").select("user_id").eq("id", jobId).single();
  const angleUrls = jobRow ? await cropCharacterSheetIntoAngles(imageUrl, jobRow.user_id) : null;

  await supabase
    .from("story_video_jobs")
    .update({ status: "character_ready", character_sheet_url: imageUrl, character_angle_urls: angleUrls })
    .eq("id", jobId);
}

// Gọi khi 1 ảnh giữ nhân vật (bước 1) của 1 cảnh tạo xong. Khi TẤT CẢ cảnh xong: nếu job bật
// auto_video thì chuyển thẳng sang bước video, ngược lại DỪNG ở "images_ready" chờ khách xem trước
// rồi tự bấm "Tạo video" (continueStoryVideoToVideoStage).
export async function applyImageStageResult(jobId: number, sceneId: number, falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi tạo ảnh cảnh: ${String(falPayload.error ?? "")}`);
    return;
  }

  const imageUrl = extractImageUrl(falPayload);
  if (!imageUrl) {
    await failJob(jobId, "Không tìm thấy URL ảnh trong phản hồi Fal.ai");
    return;
  }

  await supabase.from("story_video_scenes").update({ image_url: imageUrl }).eq("id", sceneId);

  const scenes = await getScenes(jobId);
  if (scenes.length === 0 || scenes.some((s) => !s.image_url)) return; // chờ cảnh còn lại

  const { data: job } = await supabase.from("story_video_jobs").select("auto_video").eq("id", jobId).single();
  if (job?.auto_video) {
    await proceedToVideoStage(jobId, scenes);
  } else {
    await supabase.from("story_video_jobs").update({ status: "images_ready" }).eq("id", jobId);
  }
}

async function proceedToVideoStage(jobId: number, scenes: SceneRow[]) {
  const supabase = getSupabaseAdmin();
  try {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select("video_model, aspect_ratio, video_duration_key")
      .eq("id", jobId)
      .single();
    if (!job?.video_model) throw new Error("Không tìm thấy model video của job");

    await Promise.all(
      scenes.map(async (scene) => {
        const body = buildVideoRequestBody(
          job.video_model as string,
          scene.scene_description,
          scene.image_url as string,
          job.aspect_ratio ?? "9:16",
          job.video_duration_key ?? undefined
        );
        const requestId = await submitFalJob(
          job.video_model as string,
          body,
          `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&sceneId=${scene.id}&stage=video`
        );
        await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", scene.id);
      })
    );

    await supabase.from("story_video_jobs").update({ status: "generating_videos" }).eq("id", jobId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

// Khách bấm "Tạo video" sau khi xem ảnh phân cảnh (job đang ở "images_ready") — trừ riêng phần credit
// video (đã snapshot provider_cost_vnd/cảnh lúc submit, không phụ thuộc catalog hiện tại) rồi mới
// submit các job video.
export async function continueStoryVideoToVideoStage(userId: string, jobId: number, idempotencyKey: string): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "images_ready") {
    // Cho phép THỬ LẠI khi job đã "failed" nhưng ảnh phân cảnh đã tạo xong đầy đủ trước đó (lỗi xảy
    // ra ở bước tạo VIDEO sau đó, không phải ở bước ảnh) — tránh bắt khách làm lại từ đầu (tải ảnh
    // nhân vật, tạo Character, chia cảnh...) dù ảnh đã có sẵn và còn dùng được.
    const scenes = job.status === "failed" ? await getScenes(jobId) : [];
    const imagesAllReady = scenes.length > 0 && scenes.every((s) => s.image_url);
    if (!imagesAllReady) throw new Error("Job không ở trạng thái sẵn sàng tạo video");
  }
  if (!job.video_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá video của job");

  // Luồng "ảnh phân cảnh tự tải lên" (submitStoryVideoJobWithOwnImages) đã trừ credit video ngay lúc
  // submit (không có nấc ảnh riêng để trừ sau) — nếu trừ thêm ở đây sẽ tính tiền 2 lần cho cùng 1 lượt
  // tạo video. Chỉ trừ credit ở đây khi job CHƯA có video_credit_tx_id (đúng luồng AI tự tạo ảnh).
  let newBalance: number;
  if (job.video_credit_tx_id) {
    newBalance = await getCreditBalance(userId);
  } else {
    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

    const deduction = await deductCredit(userId, videoCost, job.mini_app_id, idempotencyKey);
    if (!deduction.success) throw new InsufficientCreditError();

    await supabase.from("story_video_jobs").update({ video_credit_tx_id: deduction.txId }).eq("id", jobId);
    newBalance = deduction.newBalance;
  }

  const scenes = await getScenes(jobId);
  await proceedToVideoStage(jobId, scenes);

  return { newBalance };
}

// Gọi khi 1 clip video (bước 2) của 1 cảnh xong — khi TẤT CẢ cảnh xong mới ghép lại thành video cuối.
export async function applyVideoStageResult(jobId: number, sceneId: number, falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi tạo video cảnh: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    await failJob(jobId, "Không tìm thấy URL video trong phản hồi Fal.ai");
    return;
  }

  await supabase.from("story_video_scenes").update({ video_url: videoUrl }).eq("id", sceneId);

  const scenes = await getScenes(jobId);
  if (scenes.length === 0 || scenes.some((s) => !s.video_url)) return; // chờ cảnh còn lại

  await stitchAndFinish(jobId, scenes);
}

// Ghép N clip (theo đúng thứ tự "position") thành 1 video liền mạch — dùng lại ffmpeg đã tích hợp
// sẵn cho tính năng "Video đồng nhất nhân vật".
async function stitchAndFinish(jobId: number, scenes: SceneRow[]) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("story_video_jobs").select("user_id, mini_app_id").eq("id", jobId).single();
  if (!job) return;

  await supabase.from("story_video_jobs").update({ status: "stitching" }).eq("id", jobId);

  if (!ffmpegPath) {
    await failJob(jobId, "Máy chủ chưa hỗ trợ ghép video (thiếu ffmpeg)");
    return;
  }
  // ffmpeg-static hay bị mất quyền thực thi khi Next.js đóng gói binary vào Vercel serverless function
  // (chỉ copy file, không giữ nguyên mode) — chủ động cấp lại quyền trước khi spawn, tránh ENOENT/EACCES.
  try {
    chmodSync(ffmpegPath, 0o755);
  } catch {}

  const workDir = await mkdtemp(path.join(tmpdir(), "story-video-"));
  const listPath = path.join(workDir, "list.txt");
  const outputPath = path.join(workDir, "output.mp4");
  const clipPaths: string[] = [];

  try {
    await Promise.all(
      scenes.map(async (scene, index) => {
        const res = await fetch(scene.video_url!);
        if (!res.ok) throw new Error(`Không tải được clip cảnh ${index + 1}`);
        const clipPath = path.join(workDir, `clip-${index}.mp4`);
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
        clipPaths[index] = clipPath;
      })
    );

    const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await writeFile(listPath, listContent);

    // Re-encode khi ghép (không dùng "-c copy") — mỗi cảnh là 1 lần gọi model ảnh + model video độc
    // lập, không đảm bảo cùng codec/tỉ lệ khung hình như dialogue-video (vốn dùng chung 1 ảnh nguồn).
    // Ép về cùng kích thước bằng scale+pad trước khi ghép để tránh lỗi/lệch khung giữa các đoạn.
    await execFileAsync(ffmpegPath, [
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-c:v", "libx264", "-c:a", "aac", "-y", outputPath,
    ]);

    const outputBuffer = await readFile(outputPath);
    const filePath = `${job.user_id}/story-${jobId}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(filePath, outputBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
    await supabase.from("story_video_jobs").update({ status: "done", output_url: publicUrlData.publicUrl }).eq("id", jobId);
    await recordGenerationHistory(job.user_id, job.mini_app_id, "video", publicUrlData.publicUrl);
  } catch (err) {
    // failJob() chỉ lưu lỗi vào DB (job.error_message), không throw/log — log riêng ra đây để lỗi ghép
    // video còn xuất hiện trong Vercel error tracking, tránh lặp lại việc dò lỗi mù như lần ffmpeg ENOENT.
    console.error(`[story-video-stitch] Job #${jobId} lỗi ghép video:`, err);
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const STALE_CHECK_MS = 30_000;

async function pollFalResult(model: string, requestId: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return null;
  const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!statusRes.ok) return null;
  const statusData = await statusRes.json();
  if (statusData.status !== "COMPLETED") return null;

  const resultRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!resultRes.ok) return null;
  const resultData = await resultRes.json();
  return { status: "OK", payload: resultData };
}

// Chủ động hỏi lại Fal.ai nếu job có vẻ "treo" quá lâu mà chưa nhận được webhook — gọi khi frontend
// poll trạng thái, cùng cơ chế resolveDialogueVideoJob() bên lib/dialogue-video.ts. Dùng đúng
// job.image_model/job.video_model đã snapshot lúc submit, KHÔNG tra lại catalog hiện tại (catalog có
// thể đã bị admin sửa/tắt entry đó sau khi job đã chạy). "images_ready" không cần poll — job đang
// dừng chờ khách bấm nút, không có Fal.ai job nào đang treo ở trạng thái đó.
export async function resolveStoryVideoJob(jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) return;
  const job = jobData as JobRow;

  if (!["generating_character", "generating_images", "generating_videos"].includes(job.status)) return;
  const ageMs = Date.now() - new Date(job.updated_at).getTime();
  if (ageMs < STALE_CHECK_MS) return;

  if (job.status === "generating_character") {
    if (job.character_fal_request_id) {
      const result = await pollFalResult(CHARACTER_SHEET_MODEL, job.character_fal_request_id);
      if (result) await applyCharacterStageResult(jobId, result);
    }
    return;
  }

  const scenes = await getScenes(jobId);

  if (job.status === "generating_images" && job.image_model) {
    for (const scene of scenes) {
      if (!scene.image_url && scene.image_fal_request_id) {
        const result = await pollFalResult(job.image_model, scene.image_fal_request_id);
        if (result) await applyImageStageResult(jobId, scene.id, result);
      }
    }
  } else if (job.status === "generating_videos" && job.video_model) {
    for (const scene of scenes) {
      if (!scene.video_url && scene.video_fal_request_id) {
        const result = await pollFalResult(job.video_model, scene.video_fal_request_id);
        if (result) await applyVideoStageResult(jobId, scene.id, result);
      }
    }
  }
}
