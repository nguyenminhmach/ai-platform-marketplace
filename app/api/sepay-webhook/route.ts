// POST /api/sepay-webhook — Sepay gọi vào khi có tiền chuyển vào tài khoản ngân hàng
// Quy tắc: LUÔN trả 200 (kể cả lỗi nội bộ) — Sepay retry nhiều lần nếu nhận non-200,
// gây trùng lặp xử lý. Auth verify bằng timing-safe compare chống timing attack.

import { getSupabaseAdmin } from "@/lib/supabase";
import { parseOrderCodeFromContent, verifySepayAuth, type SepayWebhookPayload } from "@/lib/sepay";

export async function POST(req: Request) {
  try {
    const auth = req.headers.get("authorization");
    if (!verifySepayAuth(auth, process.env.SEPAY_WEBHOOK_API_KEY!)) {
      console.warn("[sepay-webhook] Invalid auth");
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const payload = (await req.json()) as SepayWebhookPayload;
    const supabase = getSupabaseAdmin();

    // Dedup — nếu Sepay gọi lại cùng 1 giao dịch, bỏ qua ngay
    const { error: dedupError } = await supabase
      .from("webhook_dedup")
      .insert({ event_id: payload.id });
    if (dedupError) {
      // Vi phạm unique constraint = đã xử lý rồi
      return Response.json({ success: true, status: "already_processed" });
    }

    // Chỉ xử lý tiền chuyển VÀO (không phải lúc chủ tài khoản chuyển ra)
    if (payload.transferType !== "in") {
      return Response.json({ success: true, status: "outgoing_skipped" });
    }

    // Khớp đơn hàng qua mã DH (nạp credit) hoặc GS (gia hạn thuê bao) trong nội dung chuyển khoản
    const parsed = parseOrderCodeFromContent(payload.content);
    if (!parsed) {
      console.warn(`[sepay-webhook] Không parse được order code từ content="${payload.content}"`);
      return Response.json({ success: true, status: "no_match" });
    }

    if (parsed.type === "subscription") {
      const { data: subOrder, error: subOrderError } = await supabase
        .from("subscription_orders")
        .select("*")
        .eq("order_code", parsed.code)
        .eq("status", "pending")
        .single();

      if (subOrderError || !subOrder) {
        console.warn(`[sepay-webhook] Không tìm thấy đơn gia hạn pending: ${parsed.code}`);
        return Response.json({ success: true, status: "no_match" });
      }

      if (payload.transferAmount < subOrder.amount_vnd) {
        console.error(
          `[sepay-webhook] Thiếu tiền (gia hạn): order=${parsed.code} expected=${subOrder.amount_vnd} got=${payload.transferAmount}`
        );
        return Response.json({ success: true, status: "underpayment" });
      }

      await supabase
        .from("subscription_orders")
        .update({ status: "paid", paid_at: new Date().toISOString(), sepay_transaction_id: payload.id })
        .eq("id", subOrder.id);

      await supabase.rpc("extend_subscription", {
        p_user_id: subOrder.user_id,
        p_duration_days: subOrder.duration_days,
        p_renewal_type: "manual",
      });

      return Response.json({ success: true, orderCode: parsed.code, type: "subscription" });
    }

    const orderCode = parsed.code;
    const { data: order, error: orderError } = await supabase
      .from("topup_orders")
      .select("*")
      .eq("order_code", orderCode)
      .eq("status", "pending")
      .single();

    if (orderError || !order) {
      console.warn(`[sepay-webhook] Không tìm thấy đơn hàng pending: ${orderCode}`);
      return Response.json({ success: true, status: "no_match" });
    }

    // Từ chối thiếu tiền, chấp nhận thừa tiền (khách trả dư vẫn OK)
    if (payload.transferAmount < order.amount_vnd) {
      console.error(
        `[sepay-webhook] Thiếu tiền: order=${orderCode} expected=${order.amount_vnd} got=${payload.transferAmount}`
      );
      return Response.json({ success: true, status: "underpayment" });
    }

    // Đánh dấu đơn hàng đã thanh toán
    await supabase
      .from("topup_orders")
      .update({ status: "paid", paid_at: new Date().toISOString(), sepay_transaction_id: payload.id })
      .eq("id", order.id);

    // Cộng credit cho user — atomic qua function SQL
    await supabase.rpc("credit_topup", {
      p_user_id: order.user_id,
      p_amount: order.credits,
      p_order_code: orderCode,
    });

    return Response.json({ success: true, orderCode, credits: order.credits });
  } catch (err) {
    console.error("[sepay-webhook] Unhandled error:", err);
    // Vẫn trả 200 để Sepay không retry — tránh xử lý trùng lặp
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
