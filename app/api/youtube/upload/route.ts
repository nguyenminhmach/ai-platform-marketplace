import { uploadVideoToYoutube } from "@/lib/youtube";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Upload video (đã render xong, có URL thật trên Storage) lên kênh YouTube của user đang đăng nhập.
// Video có thể vài chục MB nên upload lên YouTube tốn thời gian — để timeout dài hơn mặc định.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { videoUrl, title, description } = await req.json();

  // userId LUÔN lấy từ session đã xác thực (cookie) — trước đây ai biết userId người khác đều "đăng
  // video" được vào kênh YouTube đã kết nối của họ.
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof videoUrl !== "string" || !videoUrl) {
    return Response.json({ error: "Thiếu video" }, { status: 400 });
  }
  if (typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "Thiếu tiêu đề video" }, { status: 400 });
  }

  try {
    const youtubeUrl = await uploadVideoToYoutube(userId, videoUrl, title.trim(), typeof description === "string" ? description : "");
    return Response.json({ success: true, youtubeUrl });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra khi đăng video" }, { status: 500 });
  }
}
