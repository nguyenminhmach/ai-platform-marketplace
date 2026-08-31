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

  const jobIds = (jobs ?? []).map((j) => j.id);
  // Đếm số cảnh có lời thoại (dialogue_line) của từng job — dùng GIÁ HIỆN TẠI của lipsync_provider_cost_vnd
  // (không snapshot theo cảnh như image/video ở trên) nên chỉ ước tính đúng cho job gần đây, job cũ có
  // thể lệch nhẹ nếu admin đã đổi giá lồng tiếng sau đó — chấp nhận được cho mục đích tham khảo chi phí.
  const dialogueSceneCountByJob = new Map<number, number>();
  if (jobIds.length > 0) {
    const { data: dialogueScenes } = await supabase
      .from("story_video_scenes")
      .select("job_id")
      .in("job_id", jobIds)
      .not("dialogue_line", "is", null);
    for (const row of dialogueScenes ?? []) {
      dialogueSceneCountByJob.set(row.job_id, (dialogueSceneCountByJob.get(row.job_id) ?? 0) + 1);
    }
  }
  const { data: miniApp } = await supabase.from("mini_apps").select("model_config").eq("id", "video-tu-y-tuong").single();
  const lipsyncProviderCostVnd = (miniApp?.model_config as { lipsync_provider_cost_vnd?: number } | null)?.lipsync_provider_cost_vnd ?? 0;

  const rows = (jobs ?? []).map((j) => {
    const characterCostVnd = j.character_source === "generated" ? CHARACTER_PROVIDER_COST_VND : 0;
    const imageCostVnd = (j.image_provider_cost_vnd_per_scene ?? 0) * j.num_scenes;
    const videoCostVnd = (j.video_provider_cost_vnd_per_scene ?? 0) * j.num_scenes;
    const lipsyncCostVnd = (dialogueSceneCountByJob.get(j.id) ?? 0) * lipsyncProviderCostVnd;
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
      lipsyncCostVnd,
      totalCostVnd: characterCostVnd + imageCostVnd + videoCostVnd + lipsyncCostVnd,
    };
  });

  return Response.json({ rows, grandTotalVnd: rows.reduce((sum, r) => sum + r.totalCostVnd, 0) });
}
