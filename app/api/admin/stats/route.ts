import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!(await verifyAdminToken(token))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();

  const [{ count: userCount }, { data: paidOrders }, { data: usageTx }, { data: recentTx }, { data: recentUsers }, { data: allBalances }] =
    await Promise.all([
      supabase.from("user_profiles").select("*", { count: "exact", head: true }),
      supabase.from("topup_orders").select("amount_vnd, credits").eq("status", "paid"),
      supabase.from("credit_transactions").select("amount").eq("type", "usage"),
      supabase
        .from("credit_transactions")
        .select("id, user_id, amount, type, mini_app_id, created_at")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase.from("user_profiles").select("user_id, credit_balance, created_at").order("created_at", { ascending: false }).limit(20),
      // SỬA (phản hồi thật user: "vậy tổng số credit của app đâu" — "Credit đã bán"/"Credit đã dùng"
      // trước đây chỉ tính từ nạp tiền thật/lượt dùng, KHÔNG gồm credit admin cấp tay (type "bonus") —
      // tổng số dư credit ĐANG CÓ trong mọi tài khoản cộng lại mới là con số thật phản ánh tổng credit
      // hệ thống đang "nợ" user, bất kể nguồn gốc (mua/thưởng/admin cấp). Lấy toàn bộ user_profiles
      // (không giới hạn 20 dòng như recentUsers) rồi cộng dồn ở đây — quy mô nhỏ nên chưa cần SQL SUM()
      // qua RPC riêng.
      supabase.from("user_profiles").select("credit_balance"),
    ]);

  const totalRevenueVnd = (paidOrders ?? []).reduce((sum, o) => sum + o.amount_vnd, 0);
  const totalCreditsSold = (paidOrders ?? []).reduce((sum, o) => sum + o.credits, 0);
  const totalCreditsUsed = (usageTx ?? []).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const totalCreditsOutstanding = (allBalances ?? []).reduce((sum, u) => sum + u.credit_balance, 0);

  return Response.json({
    userCount: userCount ?? 0,
    totalRevenueVnd,
    totalCreditsSold,
    totalCreditsUsed,
    totalCreditsOutstanding,
    paidOrderCount: (paidOrders ?? []).length,
    recentTransactions: recentTx ?? [],
    recentUsers: recentUsers ?? [],
  });
}
