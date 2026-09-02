import { getSupabaseAdmin } from "@/lib/supabase";
import { getSubscriptionInfo } from "@/lib/subscription";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const orderCode = searchParams.get("orderCode");

  // orderCode do chính khách vừa tạo đơn nhận lại (dùng để poll trạng thái thanh toán ngay sau khi
  // bấm nạp) — không cần xác thực userId riêng, mã đơn không đoán được và không lộ gì ngoài status.
  if (orderCode) {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("subscription_orders")
      .select("status")
      .eq("order_code", orderCode)
      .single();

    if (error || !data) {
      return Response.json({ error: "Không tìm thấy đơn hàng" }, { status: 404 });
    }
    return Response.json({ status: data.status });
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }

  const info = await getSubscriptionInfo(userId);
  return Response.json({ active: info.active, expiresAt: info.expiresAt });
}
