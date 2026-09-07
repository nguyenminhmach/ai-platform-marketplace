import { cancelStoryVideoJob } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách chủ động bấm "Dừng tạo" khi job đang chạy dở — dừng hẳn (mọi webhook Fal.ai trả về sau đó bị
// bỏ qua, xem isJobCancelled() trong lib/story-video.ts), KHÔNG hoàn credit các cảnh đã tốn trước đó.
export async function POST(req: Request) {
  const { jobId } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    await cancelStoryVideoJob(userId, jobId);
    return Response.json({ success: true });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
