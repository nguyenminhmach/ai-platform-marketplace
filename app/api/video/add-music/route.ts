import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { getSupabaseAdmin } from "@/lib/supabase";

const execFileAsync = promisify(execFile);

// Ghép 1 bài nhạc nền (đã có sẵn trong thư viện admin upload) vào video AI vừa tạo — Kling chỉ tạo
// video câm, không có audio. Giữ nguyên video stream (copy, không encode lại) cho nhanh, chỉ mux
// thêm audio track đã cắt vừa đúng độ dài video (-shortest).
export const maxDuration = 60;

export async function POST(req: Request) {
  const { userId, jobId, trackId } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!jobId || !trackId) return Response.json({ error: "Thiếu jobId hoặc trackId" }, { status: 400 });
  if (!ffmpegPath) return Response.json({ error: "Máy chủ chưa hỗ trợ ghép nhạc (thiếu ffmpeg)" }, { status: 500 });

  const supabase = getSupabaseAdmin();

  const { data: job, error: jobError } = await supabase
    .from("video_jobs")
    .select("id, user_id, status, output_url")
    .eq("id", jobId)
    .single();
  if (jobError || !job) return Response.json({ error: "Không tìm thấy video" }, { status: 404 });
  if (job.user_id !== userId) return Response.json({ error: "Không có quyền với video này" }, { status: 403 });
  if (job.status !== "done" || !job.output_url) {
    return Response.json({ error: "Video chưa tạo xong, chưa thể ghép nhạc" }, { status: 400 });
  }

  const { data: track, error: trackError } = await supabase
    .from("background_music")
    .select("id, file_url")
    .eq("id", trackId)
    .single();
  if (trackError || !track) return Response.json({ error: "Không tìm thấy bài nhạc" }, { status: 404 });

  const workDir = await mkdtemp(path.join(tmpdir(), "add-music-"));
  const videoPath = path.join(workDir, "video.mp4");
  const audioPath = path.join(workDir, "audio.src");
  const outputPath = path.join(workDir, "output.mp4");

  try {
    const [videoRes, audioRes] = await Promise.all([fetch(job.output_url), fetch(track.file_url)]);
    if (!videoRes.ok) throw new Error(`Không tải được video: ${videoRes.status}`);
    if (!audioRes.ok) throw new Error(`Không tải được nhạc: ${audioRes.status}`);

    await writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));
    await writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()));

    await execFileAsync(ffmpegPath, [
      "-i", videoPath,
      "-i", audioPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      "-y",
      outputPath,
    ]);

    const outputBuffer = await readFile(outputPath);
    const filePath = `${userId}/${jobId}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(filePath, outputBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);

    await supabase
      .from("video_jobs")
      .update({ output_url_with_music: publicUrlData.publicUrl, music_track_id: trackId })
      .eq("id", jobId);

    return Response.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error("[add-music]", err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra khi ghép nhạc" }, { status: 500 });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
