import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deleteContentProject, renameContentProject } from "@/lib/content-projects";
import { deleteGenerationHistoryByProject } from "@/lib/generation-history";

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

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) return Response.json({ error: "id không hợp lệ" }, { status: 400 });

  // SỬA (phản hồi thật user: lo ngại ảnh/video trong dự án bị xoá cứ tích rác dung lượng) — tuỳ chọn
  // "deleteContent" (query param, mặc định false = hành vi cũ chỉ xoá nhãn) — true thì xoá LUÔN toàn bộ
  // nội dung (ảnh/video + file Storage thật) đã gắn vào dự án này, VĨNH VIỄN, không hoàn tác được. Phải
  // xoá nội dung TRƯỚC khi xoá dòng content_projects (project_id cần còn hợp lệ lúc lọc).
  const { searchParams } = new URL(req.url);
  const deleteContent = searchParams.get("deleteContent") === "true";

  try {
    if (deleteContent) await deleteGenerationHistoryByProject(userId, projectId);
    await deleteContentProject(userId, projectId);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
