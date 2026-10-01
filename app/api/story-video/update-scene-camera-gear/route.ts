import { updateSceneCameraGear } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Mirror đúng update-scene-light-direction/route.ts nhưng cho 3 trục thiết bị quay (máy quay/lens/khẩu
// độ) — khách bấm chọn 1 trong 3 bộ nút khác ở khối "Xem trước bố cục" thì gọi route này lưu lại, chỉ
// gửi field nào khách thật sự đổi (xem updateSceneCameraGear).
export async function POST(req: Request) {
  const { sceneId, cameraBody, lens, aperture } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof sceneId !== "number") return Response.json({ error: "Thiếu sceneId" }, { status: 400 });

  try {
    await updateSceneCameraGear(userId, sceneId, {
      cameraBody: typeof cameraBody === "string" ? cameraBody : undefined,
      lens: typeof lens === "string" ? lens : undefined,
      aperture: typeof aperture === "string" ? aperture : undefined,
    });
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
