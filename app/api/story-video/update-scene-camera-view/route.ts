import { updateSceneCameraView } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách kéo chuột xoay mannequin 3D ở khối "Xem trước bố cục" (status "scenes_ready") rồi bấm "Chọn
// góc này" — ghi đè lại camera_view thật của cảnh đó, dùng đúng góc khách chọn khi bấm "Tạo ảnh" sau.
export async function POST(req: Request) {
  const { sceneId, cameraView } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof sceneId !== "number" || typeof cameraView !== "string") {
    return Response.json({ error: "Thiếu sceneId hoặc cameraView" }, { status: 400 });
  }

  try {
    await updateSceneCameraView(userId, sceneId, cameraView);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
