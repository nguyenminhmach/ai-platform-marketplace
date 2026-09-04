import { checkSceneAnatomy } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Khách tự bấm "Kiểm tra thiếu chi thể" trên 1 ảnh phân cảnh nghi ngờ bị lỗi — Gemini Flash rẻ,
// không trừ credit (cùng tiền lệ /api/story-video/classify-character).
export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { imageUrl } = await req.json();
  if (typeof imageUrl !== "string" || !imageUrl) return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });

  try {
    const result = await checkSceneAnatomy(imageUrl);
    return Response.json(result);
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
