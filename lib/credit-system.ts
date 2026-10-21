import { getSupabaseAdmin } from "@/lib/supabase";
import { hasActiveSubscription } from "@/lib/subscription";

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

  // Đang có gói không giới hạn còn hạn — bỏ qua trừ credit hoàn toàn, không tạo giao dịch,
  // txId null nên các chỗ gọi refundCredit(deduction.txId) khi lỗi cũng tự động bỏ qua.
  if (await hasActiveSubscription(userId)) {
    const balance = await getCreditBalance(userId);
    return { success: true, newBalance: balance, txId: null };
  }

  const { data, error } = await supabase.rpc("deduct_credit", {
    p_user_id: userId,
    p_amount: amount,
    p_mini_app_id: miniAppId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) throw new Error(error.message);

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
  if (error) {
    // safeRefund() ở lib/story-video.ts đọc err.code để bỏ qua lỗi trùng khoá (23505) khi 2 lượt hoàn
    // credit cùng lúc — giữ nguyên .code trên Error thay vì ném thẳng object Supabase (không phải
    // instance Error thật, khiến `err instanceof Error ? err.message : String(err)` ở nơi khác rơi vào
    // String(err) và ra đúng chuỗi "[object Object]" thay vì message thật).
    const wrapped = new Error(error.message);
    (wrapped as Error & { code?: string }).code = error.code;
    throw wrapped;
  }
}

// SỬA (phản hồi thật user: trang /admin trước đây chỉ HIỂN THỊ số dư credit, không có cách nào cộng
// thêm cho 1 user cụ thể — mọi credit đều phải qua nạp tiền thật) — cấp credit thủ công, dùng type
// "bonus" đã có sẵn (không cần đổi CHECK constraint của credit_transactions), atomic qua RPC
// grant_credit_admin (xem supabase/migration-admin-grant-credit.sql).
export async function grantCreditAdmin(userId: string, amount: number): Promise<void> {
  if (amount <= 0) throw new Error("Số credit phải lớn hơn 0");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("grant_credit_admin", { p_user_id: userId, p_amount: amount });
  if (error) throw new Error(error.message);
}

// SỬA (phản hồi thật user: "thu credit các người này thì làm thế nào" — cần chiều ngược lại của
// grantCreditAdmin) — tái dùng đúng RPC deduct_credit() đã có sẵn (an toàn, chống race condition, tự
// chặn không cho số dư âm — trả success=false thay vì trừ âm), KHÔNG gọi qua hàm deductCredit() ở trên
// vì hàm đó tự bỏ qua việc trừ cho user đang có gói subscription không giới hạn (đúng cho luồng user tự
// dùng app, nhưng SAI cho hành động admin chủ động thu hồi — admin thu thì phải trừ thật bất kể gói gì).
export async function deductCreditAdmin(userId: string, amount: number): Promise<number> {
  if (amount <= 0) throw new Error("Số credit phải lớn hơn 0");
  const supabase = getSupabaseAdmin();
  const { randomUUID } = await import("crypto");
  const { data, error } = await supabase.rpc("deduct_credit", {
    p_user_id: userId,
    p_amount: amount,
    p_mini_app_id: "admin",
    p_idempotency_key: `admin-deduct-${randomUUID()}`,
  });
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row?.success) throw new Error("Số dư không đủ để thu");
  return row.new_balance;
}

export async function getCreditBalance(userId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("credit_balance")
    .eq("user_id", userId)
    .single();

  if (error) throw new Error(error.message);
  return data?.credit_balance ?? 0;
}
