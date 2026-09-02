import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function GET(req: Request) {
  // userId LUÔN lấy từ session đã xác thực (cookie), KHÔNG tin query param client tự gửi — trước đây
  // ai biết userId người khác cũng xem được sạch số dư + lịch sử giao dịch của họ.
  const userId = await getAuthenticatedUserId();

  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("credit_balance")
    .eq("user_id", userId)
    .single();

  if (profileError) {
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  const { data: transactions, error: txError } = await supabase
    .from("credit_transactions")
    .select("id, amount, type, mini_app_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (txError) {
    return Response.json({ error: txError.message }, { status: 500 });
  }

  return Response.json({
    balance: profile?.credit_balance ?? 0,
    transactions: transactions ?? [],
  });
}
