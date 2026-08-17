import { getVideoQualityTiers } from "@/lib/ai-router";

// Danh sách tier chất lượng (Cơ bản/Cao cấp) + giá cho app video có nhiều tier (hiện chỉ
// "Tạo video quảng cáo ngắn") — trang chi tiết gọi route này để build nút chọn, giống hệt pattern
// GET /api/outfit-swap cho các model của app "Thay trang phục".
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");
  if (!miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });

  try {
    const tiers = await getVideoQualityTiers(miniAppId);
    return Response.json({ tiers });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
