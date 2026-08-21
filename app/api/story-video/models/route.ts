import { getSupabaseAdmin } from "@/lib/supabase";
import type { ImageModelEntry, VideoModelEntry } from "@/lib/story-video";

// Danh sách model ảnh/video đang bật cho app "Video từ ý tưởng truyện" — trang chi tiết gọi route
// này để build 2 dropdown chọn model (nhóm theo provider), giống pattern GET /api/outfit-swap.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");
  if (!miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("mini_apps").select("model_config").eq("id", miniAppId).single();
  if (error || !data) return Response.json({ error: "Không tìm thấy Mini App" }, { status: 404 });

  const config = data.model_config as { image_models?: ImageModelEntry[]; video_models?: VideoModelEntry[] } | null;
  const imageModels = (config?.image_models ?? []).filter((m) => m.enabled);
  const videoModels = (config?.video_models ?? []).filter((m) => m.enabled);

  return Response.json({ imageModels, videoModels });
}
