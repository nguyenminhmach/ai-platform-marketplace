// Pipeline "Video đồng nhất nhân vật" — 2 nhân vật đối thoại tiếng Việt.
// (1) Kling image-to-video cho từng nhân vật (video câm) -> (2) ElevenLabs đọc lời thoại tiếng Việt
// -> (3) Kling LipSync khớp môi cho từng nhân vật -> (4) ffmpeg ghép 2 clip đã lipsync lại làm 1.
// Mỗi bước ngoài (Kling) đều bất đồng bộ qua Fal queue + webhook, giống hệt cơ chế video_jobs sẵn có.

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { generateVietnameseSpeech } from "@/lib/elevenlabs";
import { recordGenerationHistory } from "@/lib/ai-router";

const execFileAsync = promisify(execFile);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

// Prompt chuyển động cố định cho bước tạo video câm — giữ khung hình ổn định, mặt rõ ràng để
// bước lipsync sau đó khớp môi chính xác. Không cho khách chỉnh ở bản đầu tiên (giữ đơn giản).
const NEUTRAL_TALKING_PROMPT =
  "Người trong ảnh đứng yên tại chỗ, nhìn thẳng về phía camera, đầu và vai có cử động nhẹ tự nhiên như đang trò chuyện, không rời khỏi khung hình, không đổi góc máy, ánh sáng giữ nguyên.";

type DialogueVideoJobRow = {
  id: number;
  user_id: string;
  mini_app_id: string;
  status: string;
  a_image_url: string;
  a_line: string;
  a_video_url: string | null;
  a_audio_url: string | null;
  a_lipsync_url: string | null;
  b_image_url: string;
  b_line: string;
  b_video_url: string | null;
  b_audio_url: string | null;
  b_lipsync_url: string | null;
  credit_tx_id: number | null;
};

async function getMiniAppModelConfig(miniAppId: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("credit_cost, model_config").eq("id", miniAppId).single();
  if (!data) throw new Error("Không tìm thấy Mini App");
  return data as { credit_cost: number; model_config: { video_model: string; lipsync_model: string } };
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

export async function submitDialogueVideoJob(
  userId: string,
  miniAppId: string,
  aImageUrl: string,
  aLine: string,
  bImageUrl: string,
  bLine: string,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const supabase = getSupabaseAdmin();

  const deduction = await deductCredit(userId, miniApp.credit_cost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const { data: job, error: insertError } = await supabase
    .from("dialogue_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "pending",
      a_image_url: aImageUrl,
      a_line: aLine,
      b_image_url: bImageUrl,
      b_line: bLine,
      credit_tx_id: deduction.txId,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được job");
  }

  try {
    const videoModel = miniApp.model_config.video_model;
    const aRequestId = await submitFalJob(
      videoModel,
      { prompt: NEUTRAL_TALKING_PROMPT, image_url: aImageUrl },
      `${SITE_URL}/api/dialogue-video/webhook?jobId=${job.id}&speaker=a&stage=video`
    );
    const bRequestId = await submitFalJob(
      videoModel,
      { prompt: NEUTRAL_TALKING_PROMPT, image_url: bImageUrl },
      `${SITE_URL}/api/dialogue-video/webhook?jobId=${job.id}&speaker=b&stage=video`
    );

    await supabase
      .from("dialogue_video_jobs")
      .update({ status: "generating_video", a_fal_request_id: aRequestId, b_fal_request_id: bRequestId })
      .eq("id", job.id);
  } catch (err) {
    await supabase
      .from("dialogue_video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { jobId: job.id, newBalance: deduction.newBalance };
}

async function failJob(jobId: number, message: string) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("dialogue_video_jobs").select("credit_tx_id").eq("id", jobId).single();
  await supabase.from("dialogue_video_jobs").update({ status: "failed", error_message: message }).eq("id", jobId);
  if (job?.credit_tx_id) await refundCredit(job.credit_tx_id);
}

// Gọi khi 1 trong 2 clip video câm (bước 1) tạo xong — khi CẢ 2 xong mới chuyển sang bước TTS+lipsync.
export async function applyVideoStageResult(jobId: number, speaker: "a" | "b", falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi tạo video ${speaker === "a" ? "nhân vật A" : "nhân vật B"}: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    await failJob(jobId, "Không tìm thấy URL video trong phản hồi Fal.ai");
    return;
  }

  const column = speaker === "a" ? "a_video_url" : "b_video_url";
  await supabase.from("dialogue_video_jobs").update({ [column]: videoUrl }).eq("id", jobId);

  const { data: job } = await supabase.from("dialogue_video_jobs").select("*").eq("id", jobId).single();
  if (!job || !job.a_video_url || !job.b_video_url) return; // chờ nhân vật còn lại

  await proceedToLipsync(job as DialogueVideoJobRow);
}

async function proceedToLipsync(job: DialogueVideoJobRow) {
  const supabase = getSupabaseAdmin();
  try {
    const [aAudioUrl, bAudioUrl] = await Promise.all([
      generateVietnameseSpeech(job.a_line, "a", job.id),
      generateVietnameseSpeech(job.b_line, "b", job.id),
    ]);

    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const lipsyncModel = miniApp.model_config.lipsync_model;

    const [aRequestId, bRequestId] = await Promise.all([
      submitFalJob(
        lipsyncModel,
        { video_url: job.a_video_url, audio_url: aAudioUrl },
        `${SITE_URL}/api/dialogue-video/webhook?jobId=${job.id}&speaker=a&stage=lipsync`
      ),
      submitFalJob(
        lipsyncModel,
        { video_url: job.b_video_url, audio_url: bAudioUrl },
        `${SITE_URL}/api/dialogue-video/webhook?jobId=${job.id}&speaker=b&stage=lipsync`
      ),
    ]);

    await supabase
      .from("dialogue_video_jobs")
      .update({
        status: "lipsyncing",
        a_audio_url: aAudioUrl,
        b_audio_url: bAudioUrl,
        a_lipsync_fal_request_id: aRequestId,
        b_lipsync_fal_request_id: bRequestId,
      })
      .eq("id", job.id);
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
  }
}

// Gọi khi 1 trong 2 clip đã lipsync (bước 3) xong — khi CẢ 2 xong mới ghép lại thành video cuối.
export async function applyLipsyncStageResult(jobId: number, speaker: "a" | "b", falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi khớp môi ${speaker === "a" ? "nhân vật A" : "nhân vật B"}: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    await failJob(jobId, "Không tìm thấy URL video lipsync trong phản hồi Fal.ai");
    return;
  }

  const column = speaker === "a" ? "a_lipsync_url" : "b_lipsync_url";
  await supabase.from("dialogue_video_jobs").update({ [column]: videoUrl }).eq("id", jobId);

  const { data: job } = await supabase.from("dialogue_video_jobs").select("*").eq("id", jobId).single();
  if (!job || !job.a_lipsync_url || !job.b_lipsync_url) return; // chờ nhân vật còn lại

  await stitchAndFinish(job as DialogueVideoJobRow);
}

// Ghép 2 clip đã lipsync (A nói trước, B nói sau) thành 1 video liền mạch — dùng lại ffmpeg-static
// đã tích hợp sẵn cho tính năng ghép nhạc nền.
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
// poll trạng thái, tương tự resolveFalJob() bên video-jobs.ts nhưng có nhiều bước hơn nên viết riêng.
export async function resolveDialogueVideoJob(jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("dialogue_video_jobs").select("*").eq("id", jobId).single();
  if (!job) return;
  const row = job as DialogueVideoJobRow & {
    status: string;
    updated_at: string;
    a_fal_request_id: string | null;
    b_fal_request_id: string | null;
    a_lipsync_fal_request_id: string | null;
    b_lipsync_fal_request_id: string | null;
  };

  if (!["generating_video", "lipsyncing"].includes(row.status)) return;
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  if (ageMs < STALE_CHECK_MS) return;

  const miniApp = await getMiniAppModelConfig(row.mini_app_id);

  if (row.status === "generating_video") {
    if (!row.a_video_url && row.a_fal_request_id) {
      const result = await pollFalResult(miniApp.model_config.video_model, row.a_fal_request_id);
      if (result) await applyVideoStageResult(jobId, "a", result);
    }
    if (!row.b_video_url && row.b_fal_request_id) {
      const result = await pollFalResult(miniApp.model_config.video_model, row.b_fal_request_id);
      if (result) await applyVideoStageResult(jobId, "b", result);
    }
  } else if (row.status === "lipsyncing") {
    if (!row.a_lipsync_url && row.a_lipsync_fal_request_id) {
      const result = await pollFalResult(miniApp.model_config.lipsync_model, row.a_lipsync_fal_request_id);
      if (result) await applyLipsyncStageResult(jobId, "a", result);
    }
    if (!row.b_lipsync_url && row.b_lipsync_fal_request_id) {
      const result = await pollFalResult(miniApp.model_config.lipsync_model, row.b_lipsync_fal_request_id);
      if (result) await applyLipsyncStageResult(jobId, "b", result);
    }
  }
}

async function stitchAndFinish(job: DialogueVideoJobRow) {
  const supabase = getSupabaseAdmin();
  await supabase.from("dialogue_video_jobs").update({ status: "stitching" }).eq("id", job.id);

  if (!ffmpegPath) {
    await failJob(job.id, "Máy chủ chưa hỗ trợ ghép video (thiếu ffmpeg)");
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "dialogue-video-"));
  const aPath = path.join(workDir, "a.mp4");
  const bPath = path.join(workDir, "b.mp4");
  const listPath = path.join(workDir, "list.txt");
  const outputPath = path.join(workDir, "output.mp4");

  try {
    const [aRes, bRes] = await Promise.all([fetch(job.a_lipsync_url!), fetch(job.b_lipsync_url!)]);
    if (!aRes.ok || !bRes.ok) throw new Error("Không tải được clip đã lipsync");

    await writeFile(aPath, Buffer.from(await aRes.arrayBuffer()));
    await writeFile(bPath, Buffer.from(await bRes.arrayBuffer()));
    await writeFile(listPath, `file '${aPath.replace(/'/g, "'\\''")}'\nfile '${bPath.replace(/'/g, "'\\''")}'\n`);

    // Re-encode khi ghép (không dùng "-c copy") vì 2 clip có thể khác codec/timebase nhẹ do đi qua
    // 2 lượt xử lý AI riêng (video-gen rồi lipsync) — ghép trực tiếp dễ lỗi khung hình giữa 2 đoạn.
    await execFileAsync(ffmpegPath, ["-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-c:a", "aac", "-y", outputPath]);

    const outputBuffer = await readFile(outputPath);
    const filePath = `${job.user_id}/dialogue-${job.id}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(filePath, outputBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
    await supabase.from("dialogue_video_jobs").update({ status: "done", output_url: publicUrlData.publicUrl }).eq("id", job.id);
    await recordGenerationHistory(job.user_id, job.mini_app_id, "video", publicUrlData.publicUrl);
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
