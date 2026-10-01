import { updateSceneLightDirection } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Mirror đúng update-scene-camera-view/route.ts nhưng cho light_direction — khách bấm chọn preset
// hướng sáng khác ở khối "Xem trước bố cục" (status "scenes_ready") thì gọi route này lưu lại.
export async function POST(req: Request) {
  const { sceneId, lightDirection } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof sceneId !== "number" || typeof lightDirection !== "string") {
    return Response.json({ error: "Thiếu sceneId hoặc lightDirection" }, { status: 400 });
  }

  try {
    await updateSceneLightDirection(userId, sceneId, lightDirection);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
