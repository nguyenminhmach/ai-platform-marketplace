// Logic xử lý kết quả job "Thay trang phục" — dùng chung cho webhook Fal.ai, fallback check khi
// frontend poll, và cron dọn dẹp hàng ngày. Mô hình giống hệt lib/video-jobs.ts, chỉ khác 1 job
// gồm NHIỀU item con (mỗi bộ trang phục = 1 lần gọi riêng) nên phải chờ đủ mọi item mới chốt trạng
// thái job cha, VÀ mỗi item có thể thuộc 1 trong 2 provider khác nhau (item.provider):
// - "fal": model chạy qua Fal.ai (generic/fashn), có webhook + fallback poll qua queue.fal.run.
// - "fashn_direct": FASHN Try-On Max chạy qua API riêng (api.fashn.ai), KHÔNG có webhook — chỉ dựa
//   vào poll từ frontend + cron sweep.
//
// Refund theo kiểu all-or-nothing (giữ nguyên quyết định thiết kế cũ): chỉ cần 1 item lỗi là hoàn
// lại TOÀN BỘ credit của cả lượt chạy — đơn giản hơn hoàn theo tỉ lệ, và giữ tính chất kết quả trả
// về là "đủ bộ N ảnh" chứ không phải kết quả nham nhở thiếu vài ảnh.

import { getSupabaseAdmin } from "@/lib/supabase";
import { refundCredit } from "@/lib/credit-system";
import { recordGenerationHistory } from "@/lib/ai-router";

const MINI_APP_ID = "thay-trang-phuc";
const STALE_CHECK_MS = 30_000; // item "processing" lâu hơn mốc này mới chủ động hỏi lại provider
const ABANDON_MS = 2 * 60 * 60 * 1000; // job cũ hơn 2 giờ vẫn chưa xong -> coi như bỏ, hoàn credit

// Model Fal.ai thật theo model_choice — cần đúng để fallback poll hỏi đúng endpoint (webhook thì
// Fal.ai tự biết, chỉ fallback poll mới cần map này).
const FAL_MODEL_ENDPOINTS: Record<string, string> = {
  generic: "fal-ai/gemini-3-pro-image-preview/edit",
  fashn: "fal-ai/fashn/tryon/v1.6",
};

type JobRow = {
  id: number;
  user_id: string;
  status: string;
  model_choice: string | null;
  total_credit: number;
  credit_tx_id: number | null;
  created_at: string;
};

type JobItemRow = {
  id: number;
  job_id: number;
  garment_image_url: string;
  fal_request_id: string | null;
  provider: string;
  status: string;
  output_url: string | null;
  updated_at: string;
};

/** Áp kết quả (thành công hoặc lỗi) vào 1 item — dùng chung cho webhook Fal.ai, fallback poll, và cron sweep (mọi provider). */
export async function applyFalResultToItem(item: JobItemRow, falPayload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseAdmin();

  const isError = falPayload.status === "ERROR" || !!falPayload.error;
  if (isError) {
    await supabase
      .from("outfit_swap_job_items")
      .update({ status: "failed", error_message: falPayload.error ? String(falPayload.error) : "Provider báo lỗi" })
      .eq("id", item.id);
    await finalizeJobIfDone(item.job_id);
    return;
  }

  const payloadInner = falPayload.payload as Record<string, unknown> | undefined;
  const images = (payloadInner?.images ?? falPayload.images) as { url?: string }[] | undefined;
  const outputUrl = images?.[0]?.url;

  if (!outputUrl) {
    await supabase
      .from("outfit_swap_job_items")
      .update({ status: "failed", error_message: "Không tìm thấy ảnh trong phản hồi" })
      .eq("id", item.id);
    await finalizeJobIfDone(item.job_id);
    return;
  }

  await supabase.from("outfit_swap_job_items").update({ status: "done", output_url: outputUrl }).eq("id", item.id);
  await finalizeJobIfDone(item.job_id);
}

/** Áp kết quả từ FASHN Try-On Max (api.fashn.ai riêng — payload dạng {status, output: [url], error} khác Fal.ai). */
async function applyFashnDirectResultToItem(
  item: JobItemRow,
  data: { status?: string; output?: string[]; error?: unknown }
): Promise<void> {
  const supabase = getSupabaseAdmin();

  if (data.status === "failed" || data.error) {
    await supabase
      .from("outfit_swap_job_items")
      .update({ status: "failed", error_message: data.error ? String(data.error) : "FASHN báo lỗi" })
      .eq("id", item.id);
    await finalizeJobIfDone(item.job_id);
    return;
  }

  const outputUrl = data.output?.[0];
  if (!outputUrl) {
    await supabase
      .from("outfit_swap_job_items")
      .update({ status: "failed", error_message: "Không tìm thấy ảnh trong phản hồi FASHN" })
      .eq("id", item.id);
    await finalizeJobIfDone(item.job_id);
    return;
  }

  await supabase.from("outfit_swap_job_items").update({ status: "done", output_url: outputUrl }).eq("id", item.id);
  await finalizeJobIfDone(item.job_id);
}

/** Kiểm tra job cha đã đủ mọi item chưa (done hoặc failed) — nếu đủ thì chốt trạng thái + hoàn credit nếu cần.
 *  Export để submitOutfitSwapJob() gọi ngay sau khi submit — bắt trường hợp MỌI item đều lỗi ngay
 *  lúc submit (không có item nào ở trạng thái "processing" để trigger qua webhook/poll về sau). */
export async function finalizeJobIfDone(jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: job } = await supabase.from("outfit_swap_jobs").select("*").eq("id", jobId).single();
  if (!job || job.status !== "processing") return; // đã chốt rồi (tránh chốt trùng khi 2 item về cùng lúc)

  const { data: items } = await supabase.from("outfit_swap_job_items").select("status").eq("job_id", jobId);
  if (!items || items.length === 0) return;

  const stillProcessing = items.some((i) => i.status === "processing");
  if (stillProcessing) return;

  const hasFailure = items.some((i) => i.status === "failed");

  if (hasFailure) {
    if (job.credit_tx_id) await refundCredit(job.credit_tx_id);
    await supabase
      .from("outfit_swap_jobs")
      .update({ status: "failed", error_message: "1 hoặc nhiều ảnh trang phục xử lý lỗi, credit đã được hoàn" })
      .eq("id", jobId);
    return;
  }

  await supabase.from("outfit_swap_jobs").update({ status: "done" }).eq("id", jobId);

  const { data: doneItems } = await supabase
    .from("outfit_swap_job_items")
    .select("output_url")
    .eq("job_id", jobId)
    .eq("status", "done");
  for (const doneItem of doneItems ?? []) {
    if (doneItem.output_url) await recordGenerationHistory(job.user_id, MINI_APP_ID, "image", doneItem.output_url);
  }
}

/** Chủ động hỏi lại Fal.ai xem item đã xong chưa — gọi khi item "processing" quá lâu mà chưa có webhook. */
async function resolveFalItem(item: JobItemRow, model: string): Promise<void> {
  if (item.status !== "processing" || !item.fal_request_id) return;

  const updatedAgeMs = Date.now() - new Date(item.updated_at).getTime();
  if (updatedAgeMs < STALE_CHECK_MS) return; // còn mới, chưa cần hỏi lại vội

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return;

  try {
    const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${item.fal_request_id}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusRes.ok) return;
    const statusData = await statusRes.json();

    if (statusData.status !== "COMPLETED") return; // vẫn đang chạy bên Fal.ai, sweep cron lo phần bị bỏ quên hẳn

    const resultRes = await fetch(`https://queue.fal.run/${model}/requests/${item.fal_request_id}`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!resultRes.ok) return;
    const resultData = await resultRes.json();

    await applyFalResultToItem(item, { status: "OK", payload: resultData });
  } catch {
    // bỏ qua lỗi mạng tạm thời, lần poll tiếp theo của frontend sẽ thử lại
  }
}

/** Chủ động hỏi lại FASHN Try-On Max (api.fashn.ai) — provider này KHÔNG có webhook, luôn phải dựa vào poll. */
async function resolveFashnDirectItem(item: JobItemRow): Promise<void> {
  if (item.status !== "processing" || !item.fal_request_id) return;

  const updatedAgeMs = Date.now() - new Date(item.updated_at).getTime();
  if (updatedAgeMs < STALE_CHECK_MS) return;

  const apiKey = process.env.FASHN_API_KEY;
  if (!apiKey) return;

  try {
    const statusRes = await fetch(`https://api.fashn.ai/v1/status/${item.fal_request_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusRes.ok) return;
    const data = await statusRes.json();

    if (data.status !== "completed" && data.status !== "failed") return; // vẫn đang xử lý bên FASHN

    await applyFashnDirectResultToItem(item, data);
  } catch {
    // bỏ qua lỗi mạng tạm thời, lần poll tiếp theo của frontend sẽ thử lại
  }
}

/** Frontend gọi khi poll — trả trạng thái job + kết quả đã có, đồng thời chủ động hỏi lại provider cho item còn treo. */
export async function resolveOutfitSwapJob(
  jobId: number
): Promise<{ status: string; outputs: string[]; totalItems: number; doneCount: number; errorMessage: string | null }> {
  const supabase = getSupabaseAdmin();

  const { data: job } = await supabase.from("outfit_swap_jobs").select("*").eq("id", jobId).single();
  if (!job) return { status: "not_found", outputs: [], totalItems: 0, doneCount: 0, errorMessage: null };

  if (job.status === "processing") {
    const { data: items } = await supabase.from("outfit_swap_job_items").select("*").eq("job_id", jobId);
    const falModel = FAL_MODEL_ENDPOINTS[(job as JobRow).model_choice ?? "fashn"] ?? FAL_MODEL_ENDPOINTS.fashn;
    await Promise.all(
      (items ?? [])
        .filter((i) => i.status === "processing")
        .map((i) => (i.provider === "fashn_direct" ? resolveFashnDirectItem(i) : resolveFalItem(i, falModel)))
    );
  }

  const { data: freshJob } = await supabase.from("outfit_swap_jobs").select("*").eq("id", jobId).single();
  const { data: freshItems } = await supabase
    .from("outfit_swap_job_items")
    .select("status, output_url")
    .eq("job_id", jobId)
    .order("id", { ascending: true });

  const outputs = (freshItems ?? []).filter((i) => i.status === "done" && i.output_url).map((i) => i.output_url as string);
  const doneCount = (freshItems ?? []).filter((i) => i.status !== "processing").length;

  return {
    status: freshJob?.status ?? job.status,
    outputs,
    totalItems: freshItems?.length ?? 0,
    doneCount,
    errorMessage: freshJob?.error_message ?? null,
  };
}

/** Dọn các job bị bỏ quên hẳn — chạy từ cron hàng ngày (Vercel Hobby chỉ cho tối đa 1 lần/ngày). */
export async function sweepAbandonedOutfitSwapJobs(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - ABANDON_MS).toISOString();

  const { data: staleJobs } = await supabase
    .from("outfit_swap_jobs")
    .select("id")
    .eq("status", "processing")
    .lt("created_at", cutoff);

  if (!staleJobs || staleJobs.length === 0) return 0;

  for (const row of staleJobs) {
    // Quá 2 giờ vẫn "processing" -> coi mọi item còn treo là hỏng, hoàn credit (dùng chung cho mọi provider)
    const { data: items } = await supabase.from("outfit_swap_job_items").select("*").eq("job_id", row.id);
    for (const item of items ?? []) {
      if (item.status === "processing") {
        await applyFalResultToItem(item, { status: "ERROR", error: "Quá thời gian chờ xử lý" });
      }
    }
  }
  return staleJobs.length;
}
