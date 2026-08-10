-- Migration: gắn cờ ẩn/hiện banner với việc tặng credit chào mừng
-- Khi promo_banner_enabled = false: tài khoản mới không nhận credit tặng (0 credit, không log giao dịch)
-- Khi promo_banner_enabled = true: tặng đúng số signup_bonus_credits hiện tại trong site_settings (chỉnh được qua /admin)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create or replace function handle_new_user() returns trigger as $$
declare
  v_bonus integer;
  v_enabled boolean;
begin
  begin
    select signup_bonus_credits, promo_banner_enabled into v_bonus, v_enabled
    from site_settings where id = 1;

    if v_enabled is null then v_enabled := true; end if;
    if v_bonus is null then v_bonus := 0; end if;
    if not v_enabled then v_bonus := 0; end if;

    insert into public.user_profiles (user_id, credit_balance) values (new.id, v_bonus);

    if v_bonus > 0 then
      insert into public.credit_transactions (user_id, amount, type, idempotency_key)
      values (new.id, v_bonus, 'bonus', 'welcome-bonus-' || new.id::text);
    end if;
  exception when others then
    insert into public.debug_log (msg) values ('handle_new_user lỗi cho user ' || new.id::text || ': ' || SQLERRM);
  end;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
