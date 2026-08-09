// POST /api/video/webhook — Fal.ai gọi vào khi job tạo video xong (thành công hoặc lỗi).
// Đối chiếu bằng jobId (query) + fal_request_id (đã lưu lúc submit) thay vì chữ ký mật mã —
// Fal.ai có cơ chế ký webhook riêng, cần xác nhận lại định dạng thật khi test trực tiếp.

import { getSupabaseAdmin } from "@/lib/supabase";
import { applyFalResult } from "@/lib/video-jobs";

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return Response.json({ error: "Thiếu jobId" }, { status: 400 });
    }

    const payload = await req.json();
    const supabase = getSupabaseAdmin();

    const { data: job, error: jobError } = await supabase
      .from("video_jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      console.warn(`[video-webhook] Không tìm thấy job ${jobId}`);
      return Response.json({ success: true, status: "job_not_found" });
    }

    // Đối chiếu request_id để giảm rủi ro giả mạo — chỉ chấp nhận webhook khớp đúng job đã submit
    if (payload.request_id && job.fal_request_id && payload.request_id !== job.fal_request_id) {
      console.warn(`[video-webhook] request_id không khớp cho job ${jobId}`);
      return Response.json({ success: true, status: "request_id_mismatch" });
    }

    if (job.status === "done" || job.status === "failed") {
      // Đã xử lý rồi (Fal.ai có thể gọi lại) — bỏ qua, tránh xử lý trùng
      return Response.json({ success: true, status: "already_processed" });
    }

    const finalStatus = await applyFalResult(job, payload);
    return Response.json({ success: true, status: finalStatus });
  } catch (err) {
    console.error("[video-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
