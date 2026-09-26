import { attachJobToProject } from "@/lib/story-video-projects";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách bật "Video nhiều chương" khi trang ĐÃ có sẵn 1 job (vd job vừa khôi phục sau khi tải lại trang) —
// gắn job đó vào dự án làm chương đang soạn, thay vì bắt khách bỏ job để làm lại từ đầu.
export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const { projectId, jobId, chapterIndex } = await req.json();
  if (typeof projectId !== "number" || typeof jobId !== "number" || typeof chapterIndex !== "number") {
    return Response.json({ error: "Thiếu projectId/jobId/chapterIndex" }, { status: 400 });
  }
  try {
    await attachJobToProject(userId, projectId, jobId, chapterIndex);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 400 });
  }
}
