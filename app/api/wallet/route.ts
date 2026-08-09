import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return Response.json({ error: "Thiếu userId" }, { status: 400 });
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
