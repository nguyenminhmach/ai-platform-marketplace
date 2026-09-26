import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { recordGenerationHistory } from "@/lib/ai-router";
import { stitchChapterVideos } from "@/lib/story-video";

// Video NHIỀU CHƯƠNG — 1 "dự án" gồm nhiều chương, mỗi chương là 1 job story-video chạy đầy đủ pipeline
// hiện có (xem migration-story-video-projects.sql). Khách bấm "Kết thúc" thì ghép video các chương theo
// thứ tự chương thành video cuối. Lõi tạo video không đổi — file này chỉ lo dự án + ghép cuối.
export const MAX_PROJECT_CHAPTERS = 10;

// Đang ghép quá lâu (hàm bị ngắt giữa chừng) thì cho phép bấm ghép lại — cùng tinh thần STITCH_STALE_CHECK_MS.
const FINALIZE_STALE_MS = 6 * 60 * 1000;

export type ProjectChapterView = {
  chapterIndex: number;
  jobId: number;
  status: string;
  outputUrl: string | null;
  storyDescription: string | null;
};

export type ProjectView = {
  id: number;
  status: string;
  aspectRatio: string | null;
  finalOutputUrl: string | null;
  errorMessage: string | null;
  chapters: ProjectChapterView[];
};

export async function createStoryProject(userId: string, miniAppId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("story_video_projects")
    .insert({ user_id: userId, mini_app_id: miniAppId })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Không tạo được dự án");
  return data.id;
}

async function getOwnedProject(userId: string, projectId: number) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("story_video_projects")
    .select("id, user_id, mini_app_id, status, aspect_ratio, final_output_url, error_message, updated_at")
    .eq("id", projectId)
    .single();
  if (!data || data.user_id !== userId) throw new Error("Không tìm thấy dự án");
  return data;
}

// Gắn 1 job vừa tạo vào dự án ở đúng chỉ số chương. Nhiều job cùng chapter_index là bình thường (khách
// chạy lại chương sau khi lần trước lỗi) — lúc ghép cuối chỉ lấy job xong MỚI NHẤT của mỗi chương. Lỗi ở
// đây KHÔNG làm hỏng job (credit đã trừ, job đã chạy) — nơi gọi chỉ log lại.
export async function attachJobToProject(userId: string, projectId: number, jobId: number, chapterIndex: number): Promise<void> {
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= MAX_PROJECT_CHAPTERS) {
    throw new Error(`Chương phải từ 1 đến ${MAX_PROJECT_CHAPTERS}`);
  }
  const project = await getOwnedProject(userId, projectId);
  if (project.status === "done") throw new Error("Dự án đã kết thúc");
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("story_video_jobs").select("user_id, aspect_ratio").eq("id", jobId).single();
  if (!job || job.user_id !== userId) throw new Error("Không tìm thấy job");
  const { error } = await supabase.from("story_video_jobs").update({ project_id: projectId, chapter_index: chapterIndex }).eq("id", jobId);
  if (error) throw new Error(error.message);
  // Chương đầu tiên khoá tỉ lệ khung hình cho cả dự án.
  if (!project.aspect_ratio && job.aspect_ratio) {
    await supabase.from("story_video_projects").update({ aspect_ratio: job.aspect_ratio }).eq("id", projectId);
  }
}

export async function getProjectView(userId: string, projectId: number): Promise<ProjectView> {
  const project = await getOwnedProject(userId, projectId);
  const supabase = getSupabaseAdmin();
  const { data: jobs } = await supabase
    .from("story_video_jobs")
    .select("id, chapter_index, status, output_url, story_description")
    .eq("project_id", projectId)
    .order("id", { ascending: true });
  // Mỗi chương lấy job MỚI NHẤT (id lớn nhất) — chạy lại chương thì bản mới thay bản cũ trên giao diện.
  const latestByChapter = new Map<number, ProjectChapterView>();
  for (const j of jobs ?? []) {
    if (typeof j.chapter_index !== "number") continue;
    latestByChapter.set(j.chapter_index, {
      chapterIndex: j.chapter_index,
      jobId: j.id,
      status: j.status,
      outputUrl: j.output_url,
      storyDescription: j.story_description,
    });
  }
  return {
    id: project.id,
    status: project.status,
    aspectRatio: project.aspect_ratio,
    finalOutputUrl: project.final_output_url,
    errorMessage: project.error_message,
    chapters: [...latestByChapter.values()].sort((a, b) => a.chapterIndex - b.chapterIndex),
  };
}

// "Kết thúc": ghép video các chương ĐÃ XONG (theo thứ tự chương) thành video cuối. Chương chưa xong/lỗi bị
// bỏ qua (giao diện đã chặn khi chương đang chạy). Ghép miễn phí (chỉ tốn CPU server, không gọi Fal.ai).
export async function finalizeStoryProject(userId: string, projectId: number): Promise<string> {
  const project = await getOwnedProject(userId, projectId);
  if (project.status === "done" && project.final_output_url) return project.final_output_url;
  if (project.status === "finalizing" && Date.now() - new Date(project.updated_at).getTime() < FINALIZE_STALE_MS) {
    throw new Error("Dự án đang được ghép, vui lòng chờ");
  }

  const view = await getProjectView(userId, projectId);
  const doneChapters = view.chapters.filter((c) => c.status === "done" && c.outputUrl);
  if (doneChapters.length === 0) throw new Error("Chưa có chương nào hoàn thành để ghép");

  const supabase = getSupabaseAdmin();
  // updated_at cập nhật tay (bảng không có trigger) — mốc để nhận ra lượt ghép bị ngắt giữa chừng (FINALIZE_STALE_MS).
  await supabase
    .from("story_video_projects")
    .update({ status: "finalizing", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", projectId);
  try {
    const buffer = await stitchChapterVideos(
      doneChapters.map((c) => c.outputUrl as string),
      project.aspect_ratio ?? "9:16"
    );
    const filePath = `${userId}/story-project-${projectId}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage.from("videos").upload(filePath, buffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
    const url = publicUrlData.publicUrl;
    await supabase.from("story_video_projects").update({ status: "done", final_output_url: url }).eq("id", projectId);
    await recordGenerationHistory(userId, project.mini_app_id, "video", url);
    return url;
  } catch (err) {
    console.error(`[story-project] Dự án #${projectId} lỗi ghép cuối:`, err);
    // Về lại "active" (không phải "failed") để khách bấm "Kết thúc" thử lại — không mất các chương đã xong.
    await supabase
      .from("story_video_projects")
      .update({ status: "active", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", projectId);
    throw err;
  }
}
