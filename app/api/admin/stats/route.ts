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
  if (!verifyAdminToken(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();

  const [{ count: userCount }, { data: paidOrders }, { data: usageTx }, { data: recentTx }, { data: recentUsers }] =
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
    ]);

  const totalRevenueVnd = (paidOrders ?? []).reduce((sum, o) => sum + o.amount_vnd, 0);
  const totalCreditsSold = (paidOrders ?? []).reduce((sum, o) => sum + o.credits, 0);
  const totalCreditsUsed = (usageTx ?? []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

  return Response.json({
    userCount: userCount ?? 0,
    totalRevenueVnd,
    totalCreditsSold,
    totalCreditsUsed,
    paidOrderCount: (paidOrders ?? []).length,
    recentTransactions: recentTx ?? [],
    recentUsers: recentUsers ?? [],
  });
}
