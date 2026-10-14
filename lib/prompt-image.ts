// Sinh ẢNH TRỰC TIẾP từ ô prompt ở tab "hình ảnh" (app/video-tu-y-tuong/page.tsx) — KHÁC hẳn luồng
// "Character sheet -> ảnh phân cảnh -> video" cũ (lib/story-video.ts): đây chỉ 1 lần gọi, ra ĐÚNG 1
// ảnh, không qua kịch bản/phân cảnh gì cả. Mô hình 1-bảng-1-job đơn giản hơn outfit-swap (không cần
// bảng "items" con vì luôn đúng 1 ảnh/lần, không phải N bộ trang phục/lần) nhưng CÙNG kiểu vòng đời
// với outfit_swap_jobs: submit (trừ credit trước) -> Fal.ai queue + webhook -> poll dự phòng khi
// webhook trễ -> cron sweep job bị bỏ quên.
//
// Tái dùng tối đa từ lib/story-video.ts (đã export thêm các hàm dưới cho mục đích này):
// - getMiniAppModelConfig/resolveModelEntry/resolvePricedKey: tra đúng model ảnh + giá theo
//   resolution_price_vnd, cùng catalog model_config.image_models đã dùng cho luồng Character cũ
//   (mini_app "video-tu-y-tuong"), không cần bảng catalog riêng.
// - buildImageRequestBody: tạo đúng body request theo từng model Fal.ai (đã xử lý sẵn khác biệt
//   schema gpt-image-2/edit vs model khác).
// - submitFalJob/extractImageUrl: gọi queue.fal.run + đọc URL ảnh ra từ payload webhook.

import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";
import { recordGenerationHistory } from "@/lib/ai-router";
import {
  getMiniAppModelConfig,
  resolveModelEntry,
  resolvePricedKey,
  buildImageRequestBody,
  submitFalJob,
  extractImageUrl,
} from "@/lib/story-video";

const MINI_APP_ID = "video-tu-y-tuong";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";
const STALE_CHECK_MS = 30_000; // job "processing" lâu hơn mốc này mới chủ động hỏi lại Fal.ai
const ABANDON_MS = 2 * 60 * 60 * 1000; // job cũ hơn 2 giờ vẫn chưa xong -> coi như bỏ, hoàn credit

export type PromptImageJobRow = {
  id: number;
  user_id: string;
  prompt: string;
  model: string;
  image_urls: string[];
  aspect_ratio: string;
  resolution_key: string | null;
  fal_request_id: string | null;
  status: string;
  output_url: string | null;
  error_message: string | null;
  credit_cost: number;
  credit_tx_id: number | null;
  created_at: string;
  updated_at: string;
};

/** Submit 1 lần tạo ảnh từ prompt bar — trừ credit NGAY (an toàn hơn trừ sau), tạo job "processing",
 *  gọi Fal.ai kèm webhook, trả về jobId để frontend tự poll trạng thái. */
export async function submitPromptImageJob(
  userId: string,
  prompt: string,
  imageUrls: string[],
  modelKey: string | undefined,
  aspectRatio: string,
  resolutionKey: string | undefined,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  if (!prompt.trim()) throw new Error("Thiếu câu lệnh mô tả");

  const miniApp = await getMiniAppModelConfig(MINI_APP_ID);
  const imageEntry = resolveModelEntry(miniApp.model_config.image_models, modelKey);

  let providerCostVnd = imageEntry.provider_cost_vnd;
  let resolvedResolutionKey: string | undefined;
  if (imageEntry.resolution_price_vnd) {
    const resolved = resolvePricedKey(imageEntry.resolution_price_vnd, resolutionKey);
    resolvedResolutionKey = resolved.key;
    providerCostVnd = resolved.costVnd;
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const creditCost = computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, creditCost, MINI_APP_ID, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const supabase = getSupabaseAdmin();
  const { data: job, error: jobError } = await supabase
    .from("prompt_image_jobs")
    .insert({
      user_id: userId,
      prompt,
      model: imageEntry.model,
      image_urls: imageUrls,
      aspect_ratio: aspectRatio,
      resolution_key: resolvedResolutionKey ?? null,
      status: "processing",
      credit_cost: creditCost,
      credit_tx_id: deduction.txId,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(jobError?.message ?? "Không tạo được job sinh ảnh");
  }

  try {
    const falApiKey = process.env.FAL_KEY;
    if (!falApiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

    const body = buildImageRequestBody(imageEntry.model, prompt, imageUrls, imageEntry.multi_image, aspectRatio, resolvedResolutionKey);
    const webhookUrl = `${SITE_URL}/api/prompt-image/webhook?jobId=${job.id}`;
    const requestId = await submitFalJob(imageEntry.model, body, webhookUrl);
    await supabase.from("prompt_image_jobs").update({ fal_request_id: requestId }).eq("id", job.id);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    await supabase
      .from("prompt_image_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
  }

  return { jobId: job.id, newBalance: deduction.newBalance };
}

/** Áp kết quả Fal.ai (thành công hoặc lỗi) vào job — dùng chung cho webhook + fallback poll + cron sweep. */
export async function applyPromptImageResult(job: PromptImageJobRow, falPayload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin();

  const isError = falPayload.status === "ERROR" || !!falPayload.error;
  const outputUrl = isError ? undefined : extractImageUrl(falPayload);

  if (isError || !outputUrl) {
    if (job.credit_tx_id) await refundCredit(job.credit_tx_id);
    await supabase
      .from("prompt_image_jobs")
      .update({
        status: "failed",
        error_message: isError ? (falPayload.error ? String(falPayload.error) : "Provider báo lỗi") : "Không tìm thấy ảnh trong phản hồi",
      })
      .eq("id", job.id);
    return;
  }

  await supabase.from("prompt_image_jobs").update({ status: "done", output_url: outputUrl }).eq("id", job.id);
  await recordGenerationHistory(job.user_id, MINI_APP_ID, "image", outputUrl);
}

/** Chủ động hỏi lại Fal.ai khi job "processing" quá lâu mà chưa có webhook — gọi từ resolvePromptImageJob. */
async function resolveFalJobStatus(job: PromptImageJobRow): Promise<void> {
  if (job.status !== "processing" || !job.fal_request_id) return;

  const updatedAgeMs = Date.now() - new Date(job.updated_at).getTime();
  if (updatedAgeMs < STALE_CHECK_MS) return;

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return;

  try {
    const statusRes = await fetch(`https://queue.fal.run/${job.model}/requests/${job.fal_request_id}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusRes.ok) return;
    const statusData = await statusRes.json();
    if (statusData.status !== "COMPLETED") return;

    const resultRes = await fetch(`https://queue.fal.run/${job.model}/requests/${job.fal_request_id}`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!resultRes.ok) return;
    const resultData = await resultRes.json();

    await applyPromptImageResult(job, { status: "OK", payload: resultData });
  } catch {
    // bỏ qua lỗi mạng tạm thời, lần poll tiếp theo của frontend sẽ thử lại
  }
}

/** Frontend gọi khi poll trạng thái — trả kết quả hiện có, đồng thời chủ động hỏi lại Fal.ai nếu job
 *  đang treo lâu chưa có webhook. */
export async function resolvePromptImageJob(
  jobId: number
): Promise<{ status: string; outputUrl: string | null; errorMessage: string | null }> {
  const supabase = getSupabaseAdmin();

  const { data: job } = await supabase.from("prompt_image_jobs").select("*").eq("id", jobId).single();
  if (!job) return { status: "not_found", outputUrl: null, errorMessage: null };

  if (job.status === "processing") {
    await resolveFalJobStatus(job as PromptImageJobRow);
  }

  const { data: freshJob } = await supabase.from("prompt_image_jobs").select("*").eq("id", jobId).single();
  return {
    status: freshJob?.status ?? job.status,
    outputUrl: freshJob?.output_url ?? null,
    errorMessage: freshJob?.error_message ?? null,
  };
}

/** Dọn job bị bỏ quên hẳn — chạy từ cron hàng ngày, cùng mốc 2 giờ như outfit-swap. */
export async function sweepAbandonedPromptImageJobs(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - ABANDON_MS).toISOString();

  const { data: staleJobs } = await supabase
    .from("prompt_image_jobs")
    .select("*")
    .eq("status", "processing")
    .lt("created_at", cutoff);

  if (!staleJobs || staleJobs.length === 0) return 0;

  for (const job of staleJobs) {
    await applyPromptImageResult(job as PromptImageJobRow, { status: "ERROR", error: "Quá thời gian chờ xử lý" });
  }
  return staleJobs.length;
}
