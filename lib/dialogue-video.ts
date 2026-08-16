// Pipeline "Video đồng nhất nhân vật" — 2-4 nhân vật đối thoại tiếng Việt.
// (1) Kling image-to-video cho từng nhân vật (video câm) -> (2) ElevenLabs đọc lời thoại tiếng Việt
// -> (3) Kling LipSync khớp môi cho từng nhân vật -> (4) ffmpeg ghép N clip đã lipsync lại làm 1.
// Mỗi nhân vật là 1 hàng trong dialogue_video_characters, xử lý độc lập, ghép theo "position".

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { generateVietnameseSpeech, CHARACTER_VOICE_IDS } from "@/lib/elevenlabs";
import { recordGenerationHistory } from "@/lib/ai-router";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

const execFileAsync = promisify(execFile);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export const MIN_CHARACTERS = 2;
export const MAX_CHARACTERS = 4;

// Prompt chuyển động cố định cho bước tạo video câm — giữ khung hình ổn định, mặt rõ ràng để
// bước lipsync sau đó khớp môi chính xác. Không cho khách chỉnh ở bản đầu tiên (giữ đơn giản).
const NEUTRAL_TALKING_PROMPT =
  "Người trong ảnh đứng yên tại chỗ, nhìn thẳng về phía camera, đầu và vai có cử động nhẹ tự nhiên như đang trò chuyện, không rời khỏi khung hình, không đổi góc máy, ánh sáng giữ nguyên.";

type CharacterRow = {
  id: number;
  job_id: number;
  position: number;
  image_url: string;
  line: string;
  fal_request_id: string | null;
  video_url: string | null;
  audio_url: string | null;
  lipsync_fal_request_id: string | null;
  lipsync_url: string | null;
};

type JobRow = {
  id: number;
  user_id: string;
  mini_app_id: string;
  status: string;
  updated_at: string;
  credit_tx_id: number | null;
};

async function getMiniAppModelConfig(miniAppId: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("credit_cost, model_config").eq("id", miniAppId).single();
  if (!data) throw new Error("Không tìm thấy Mini App");
  return data as {
    credit_cost: number;
    model_config: { video_model: string; lipsync_model: string; provider_cost_vnd_per_character?: number };
  };
}

export async function computeDialogueVideoCreditCost(miniAppId: string, characterCount: number): Promise<number> {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const perCharacter = miniApp.model_config.provider_cost_vnd_per_character;
  if (!perCharacter) return miniApp.credit_cost;
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  return computeDynamicCreditCost(perCharacter * characterCount, marginPercent, vndPerCredit);
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
  characters: { imageUrl: string; line: string }[],
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  if (characters.length < MIN_CHARACTERS || characters.length > MAX_CHARACTERS) {
    throw new Error(`Cần từ ${MIN_CHARACTERS} đến ${MAX_CHARACTERS} nhân vật`);
  }

  const creditCost = await computeDialogueVideoCreditCost(miniAppId, characters.length);
  const deduction = await deductCredit(userId, creditCost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const supabase = getSupabaseAdmin();

  const { data: job, error: insertError } = await supabase
    .from("dialogue_video_jobs")
    .insert({ user_id: userId, mini_app_id: miniAppId, status: "pending", credit_tx_id: deduction.txId })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được job");
  }

  try {
    const { data: characterRows, error: charError } = await supabase
      .from("dialogue_video_characters")
      .insert(
        characters.map((c, index) => ({
          job_id: job.id,
          position: index,
          image_url: c.imageUrl,
          line: c.line,
        }))
      )
      .select("id, position, image_url");
    if (charError || !characterRows) throw new Error(charError?.message ?? "Không tạo được nhân vật");

    const miniApp = await getMiniAppModelConfig(miniAppId);
    await Promise.all(
      characterRows.map(async (row) => {
        const requestId = await submitFalJob(
          miniApp.model_config.video_model,
          { prompt: NEUTRAL_TALKING_PROMPT, image_url: row.image_url },
          `${SITE_URL}/api/dialogue-video/webhook?jobId=${job.id}&characterId=${row.id}&stage=video`
        );
        await supabase.from("dialogue_video_characters").update({ fal_request_id: requestId }).eq("id", row.id);
      })
    );

    await supabase.from("dialogue_video_jobs").update({ status: "generating_video" }).eq("id", job.id);
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

async function getCharacters(jobId: number): Promise<CharacterRow[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("dialogue_video_characters")
    .select("*")
    .eq("job_id", jobId)
    .order("position", { ascending: true });
  return (data as CharacterRow[]) ?? [];
}

// Gọi khi 1 clip video câm (bước 1) của 1 nhân vật tạo xong — khi TẤT CẢ nhân vật xong mới chuyển
// sang bước TTS+lipsync.
export async function applyVideoStageResult(jobId: number, characterId: number, falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi tạo video: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    await failJob(jobId, "Không tìm thấy URL video trong phản hồi Fal.ai");
    return;
  }

  await supabase.from("dialogue_video_characters").update({ video_url: videoUrl }).eq("id", characterId);

  const characters = await getCharacters(jobId);
  if (characters.length === 0 || characters.some((c) => !c.video_url)) return; // chờ nhân vật còn lại

  await proceedToLipsync(jobId, characters);
}

async function proceedToLipsync(jobId: number, characters: CharacterRow[]) {
  const supabase = getSupabaseAdmin();
  try {
    const { data: job } = await supabase.from("dialogue_video_jobs").select("mini_app_id").eq("id", jobId).single();
    if (!job) throw new Error("Không tìm thấy job");
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);

    await Promise.all(
      characters.map(async (character, index) => {
        const voiceId = CHARACTER_VOICE_IDS[index % CHARACTER_VOICE_IDS.length];
        const audioUrl = await generateVietnameseSpeech(character.line, voiceId, jobId, character.id);
        const requestId = await submitFalJob(
          miniApp.model_config.lipsync_model,
          { video_url: character.video_url, audio_url: audioUrl },
          `${SITE_URL}/api/dialogue-video/webhook?jobId=${jobId}&characterId=${character.id}&stage=lipsync`
        );
        await supabase
          .from("dialogue_video_characters")
          .update({ audio_url: audioUrl, lipsync_fal_request_id: requestId })
          .eq("id", character.id);
      })
    );

    await supabase.from("dialogue_video_jobs").update({ status: "lipsyncing" }).eq("id", jobId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

// Gọi khi 1 clip đã lipsync (bước 3) của 1 nhân vật xong — khi TẤT CẢ nhân vật xong mới ghép lại
// thành video cuối.
export async function applyLipsyncStageResult(jobId: number, characterId: number, falPayload: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    await failJob(jobId, `Lỗi khớp môi: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    await failJob(jobId, "Không tìm thấy URL video lipsync trong phản hồi Fal.ai");
    return;
  }

  await supabase.from("dialogue_video_characters").update({ lipsync_url: videoUrl }).eq("id", characterId);

  const characters = await getCharacters(jobId);
  if (characters.length === 0 || characters.some((c) => !c.lipsync_url)) return; // chờ nhân vật còn lại

  await stitchAndFinish(jobId, characters);
}

// Ghép N clip đã lipsync (theo đúng thứ tự "position") thành 1 video liền mạch — dùng lại ffmpeg
// đã tích hợp sẵn cho tính năng ghép nhạc nền.
async function stitchAndFinish(jobId: number, characters: CharacterRow[]) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("dialogue_video_jobs").select("user_id, mini_app_id").eq("id", jobId).single();
  if (!job) return;

  await supabase.from("dialogue_video_jobs").update({ status: "stitching" }).eq("id", jobId);

  if (!ffmpegPath) {
    await failJob(jobId, "Máy chủ chưa hỗ trợ ghép video (thiếu ffmpeg)");
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "dialogue-video-"));
  const listPath = path.join(workDir, "list.txt");
  const outputPath = path.join(workDir, "output.mp4");
  const clipPaths: string[] = [];

  try {
    await Promise.all(
      characters.map(async (character, index) => {
        const res = await fetch(character.lipsync_url!);
        if (!res.ok) throw new Error(`Không tải được clip nhân vật ${index + 1}`);
        const clipPath = path.join(workDir, `clip-${index}.mp4`);
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
        clipPaths[index] = clipPath;
      })
    );

    const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await writeFile(listPath, listContent);

    // Re-encode khi ghép (không dùng "-c copy") vì các clip có thể khác codec/timebase nhẹ do đi
    // qua 2 lượt xử lý AI riêng (video-gen rồi lipsync) — ghép trực tiếp dễ lỗi khung hình giữa các đoạn.
    await execFileAsync(ffmpegPath, ["-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-c:a", "aac", "-y", outputPath]);

    const outputBuffer = await readFile(outputPath);
    const filePath = `${job.user_id}/dialogue-${jobId}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(filePath, outputBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
    await supabase.from("dialogue_video_jobs").update({ status: "done", output_url: publicUrlData.publicUrl }).eq("id", jobId);
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
// poll trạng thái, tương tự resolveFalJob() bên video-jobs.ts nhưng có nhiều nhân vật + nhiều bước.
export async function resolveDialogueVideoJob(jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("dialogue_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) return;
  const job = jobData as JobRow;

  if (!["generating_video", "lipsyncing"].includes(job.status)) return;
  const ageMs = Date.now() - new Date(job.updated_at).getTime();
  if (ageMs < STALE_CHECK_MS) return;

  const miniApp = await getMiniAppModelConfig(job.mini_app_id);
  const characters = await getCharacters(jobId);

  if (job.status === "generating_video") {
    for (const character of characters) {
      if (!character.video_url && character.fal_request_id) {
        const result = await pollFalResult(miniApp.model_config.video_model, character.fal_request_id);
        if (result) await applyVideoStageResult(jobId, character.id, result);
      }
    }
  } else if (job.status === "lipsyncing") {
    for (const character of characters) {
      if (!character.lipsync_url && character.lipsync_fal_request_id) {
        const result = await pollFalResult(miniApp.model_config.lipsync_model, character.lipsync_fal_request_id);
        if (result) await applyLipsyncStageResult(jobId, character.id, result);
      }
    }
  }
}
