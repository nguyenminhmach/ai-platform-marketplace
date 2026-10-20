import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deleteContentProject, renameContentProject } from "@/lib/content-projects";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  const { name } = await req.json();
  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "Thiếu tên dự án" }, { status: 400 });
  }

  try {
    const project = await renameContentProject(userId, projectId, name);
    return Response.json({ project });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  try {
    await deleteContentProject(userId, projectId);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
