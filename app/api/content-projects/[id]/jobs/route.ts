import { getAuthenticatedUserId } from "@/lib/auth-server";
import { listPromptImageJobsByProject } from "@/lib/prompt-image";

// GET /api/content-projects/[id]/jobs — lưới nội dung của 1 dự án trong panel nhanh video-tu-y-tuong.
// Đọc thẳng prompt_image_jobs (có đủ trạng thái, kể cả lỗi) thay vì generation_history (chỉ có job
// thành công) — xem ghi chú ở listPromptImageJobsByProject.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  try {
    const jobs = await listPromptImageJobsByProject(userId, projectId);
    return Response.json({ jobs });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
