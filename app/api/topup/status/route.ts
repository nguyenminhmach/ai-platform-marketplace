import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const orderCode = searchParams.get("orderCode");

  if (!orderCode) {
    return Response.json({ error: "Thiếu orderCode" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("topup_orders")
    .select("status")
    .eq("order_code", orderCode)
    .single();

  if (error || !data) {
    return Response.json({ error: "Không tìm thấy đơn hàng" }, { status: 404 });
  }

  return Response.json({ status: data.status });
}
