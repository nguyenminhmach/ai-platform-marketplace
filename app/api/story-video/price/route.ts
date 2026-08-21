import { computeStoryVideoCreditCost, MIN_SCENES, MAX_SCENES } from "@/lib/story-video";

// Giá "Video từ ý tưởng truyện" tăng theo số phân cảnh khách chọn (2-5) — route riêng vì
// /api/mini-app/[id]/price chỉ tính theo 1 mức giá cố định/app, không nhận thêm tham số.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");
  const numScenes = Number(searchParams.get("numScenes"));
  const imageModelKey = searchParams.get("imageModelKey") ?? undefined;
  const videoModelKey = searchParams.get("videoModelKey") ?? undefined;

  if (!miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (!numScenes || numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    return Response.json({ error: `numScenes phải từ ${MIN_SCENES} đến ${MAX_SCENES}` }, { status: 400 });
  }

  try {
    const { imageCost, videoCost, totalCost } = await computeStoryVideoCreditCost(miniAppId, numScenes, imageModelKey, videoModelKey);
    return Response.json({ imageCost, videoCost, totalCost });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
