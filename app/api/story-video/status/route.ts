import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveStoryVideoJob } from "@/lib/story-video";

const STAGE_LABEL: Record<string, string> = {
  pending: "Đang bắt đầu...",
  generating_character: "Đang tạo ảnh Character (nhiều góc) từ ảnh anh/chị tải lên...",
  character_ready: "Đã có ảnh Character — xem trước và bấm \"Tiếp tục chia cảnh\" nếu ưng ý.",
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
  const { data, error } = await supabase
    .from("story_video_jobs")
    .select("status, output_url, error_message, character_sheet_url, character_source, location_reference_url")
    .eq("id", jobId)
    .single();
  if (error || !data) return Response.json({ error: "Không tìm thấy job" }, { status: 404 });

  let progressText: string | null = null;
  let scenes:
    | {
        id: number;
        position: number;
        imageUrl: string | null;
        videoUrl: string | null;
        hasDialogue: boolean;
        motionPrompt: string;
      }[]
    | undefined;
  let characters:
    | { position: number; label: string | null; sheetUrl: string | null; angleUrls: unknown; ready: boolean }[]
    | undefined;

  // Job nhiều nhân vật (Bước 1) — chỉ có hàng ở đây khi job được tạo qua nhánh nhiều nhân vật, job 1
  // nhân vật trả mảng rỗng nên bỏ qua (giữ nguyên field cũ characterSheetUrl/characterSource cho luồng
  // 1 nhân vật, không đổi gì).
  if (["generating_character", "character_ready"].includes(data.status)) {
    const { data: jobCharacterRows } = await supabase
      .from("story_video_job_characters")
      .select("position, label, character_sheet_url, character_angle_urls")
      .eq("job_id", jobId)
      .order("position", { ascending: true });
    if (jobCharacterRows && jobCharacterRows.length > 0) {
      characters = jobCharacterRows.map((c) => ({
        position: c.position,
        label: c.label,
        sheetUrl: c.character_sheet_url,
        angleUrls: c.character_angle_urls,
        ready: !!c.character_sheet_url,
      }));
    }
  }

  // Bao gồm cả "failed" — nếu ảnh phân cảnh đã tạo xong trước khi lỗi (vd lỗi ở bước tạo video sau
  // đó), khách vẫn cần xem lại được ảnh đã tốn credit tạo ra, không phải tự dưng "biến mất".
  if (["generating_images", "images_ready", "generating_videos", "stitching", "failed"].includes(data.status)) {
    const { data: sceneRows } = await supabase
      .from("story_video_scenes")
      .select("id, position, image_url, video_url, lipsync_url, dialogue_line, motion_prompt, scene_description")
      .eq("job_id", jobId)
      .order("position", { ascending: true });
    if (sceneRows) {
      // Cảnh có lời thoại đã lồng tiếng xong (lipsync_url) thì trả bản đó làm video cuối — frontend
      // không cần biết gì về lồng tiếng, chỉ thấy đúng video đã sẵn sàng. hasDialogue chỉ để hiện badge
      // 🗣️ tham khảo trên UI, không ảnh hưởng logic tạo video. motionPrompt để khách sửa lại trước khi
      // bấm tạo lại video (vd lỗi bị model chặn nội dung, gửi lại y hệt câu cũ dễ lặp lại lỗi).
      scenes = sceneRows.map((s) => ({
        id: s.id,
        position: s.position,
        imageUrl: s.image_url,
        videoUrl: s.lipsync_url ?? s.video_url,
        hasDialogue: !!s.dialogue_line,
        motionPrompt: s.motion_prompt ?? s.scene_description ?? "",
      }));
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
    characterSheetUrl: data.character_sheet_url,
    characterSource: data.character_source,
    characters,
    locationReferenceUrl: data.location_reference_url,
  });
}
