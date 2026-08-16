import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveFalJob } from "@/lib/video-jobs";

// Cho phép frontend tự nhận diện job video gần nhất của khách khi họ quay lại trang (đóng tab/tắt
// máy giữa chừng rồi mở lại) — tránh phải chạy lại từ đầu nếu video đã tạo xong hoặc vẫn đang xử lý.
// Chỉ trả về job "pending"/"processing"/"done" — bỏ qua "failed" vì credit đã hoàn, không cần khôi phục.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const miniAppId = searchParams.get("miniAppId");
  if (!userId || !miniAppId) return Response.json({ error: "Thiếu userId hoặc miniAppId" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("video_jobs")
    .select("id, status, output_url, output_url_with_music, input_prompt, start_frame_url")
    .eq("user_id", userId)
    .eq("mini_app_id", miniAppId)
    .in("status", ["pending", "processing", "done"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) return Response.json({ job: null });

  if (job.status === "processing") {
    const resolved = await resolveFalJob(job.id);
    return Response.json({
      job: {
        id: job.id,
        status: resolved.status,
        outputUrl: resolved.outputUrl ?? job.output_url_with_music ?? job.output_url,
        inputPrompt: job.input_prompt,
        startFrameUrl: job.start_frame_url,
      },
    });
  }

  return Response.json({
    job: {
      id: job.id,
      status: job.status,
      outputUrl: job.output_url_with_music ?? job.output_url,
      inputPrompt: job.input_prompt,
      startFrameUrl: job.start_frame_url,
    },
  });
}
