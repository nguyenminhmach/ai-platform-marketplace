import { createStoryProject, getProjectView } from "@/lib/story-video-projects";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Video NHIỀU CHƯƠNG — tạo dự án mới (lúc khách bật "Video nhiều chương") + đọc lại dự án (khôi phục sau khi
// tải lại trang, hoặc theo dõi sau khi ghép cuối). userId luôn lấy từ session, không tin client gửi.
export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const { miniAppId } = await req.json();
  if (typeof miniAppId !== "string" || !miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  try {
    const projectId = await createStoryProject(userId, miniAppId);
    return Response.json({ projectId });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const projectId = Number(new URL(req.url).searchParams.get("projectId"));
  if (!Number.isInteger(projectId) || projectId <= 0) return Response.json({ error: "Thiếu projectId" }, { status: 400 });
  try {
    return Response.json({ project: await getProjectView(userId, projectId) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 404 });
  }
}
