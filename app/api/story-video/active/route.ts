import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Tự khôi phục job story-video gần nhất còn dở dang khi khách quay lại trang (đóng tab/tắt máy giữa
// chừng) — mirror cơ chế /api/video/latest ở các app video đơn giản, nhưng dùng route riêng vì
// story-video có luồng nhiều bước (Character → ảnh → video) và 2 lượt trừ credit riêng (ảnh/video):
// job "failed" vẫn cần khôi phục nếu ảnh đã tạo xong trước khi lỗi ở bước video sau đó (khác app video
// đơn giản chỉ 1 lượt trừ, hoàn đủ khi lỗi nên bỏ qua hẳn "failed").
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  // 7 ngày (trước là 24h) — khách phản ánh ảnh phân cảnh "biến mất" khi đóng tab rồi mở lại sau hơn 1
  // ngày dù job vẫn còn nguyên trong DB, chỉ là ngoài cửa sổ khôi phục cũ.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select("id, story_description, character_image_urls, location_reference_url")
    .eq("user_id", userId)
    .neq("status", "done")
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) return Response.json({ job: null });
  return Response.json({
    job: {
      id: job.id,
      storyDescription: job.story_description,
      characterImageUrls: job.character_image_urls,
      locationReferenceUrl: job.location_reference_url,
    },
  });
}
