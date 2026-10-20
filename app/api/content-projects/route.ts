import { getAuthenticatedUserId } from "@/lib/auth-server";
import { createContentProject, listContentProjects } from "@/lib/content-projects";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  try {
    const projects = await listContentProjects(userId);
    return Response.json({ projects });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { name, isPrivate } = await req.json();
  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "Thiếu tên dự án" }, { status: 400 });
  }

  try {
    const project = await createContentProject(userId, name, isPrivate !== false);
    return Response.json({ project });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
