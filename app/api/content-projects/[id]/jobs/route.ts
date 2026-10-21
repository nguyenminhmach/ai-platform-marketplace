import { getAuthenticatedUserId } from "@/lib/auth-server";
import { listPromptImageJobsByProject } from "@/lib/prompt-image";
import { listStoryVideoJobsByContentProject } from "@/lib/story-video";

// GET /api/content-projects/[id]/jobs — lưới nội dung của 1 dự án trong panel nhanh video-tu-y-tuong.
// Gộp 2 nguồn: prompt_image_jobs (LEGACY — ảnh tạo trước khi tab "hình ảnh" chuyển sang dùng chung
// pipeline với tab "video", xem ghi chú đầu lib/prompt-image.ts) và story_video_jobs (nguồn DUY NHẤT
// cho mọi job mới, cả 2 tab, xem listStoryVideoJobsByContentProject) — thiếu nguồn sau sẽ làm nội dung
// tạo mới "biến mất" khỏi gallery dù vẫn tồn tại thật trong database.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  try {
    const [legacyJobs, storyJobs] = await Promise.all([
      listPromptImageJobsByProject(userId, projectId),
      listStoryVideoJobsByContentProject(userId, projectId),
    ]);
    const jobs = [...legacyJobs, ...storyJobs].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return Response.json({ jobs });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
