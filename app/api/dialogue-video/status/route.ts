import { getSupabaseAdmin } from "@/lib/supabase";
import { resolveDialogueVideoJob } from "@/lib/dialogue-video";

const STAGE_LABEL: Record<string, string> = {
  pending: "Đang bắt đầu...",
  generating_video: "Đang tạo chuyển động cho 2 nhân vật...",
  generating_audio: "Đang tạo giọng đọc tiếng Việt...",
  lipsyncing: "Đang khớp môi theo lời thoại...",
  stitching: "Đang ghép 2 đoạn lại thành video hoàn chỉnh...",
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return Response.json({ error: "Thiếu jobId" }, { status: 400 });

  await resolveDialogueVideoJob(Number(jobId)).catch(() => {});

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dialogue_video_jobs")
    .select("status, output_url, error_message")
    .eq("id", jobId)
    .single();

  if (error || !data) return Response.json({ error: "Không tìm thấy job" }, { status: 404 });

  return Response.json({
    status: data.status,
    outputUrl: data.output_url,
    errorMessage: data.error_message,
    statusText: STAGE_LABEL[data.status] ?? null,
  });
}
