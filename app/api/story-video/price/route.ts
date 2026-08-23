import { computeStoryVideoCreditCost, computeCharacterCreditCost, MIN_SCENES, MAX_SCENES } from "@/lib/story-video";

// Giá "Video từ ý tưởng truyện" tăng theo số phân cảnh khách chọn (2-5) — route riêng vì
// /api/mini-app/[id]/price chỉ tính theo 1 mức giá cố định/app, không nhận thêm tham số.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");
  const numScenes = Number(searchParams.get("numScenes"));
  const imageModelKey = searchParams.get("imageModelKey") ?? undefined;
  const videoModelKey = searchParams.get("videoModelKey") ?? undefined;
  const resolutionKey = searchParams.get("resolutionKey") ?? undefined;
  const durationKey = searchParams.get("durationKey") ?? undefined;

  if (!miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (!numScenes || numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    return Response.json({ error: `numScenes phải từ ${MIN_SCENES} đến ${MAX_SCENES}` }, { status: 400 });
  }

  try {
    const [{ imageCost, videoCost, totalCost }, { creditCost: characterCost }] = await Promise.all([
      computeStoryVideoCreditCost(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey),
      computeCharacterCreditCost(),
    ]);
    // characterCost chỉ tốn nếu ảnh tải lên chưa phải sheet nhiều góc và không chọn Character đã lưu
    // (AI tự phân loại lúc submit) — trả kèm để frontend hiện "tối đa X credit" thay vì số cố định sai.
    return Response.json({ imageCost, videoCost, totalCost, characterCost });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
