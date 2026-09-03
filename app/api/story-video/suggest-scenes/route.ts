import { suggestSceneCount, MIN_SCENES, MAX_SCENES } from "@/lib/story-video";

// Cho khách bấm "AI gợi ý số cảnh" thay vì tự đếm hành động trong truyện rồi tự chọn — gọi 1 lượt
// Gemini Flash rẻ đếm hộ, không trừ credit khách (giống classify-character).
export async function POST(req: Request) {
  const { storyDescription } = await req.json();
  if (typeof storyDescription !== "string" || !storyDescription.trim()) {
    return Response.json({ error: "Thiếu storyDescription" }, { status: 400 });
  }

  try {
    const numScenes = await suggestSceneCount(storyDescription.trim());
    return Response.json({ numScenes, min: MIN_SCENES, max: MAX_SCENES });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
