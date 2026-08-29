import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";
import { CHARACTER_PROVIDER_COST_VND } from "@/lib/story-video";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// Chi phí Fal.ai THẬT (giá gốc app trả provider, KHÔNG phải giá bán đã cộng margin cho khách) cho từng
// job "Video từ ý tưởng truyện" — tính từ đúng các mức giá/cảnh đã snapshot lúc submit job (không tra
// lại catalog hiện tại, vì admin có thể đã sửa giá catalog sau khi job đó chạy). Đây là số cho LƯỢT
// CHẠY ĐẦU (num_scenes cảnh) — CHƯA cộng thêm các lần khách bấm "Tạo lại" riêng lẻ từng cảnh sau đó
// (mỗi lần tạo lại tốn thêm đúng 1 giá/cảnh nhưng không có bộ đếm riêng để cộng dồn ở đây).
export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data: jobs, error } = await supabase
    .from("story_video_jobs")
    .select(
      "id, user_id, status, created_at, num_scenes, image_model, video_model, image_provider_cost_vnd_per_scene, video_provider_cost_vnd_per_scene, character_source"
    )
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (jobs ?? []).map((j) => {
    const characterCostVnd = j.character_source === "generated" ? CHARACTER_PROVIDER_COST_VND : 0;
    const imageCostVnd = (j.image_provider_cost_vnd_per_scene ?? 0) * j.num_scenes;
    const videoCostVnd = (j.video_provider_cost_vnd_per_scene ?? 0) * j.num_scenes;
    return {
      id: j.id,
      userId: j.user_id,
      status: j.status,
      createdAt: j.created_at,
      numScenes: j.num_scenes,
      imageModel: j.image_model,
      videoModel: j.video_model,
      characterCostVnd,
      imageCostVnd,
      videoCostVnd,
      totalCostVnd: characterCostVnd + imageCostVnd + videoCostVnd,
    };
  });

  return Response.json({ rows, grandTotalVnd: rows.reduce((sum, r) => sum + r.totalCostVnd, 0) });
}
