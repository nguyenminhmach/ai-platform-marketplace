-- Migration: site_settings — cấu hình toàn cục chỉnh được qua /admin, không cần deploy lại
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists site_settings (
  id integer primary key default 1,
  signup_bonus_credits integer not null default 20,
  promo_banner_enabled boolean not null default true,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);

insert into site_settings (id, signup_bonus_credits, promo_banner_enabled)
values (1, 20, true)
on conflict (id) do nothing;

alter table site_settings enable row level security;
drop policy if exists "Ai cũng xem được site settings" on site_settings;
create policy "Ai cũng xem được site settings" on site_settings for select using (true);

-- Cập nhật trigger tặng credit chào mừng: đọc số credit từ site_settings thay vì hardcode 20
create or replace function handle_new_user() returns trigger as $$
declare
  v_bonus integer;
begin
  begin
    select signup_bonus_credits into v_bonus from site_settings where id = 1;
    if v_bonus is null then v_bonus := 20; end if;

    insert into public.user_profiles (user_id, credit_balance) values (new.id, v_bonus);
    insert into public.credit_transactions (user_id, amount, type, idempotency_key)
    values (new.id, v_bonus, 'bonus', 'welcome-bonus-' || new.id::text);
  exception when others then
    insert into public.debug_log (msg) values ('handle_new_user lỗi cho user ' || new.id::text || ': ' || SQLERRM);
  end;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
