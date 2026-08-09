import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveFalJob } from "@/lib/video-jobs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return Response.json({ error: "Thiếu jobId" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("video_jobs")
    .select("status, output_url, error_message")
    .eq("id", jobId)
    .single();

  if (error || !data) {
    return Response.json({ error: "Không tìm thấy job" }, { status: 404 });
  }

  // Nếu vẫn "processing", chủ động hỏi lại Fal.ai (dự phòng khi lỡ miss webhook) trước khi trả kết quả
  if (data.status === "processing") {
    const resolved = await resolveFalJob(Number(jobId));
    return Response.json({
      status: resolved.status,
      outputUrl: resolved.outputUrl,
      errorMessage: null,
    });
  }

  return Response.json({
    status: data.status,
    outputUrl: data.output_url,
    errorMessage: data.error_message,
  });
}
