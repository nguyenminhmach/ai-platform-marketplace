import { finalizeStoryProject } from "@/lib/story-video-projects";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// "Kết thúc" dự án nhiều chương — tải + mã hoá + ghép video các chương chạy ngay trong request này, cần tới
// vài chục giây tới vài phút tuỳ số chương (xem stitchChapterVideos) nên nới hẳn maxDuration.
export const maxDuration = 300;

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const { projectId, transitions } = await req.json();
  if (typeof projectId !== "number" || !Number.isInteger(projectId)) return Response.json({ error: "Thiếu projectId" }, { status: 400 });
  // Validate mềm — sai định dạng thì bỏ qua hẳn (rơi về mặc định "cut" mọi điểm nối trong
  // finalizeStoryProject/stitchChapterVideos), không chặn cả request chỉ vì field tuỳ chọn này.
  const validTransitions =
    Array.isArray(transitions) && transitions.every((t) => t === "cut" || t === "crossfade") ? transitions : undefined;
  try {
    const url = await finalizeStoryProject(userId, projectId, validTransitions);
    return Response.json({ success: true, finalOutputUrl: url });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
