import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deletePromptImageJob } from "@/lib/prompt-image";
import { deleteStoryVideoJobFromContentProject } from "@/lib/story-video";

// DELETE /api/content-projects/[id]/jobs/[jobId]?kind=prompt_image|story_video — xoá 1 mục khỏi lưới
// dự án (xem nút 🗑️ trên mỗi ô). "kind" bắt buộc -- 2 bảng nguồn có 2 dãy id riêng, trùng số id hoàn
// toàn có thể xảy ra, không có kind sẽ không biết chắc xoá đúng bảng nào.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { jobId } = await params;
  const id = Number(jobId);
  if (!Number.isFinite(id)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });
  const kind = new URL(req.url).searchParams.get("kind");

  try {
    if (kind === "story_video") {
      await deleteStoryVideoJobFromContentProject(userId, id);
    } else {
      await deletePromptImageJob(userId, id);
    }
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
