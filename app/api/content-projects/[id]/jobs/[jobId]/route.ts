import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deletePromptImageJob } from "@/lib/prompt-image";

// DELETE /api/content-projects/[id]/jobs/[jobId] — xoá 1 mục khỏi lưới dự án (xem nút 🗑️ trên mỗi ô).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { jobId } = await params;
  const id = Number(jobId);
  if (!Number.isFinite(id)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  try {
    await deletePromptImageJob(userId, id);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
