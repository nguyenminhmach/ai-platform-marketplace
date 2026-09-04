import { finalizeStoryVideoSkippingFailedScenes } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách chấp nhận bỏ qua cảnh mãi không tạo video được (vd bị model chặn nội dung, đã thử nhiều lần
// vẫn lỗi) — ghép video cuối chỉ từ các cảnh đã có video, không chờ đủ N/N cảnh nữa.
export async function POST(req: Request) {
  const { jobId } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof jobId !== "number") return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  try {
    await finalizeStoryVideoSkippingFailedScenes(userId, jobId);
    return Response.json({ success: true });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
