-- Migration: cho phép admin cấp credit thủ công cho 1 user từ trang /admin (trước đây không có cách
-- nào cộng credit ngoài nạp tiền thật qua Sepay). Dùng lại đúng type "bonus" đã có sẵn trong CHECK
-- constraint của credit_transactions (không cần đổi constraint), cùng nguyên tắc atomic như
-- credit_topup/deduct_credit. Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run.

create or replace function grant_credit_admin(
  p_user_id uuid,
  p_amount integer
) returns void as $$
begin
  insert into public.credit_transactions (user_id, amount, type, idempotency_key)
  values (p_user_id, p_amount, 'bonus', 'admin-grant-' || gen_random_uuid()::text);

  update public.user_profiles set credit_balance = credit_balance + p_amount
  where user_id = p_user_id;
end;
$$ language plpgsql security definer set search_path = public;
