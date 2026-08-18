// Logic xử lý kết quả video job dùng chung cho: webhook Fal.ai, fallback check khi frontend poll,
// và cron dọn dẹp hàng ngày. Gói chung 1 chỗ để không lặp lại 3 nơi.
//
// Lưu ý: gói Vercel Hobby chỉ cho phép cron chạy tối đa 1 lần/ngày — không đủ nhanh để làm
// "polling dự phòng" sát sao. Nên fallback thật sự nằm ở resolveFalJob(), được gọi ngay trong
// route /api/video/status mỗi khi frontend hỏi — tự chủ động hỏi lại Fal.ai nếu job có vẻ bị "treo"
// quá lâu, không cần đợi cron. Cron hàng ngày chỉ dọn các job bị bỏ quên hẳn (user tắt tab, không quay lại).

import { getSupabaseAdmin } from "@/lib/supabase";
import { refundCredit } from "@/lib/credit-system";
import { recordGenerationHistory } from "@/lib/ai-router";

const STALE_CHECK_MS = 30_000; // job "processing" lâu hơn mốc này mới chủ động hỏi lại Fal.ai
const ABANDON_MS = 2 * 60 * 60 * 1000; // job cũ hơn 2 giờ vẫn chưa xong -> coi như bỏ, hoàn credit

type VideoJobRow = {
  id: number;
  user_id: string;
  status: string;
  fal_request_id: string | null;
  mini_app_id: string;
  credit_tx_id: number | null;
  created_at: string;
  updated_at: string;
};

async function getModelForMiniApp(miniAppId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("model_config").eq("id", miniAppId).single();
  return (data?.model_config as { model?: string } | null)?.model ?? null;
}

/** Áp kết quả Fal.ai (thành công hoặc lỗi) vào 1 video_jobs — dùng chung cho webhook lẫn fallback poll. */
export async function applyFalResult(job: VideoJobRow, falPayload: Record<string, unknown>): Promise<string> {
  const supabase = getSupabaseAdmin();

  const isError = falPayload.status === "ERROR" || !!falPayload.error;
  if (isError) {
    const rawError = falPayload.error ? String(falPayload.error) : "Fal.ai báo lỗi";
    // Log nguyên văn lỗi Fal.ai trước khi dịch sang thông báo chung cho khách — trước đây bị bỏ mất
    // hoàn toàn (không lưu, không log), không cách nào tra được nguyên nhân thật (nội dung ảnh bị
    // chặn kiểm duyệt, sai tỉ lệ ảnh, hay lỗi khác) khi khách báo gặp lỗi 422.
    console.error(`[video_jobs] Fal.ai lỗi cho job #${job.id} (mini_app ${job.mini_app_id}):`, rawError);
    const errorMessage = rawError.includes("422")
      ? "AI từ chối xử lý yêu cầu này (lỗi 422) — thường do mô tả quá dài hoặc ảnh tham chiếu không hợp lệ. Vui lòng rút ngắn mô tả và thử lại."
      : rawError;
    await supabase.from("video_jobs").update({ status: "failed", error_message: errorMessage }).eq("id", job.id);
    if (job.credit_tx_id) await refundCredit(job.credit_tx_id);
    return "failed";
  }

  const payloadInner = falPayload.payload as Record<string, unknown> | undefined;
  const videoUrl: string | undefined =
    (payloadInner?.video as { url?: string } | undefined)?.url ??
    (falPayload.video as { url?: string } | undefined)?.url ??
    (payloadInner?.video_url as string | undefined) ??
    (falPayload.video_url as string | undefined);

  if (!videoUrl) {
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error_message: "Không tìm thấy URL video trong phản hồi Fal.ai" })
      .eq("id", job.id);
    if (job.credit_tx_id) await refundCredit(job.credit_tx_id);
    return "failed";
  }

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Không tải được video từ Fal.ai: ${videoRes.status}`);
  const videoBlob = await videoRes.arrayBuffer();

  const filePath = `${job.user_id}/${job.id}.mp4`;
  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(filePath, videoBlob, { contentType: "video/mp4", upsert: true });
  if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);

  await supabase.from("video_jobs").update({ status: "done", output_url: publicUrlData.publicUrl }).eq("id", job.id);
  await recordGenerationHistory(job.user_id, job.mini_app_id, "video", publicUrlData.publicUrl);
  return "done";
}

/** Chủ động hỏi lại Fal.ai xem job đã xong chưa — gọi khi job "processing" quá lâu mà chưa có webhook. */
export async function resolveFalJob(jobId: number): Promise<{ status: string; outputUrl: string | null }> {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("video_jobs").select("*").eq("id", jobId).single();
  if (!job) return { status: "not_found", outputUrl: null };

  if (job.status !== "processing" || !job.fal_request_id) {
    return { status: job.status, outputUrl: job.output_url ?? null };
  }

  const updatedAgeMs = Date.now() - new Date(job.updated_at).getTime();
  if (updatedAgeMs < STALE_CHECK_MS) {
    return { status: job.status, outputUrl: null }; // còn mới, chưa cần hỏi lại vội
  }

  const model = await getModelForMiniApp(job.mini_app_id);
  if (!model) return { status: job.status, outputUrl: null };

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return { status: job.status, outputUrl: null };

  try {
    const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${job.fal_request_id}/status`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusRes.ok) return { status: job.status, outputUrl: null };
    const statusData = await statusRes.json();

    if (statusData.status !== "COMPLETED") {
      // vẫn đang chạy bên Fal.ai — nếu quá lâu (bỏ quên), coi như hỏng và hoàn credit
      const createdAgeMs = Date.now() - new Date(job.created_at).getTime();
      if (createdAgeMs > ABANDON_MS) {
        await applyFalResult(job, { status: "ERROR", error: "Quá thời gian chờ xử lý" });
        return { status: "failed", outputUrl: null };
      }
      return { status: job.status, outputUrl: null };
    }

    const resultRes = await fetch(`https://queue.fal.run/${model}/requests/${job.fal_request_id}`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!resultRes.ok) return { status: job.status, outputUrl: null };
    const resultData = await resultRes.json();

    const finalStatus = await applyFalResult(job, { status: "OK", payload: resultData });
    const { data: refreshed } = await supabase.from("video_jobs").select("output_url").eq("id", jobId).single();
    return { status: finalStatus, outputUrl: refreshed?.output_url ?? null };
  } catch {
    return { status: job.status, outputUrl: null };
  }
}

/** Dọn các job bị bỏ quên hẳn — chạy từ cron hàng ngày (Vercel Hobby chỉ cho tối đa 1 lần/ngày). */
export async function sweepAbandonedJobs(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - ABANDON_MS).toISOString();

  const { data: staleJobs } = await supabase
    .from("video_jobs")
    .select("id")
    .in("status", ["pending", "processing"])
    .lt("created_at", cutoff);

  if (!staleJobs || staleJobs.length === 0) return 0;

  for (const row of staleJobs) {
    await resolveFalJob(row.id);
  }
  return staleJobs.length;
}
