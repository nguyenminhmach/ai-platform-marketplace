// POST /api/prompt-image/webhook — Fal.ai gọi vào khi job sinh ảnh từ prompt bar xử lý xong (thành
// công hoặc lỗi). Đối chiếu bằng jobId (query) + fal_request_id (đã lưu lúc submit) — mirror đúng
// app/api/outfit-swap/webhook/route.ts.

import { getSupabaseAdmin } from "@/lib/supabase";
import { applyPromptImageResult, type PromptImageJobRow } from "@/lib/prompt-image";

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return Response.json({ error: "Thiếu jobId" }, { status: 400 });
    }

    const payload = await req.json();
    const supabase = getSupabaseAdmin();

    const { data: job, error: jobError } = await supabase.from("prompt_image_jobs").select("*").eq("id", jobId).single();

    if (jobError || !job) {
      console.warn(`[prompt-image-webhook] Không tìm thấy job ${jobId}`);
      return Response.json({ success: true, status: "job_not_found" });
    }

    if (payload.request_id && job.fal_request_id && payload.request_id !== job.fal_request_id) {
      console.warn(`[prompt-image-webhook] request_id không khớp cho job ${jobId}`);
      return Response.json({ success: true, status: "request_id_mismatch" });
    }

    if (job.status === "done" || job.status === "failed") {
      // Đã xử lý rồi (Fal.ai có thể gọi lại) — bỏ qua, tránh xử lý trùng
      return Response.json({ success: true, status: "already_processed" });
    }

    await applyPromptImageResult(job as PromptImageJobRow, payload);
    return Response.json({ success: true });
  } catch (err) {
    console.error("[prompt-image-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
