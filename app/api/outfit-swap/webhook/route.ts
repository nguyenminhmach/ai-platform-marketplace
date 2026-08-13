// POST /api/outfit-swap/webhook — Fal.ai gọi vào khi 1 item (1 bộ trang phục) xử lý xong (thành
// công hoặc lỗi). Đối chiếu bằng itemId (query) + fal_request_id (đã lưu lúc submit) thay vì chữ ký
// mật mã — giống hệt app.api.video.webhook, Fal.ai có cơ chế ký webhook riêng, cần xác nhận lại định
// dạng thật khi test trực tiếp.

import { getSupabaseAdmin } from "@/lib/supabase";
import { applyFalResultToItem } from "@/lib/outfit-swap-jobs";

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const itemId = searchParams.get("itemId");
    if (!itemId) {
      return Response.json({ error: "Thiếu itemId" }, { status: 400 });
    }

    const payload = await req.json();
    const supabase = getSupabaseAdmin();

    const { data: item, error: itemError } = await supabase
      .from("outfit_swap_job_items")
      .select("*")
      .eq("id", itemId)
      .single();

    if (itemError || !item) {
      console.warn(`[outfit-swap-webhook] Không tìm thấy item ${itemId}`);
      return Response.json({ success: true, status: "item_not_found" });
    }

    if (payload.request_id && item.fal_request_id && payload.request_id !== item.fal_request_id) {
      console.warn(`[outfit-swap-webhook] request_id không khớp cho item ${itemId}`);
      return Response.json({ success: true, status: "request_id_mismatch" });
    }

    if (item.status === "done" || item.status === "failed") {
      // Đã xử lý rồi (Fal.ai có thể gọi lại) — bỏ qua, tránh xử lý trùng
      return Response.json({ success: true, status: "already_processed" });
    }

    await applyFalResultToItem(item, payload);
    return Response.json({ success: true });
  } catch (err) {
    console.error("[outfit-swap-webhook] Unhandled error:", err);
    // Vẫn trả 200 để tránh Fal.ai retry gây xử lý trùng — lỗi đã log lại để debug
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
