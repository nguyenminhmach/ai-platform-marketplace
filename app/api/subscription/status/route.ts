import { getSupabaseAdmin } from "@/lib/supabase";
import { getSubscriptionInfo } from "@/lib/subscription";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const orderCode = searchParams.get("orderCode");

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

  if (!userId) {
    return Response.json({ error: "Thiếu userId hoặc orderCode" }, { status: 400 });
  }

  const info = await getSubscriptionInfo(userId);
  return Response.json({ active: info.active, expiresAt: info.expiresAt });
}
