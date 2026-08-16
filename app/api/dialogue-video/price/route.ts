import { computeDialogueVideoCreditCost, MIN_CHARACTERS, MAX_CHARACTERS } from "@/lib/dialogue-video";

// Giá "Video đồng nhất nhân vật" tăng theo số nhân vật khách chọn (2-4 người) — route riêng vì
// /api/mini-app/[id]/price chỉ tính theo 1 mức giá cố định/app, không nhận thêm tham số.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");
  const characterCount = Number(searchParams.get("characterCount"));

  if (!miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (!characterCount || characterCount < MIN_CHARACTERS || characterCount > MAX_CHARACTERS) {
    return Response.json({ error: `characterCount phải từ ${MIN_CHARACTERS} đến ${MAX_CHARACTERS}` }, { status: 400 });
  }

  try {
    const creditCost = await computeDialogueVideoCreditCost(miniAppId, characterCount);
    return Response.json({ creditCost });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
