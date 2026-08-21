// Pipeline "Video từ ý tưởng truyện" — 1-3 ảnh nhân vật + 1 ý tưởng truyện, AI chia 2-8 phân cảnh
// rồi với mỗi cảnh: (1) model ảnh (khách chọn từ catalog nhiều nhà cung cấp) tạo ảnh giữ đúng nhân
// vật -> (2) model video (khách chọn từ catalog) động hoá ảnh đó -> (3) ffmpeg ghép N clip lại theo
// đúng thứ tự thành 1 video hoàn chỉnh. Mỗi cảnh là 1 hàng trong story_video_scenes, xử lý song song,
// chờ đủ cả N hàng mới sang bước kế tiếp — cùng khuôn với lib/dialogue-video.ts.
//
// Chia 2 nấc theo đúng cách Genful làm: mặc định submitStoryVideoJob() chỉ chạy tới hết bước ảnh rồi
// DỪNG ở status "images_ready" (chỉ trừ credit phần ảnh) — khách xem ảnh từng cảnh trước, ưng mới gọi
// continueStoryVideoToVideoStage() (trừ thêm credit phần video) để chạy tiếp video + ghép. Nếu khách
// chọn "tự động tạo video luôn" (autoVideo=true) thì submit trừ đủ cả 2 phần và tự chạy hết 1 lượt,
// không dừng ở images_ready.

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { callOpenRouter, recordGenerationHistory } from "@/lib/ai-router";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

const execFileAsync = promisify(execFile);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export const MIN_SCENES = 2;
export const MAX_SCENES = 8;
export const MIN_CHARACTER_IMAGES = 1;
// Không giới hạn số ảnh nhân vật theo yêu cầu — chỉ giữ 1 trần an toàn kỹ thuật (tránh payload quá
// lớn/timeout, và một số model multi-image như Nano Banana Pro tự giới hạn tối đa 14 ảnh ở phía Fal.ai).
export const MAX_CHARACTER_IMAGES = 20;

const SCENE_SPLIT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (nhân vật đang làm gì, ở đâu, bối cảnh gì), giữ nguyên nhân vật chính xuyên suốt các cảnh.
Chỉ trả về DUY NHẤT 1 mảng JSON gồm đúng N chuỗi tiếng Anh, mỗi chuỗi mô tả 1 cảnh (dùng để tạo ảnh AI), không kèm markdown fence, không giải thích, không đánh số.
Ví dụ format: ["a young woman walking into a coffee shop, morning light", "she sits by the window, smiling while looking outside"]`;

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
  image_provider_cost_vnd_per_scene: number | null;
  video_provider_cost_vnd_per_scene: number | null;
  num_scenes: number;
  image_model: string | null;
  video_model: string | null;
  aspect_ratio: string | null;
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
    };
  };
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

export async function splitStoryIntoScenes(
  storyDescription: string,
  numScenes: number,
  customInstructions?: string,
  modelChatKey?: string
): Promise<string[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  // "Agent xử lý" — admin thêm hướng dẫn phong cách/chủ đề qua model_config.prompt_helper_instructions
  // (đúng field/UI đã dùng cho nút "AI viết giúp mô tả" ở app video-gen). Nối THÊM vào cuối, không
  // thay hẳn — bắt buộc giữ nguyên yêu cầu "chỉ trả JSON đúng N phần tử" để pipeline không gãy.
  const basePrompt = SCENE_SPLIT_SYSTEM_PROMPT.replace("N phân cảnh", `${numScenes} phân cảnh`);
  const systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  async function attempt(reminder?: string): Promise<string[]> {
    const userInput = reminder
      ? `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng. Chỉ trả về mảng JSON gồm đúng ${numScenes} chuỗi, không thêm gì khác.)`
      : storyDescription;
    const { output } = await callOpenRouter(chatModel, 800, systemPrompt, userInput);
    const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("not-json");
    }
    if (!Array.isArray(parsed) || parsed.length !== numScenes || !parsed.every((s) => typeof s === "string" && s.trim())) {
      throw new Error("wrong-shape");
    }
    return parsed as string[];
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
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  if (numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
  }
  if (characterImageUrls.length < MIN_CHARACTER_IMAGES || characterImageUrls.length > MAX_CHARACTER_IMAGES) {
    throw new Error(`Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật`);
  }

  const {
    imageEntry,
    videoEntry,
    imageCost,
    videoCost,
    totalCost,
    imageProviderCostVnd,
    videoProviderCostVnd,
    resolvedResolutionKey,
    resolvedDurationKey,
    promptHelperInstructions,
  } = await resolveCosts(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);

  // Mặc định chỉ trừ phần ảnh (bước 1) — phần video trừ riêng khi khách bấm "Tạo video" ở
  // continueStoryVideoToVideoStage(). Nếu chọn "tự động tạo video luôn" thì trừ gộp cả 2 phần ngay.
  const deduction = await deductCredit(userId, autoVideo ? totalCost : imageCost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const supabase = getSupabaseAdmin();

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
      image_credit_tx_id: deduction.txId,
      image_provider_cost_vnd_per_scene: imageProviderCostVnd,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được job");
  }

  try {
    await supabase.from("story_video_jobs").update({ status: "splitting_story" }).eq("id", job.id);
    const scenes = await splitStoryIntoScenes(storyDescription, numScenes, promptHelperInstructions, modelChatKey);

    const { data: sceneRows, error: sceneError } = await supabase
      .from("story_video_scenes")
      .insert(scenes.map((description, index) => ({ job_id: job.id, position: index, scene_description: description })))
      .select("id, position, scene_description");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    await Promise.all(
      sceneRows.map(async (row) => {
        const body = buildImageRequestBody(imageEntry.model, row.scene_description, characterImageUrls, imageEntry.multi_image, aspectRatio, resolvedResolutionKey);

        const requestId = await submitFalJob(
          imageEntry.model,
          body,
          `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&sceneId=${row.id}&stage=image`
        );
        await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", row.id);
      })
    );

    await supabase.from("story_video_jobs").update({ status: "generating_images" }).eq("id", job.id);
  } catch (err) {
    await supabase
      .from("story_video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { jobId: job.id, newBalance: deduction.newBalance };
}

async function failJob(jobId: number, message: string) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("story_video_jobs").select("image_credit_tx_id, video_credit_tx_id").eq("id", jobId).single();
  await supabase.from("story_video_jobs").update({ status: "failed", error_message: message }).eq("id", jobId);
  if (job?.image_credit_tx_id) await refundCredit(job.image_credit_tx_id);
  if (job?.video_credit_tx_id) await refundCredit(job.video_credit_tx_id);
}

async function getScenes(jobId: number): Promise<SceneRow[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("story_video_scenes").select("*").eq("job_id", jobId).order("position", { ascending: true });
  return (data as SceneRow[]) ?? [];
}

export { getScenes as getStoryVideoScenes };

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
  if (job.status !== "images_ready") throw new Error("Job không ở trạng thái sẵn sàng tạo video");
  if (!job.video_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá video của job");

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, videoCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  await supabase.from("story_video_jobs").update({ video_credit_tx_id: deduction.txId }).eq("id", jobId);

  const scenes = await getScenes(jobId);
  await proceedToVideoStage(jobId, scenes);

  return { newBalance: deduction.newBalance };
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

  if (!["generating_images", "generating_videos"].includes(job.status)) return;
  const ageMs = Date.now() - new Date(job.updated_at).getTime();
  if (ageMs < STALE_CHECK_MS) return;

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
