import { getSupabaseAdmin } from "@/lib/supabase";

// Tự khôi phục job story-video gần nhất còn dở dang khi khách quay lại trang (đóng tab/tắt máy giữa
// chừng) — mirror cơ chế /api/video/latest ở các app video đơn giản, nhưng dùng route riêng vì
// story-video có luồng nhiều bước (Character → ảnh → video) và 2 lượt trừ credit riêng (ảnh/video):
// job "failed" vẫn cần khôi phục nếu ảnh đã tạo xong trước khi lỗi ở bước video sau đó (khác app video
// đơn giản chỉ 1 lượt trừ, hoàn đủ khi lỗi nên bỏ qua hẳn "failed").
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select("id, story_description, character_image_urls, location_reference_url")
    .eq("user_id", userId)
    .neq("status", "done")
    .gte("created_at", oneDayAgo)
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
