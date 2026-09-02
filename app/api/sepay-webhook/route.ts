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

    // Dedup — nếu Sepay gọi lại cùng 1 giao dịch, bỏ qua ngay. CHỈ coi là "đã xử lý rồi" khi đúng lỗi vi
    // phạm unique constraint (Postgres code 23505) — lỗi khác (DB tạm thời lỗi, payload.id null...) thì
    // CHƯA có gì được ghi/xử lý, trả lỗi thật để Sepay retry lại toàn bộ webhook thay vì âm thầm bỏ qua
    // giao dịch (trước đây coi MỌI lỗi insert là trùng lặp, có thể làm mất tiền khách chuyển vào).
    const { error: dedupError } = await supabase
      .from("webhook_dedup")
      .insert({ event_id: payload.id });
    if (dedupError) {
      if (dedupError.code === "23505") {
        return Response.json({ success: true, status: "already_processed" });
      }
      console.error(`[sepay-webhook] Lỗi ghi dedup (không phải trùng lặp), để Sepay retry:`, dedupError);
      return Response.json({ error: "dedup_insert_failed" }, { status: 500 });
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

      // Gia hạn thuê bao TRƯỚC khi đánh dấu đơn "paid" — nếu RPC lỗi, đơn vẫn ở "pending" (dễ phát
      // hiện + xử lý thủ công) thay vì "paid" nhưng thuê bao không hề được gia hạn mà không ai biết
      // (trước đây không kiểm tra lỗi RPC, đơn đã "paid" + webhook đã dedup thì không cách nào tự
      // retry lại được nữa — tiền mất không dấu vết).
      const { error: extendError } = await supabase.rpc("extend_subscription", {
        p_user_id: subOrder.user_id,
        p_duration_days: subOrder.duration_days,
        p_renewal_type: "manual",
      });
      if (extendError) {
        console.error(`[sepay-webhook] Lỗi gia hạn thuê bao order=${parsed.code} user=${subOrder.user_id}:`, extendError);
        return Response.json({ success: false, error: "extend_subscription_failed", orderCode: parsed.code }, { status: 200 });
      }

      await supabase
        .from("subscription_orders")
        .update({ status: "paid", paid_at: new Date().toISOString(), sepay_transaction_id: payload.id })
        .eq("id", subOrder.id);

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

    // Cộng credit TRƯỚC khi đánh dấu đơn "paid" — cùng lý do với nhánh subscription ở trên: nếu RPC
    // lỗi, đơn vẫn ở "pending" thay vì "paid" mà khách không hề nhận được credit.
    const { error: creditError } = await supabase.rpc("credit_topup", {
      p_user_id: order.user_id,
      p_amount: order.credits,
      p_order_code: orderCode,
    });
    if (creditError) {
      console.error(`[sepay-webhook] Lỗi cộng credit order=${orderCode} user=${order.user_id}:`, creditError);
      return Response.json({ success: false, error: "credit_topup_failed", orderCode }, { status: 200 });
    }

    // Đánh dấu đơn hàng đã thanh toán
    await supabase
      .from("topup_orders")
      .update({ status: "paid", paid_at: new Date().toISOString(), sepay_transaction_id: payload.id })
      .eq("id", order.id);

    return Response.json({ success: true, orderCode, credits: order.credits });
  } catch (err) {
    console.error("[sepay-webhook] Unhandled error:", err);
    // Vẫn trả 200 để Sepay không retry — tránh xử lý trùng lặp
    return Response.json({ success: false, error: String(err) }, { status: 200 });
  }
}
