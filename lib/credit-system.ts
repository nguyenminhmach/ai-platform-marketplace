import { getSupabaseAdmin } from "@/lib/supabase";

export class InsufficientCreditError extends Error {
  constructor() {
    super("Không đủ credit");
    this.name = "InsufficientCreditError";
  }
}

type DeductResult = { success: boolean; newBalance: number; txId: number | null };

// Trừ credit an toàn — gọi function deduct_credit() trong database (chống race condition, Tập 4 mục 3.2)
export async function deductCredit(
  userId: string,
  amount: number,
  miniAppId: string,
  idempotencyKey: string
): Promise<DeductResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("deduct_credit", {
    p_user_id: userId,
    p_amount: amount,
    p_mini_app_id: miniAppId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) throw error;

  const row = data?.[0];
  return {
    success: row?.success ?? false,
    newBalance: row?.new_balance ?? 0,
    txId: row?.tx_id ?? null,
  };
}

// Hoàn credit khi Mini App chạy lỗi (Tập 4 mục 3.4)
export async function refundCredit(txId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("refund_credit", { p_original_tx_id: txId });
  if (error) throw error;
}

export async function getCreditBalance(userId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("credit_balance")
    .eq("user_id", userId)
    .single();

  if (error) throw error;
  return data?.credit_balance ?? 0;
}
