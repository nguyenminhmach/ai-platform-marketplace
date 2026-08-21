import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveStoryVideoJob } from "@/lib/story-video";

const STAGE_LABEL: Record<string, string> = {
  pending: "Đang bắt đầu...",
  splitting_story: "AI đang chia phân cảnh...",
  generating_images: "Đang tạo ảnh cho từng phân cảnh...",
  images_ready: "Đã tạo xong ảnh — xem trước và bấm \"Tạo video\" nếu ưng ý.",
  generating_videos: "Đang tạo video cho từng phân cảnh...",
  stitching: "Đang ghép các phân cảnh lại thành video hoàn chỉnh...",
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  await resolveStoryVideoJob(Number(jobId)).catch(() => {});

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("story_video_jobs").select("status, output_url, error_message").eq("id", jobId).single();
  if (error || !data) return Response.json({ error: "Không tìm thấy job" }, { status: 404 });

  let progressText: string | null = null;
  let scenes: { position: number; imageUrl: string | null; videoUrl: string | null }[] | undefined;

  if (["generating_images", "images_ready", "generating_videos"].includes(data.status)) {
    const { data: sceneRows } = await supabase
      .from("story_video_scenes")
      .select("position, image_url, video_url")
      .eq("job_id", jobId)
      .order("position", { ascending: true });
    if (sceneRows) {
      scenes = sceneRows.map((s) => ({ position: s.position, imageUrl: s.image_url, videoUrl: s.video_url }));
      if (data.status === "generating_images" || data.status === "generating_videos") {
        const doneCount = sceneRows.filter((s) => (data.status === "generating_images" ? s.image_url : s.video_url)).length;
        progressText = `${STAGE_LABEL[data.status]} (${doneCount}/${sceneRows.length})`;
      }
    }
  }

  return Response.json({
    status: data.status,
    outputUrl: data.output_url,
    errorMessage: data.error_message,
    statusText: progressText ?? STAGE_LABEL[data.status] ?? null,
    scenes,
  });
}
