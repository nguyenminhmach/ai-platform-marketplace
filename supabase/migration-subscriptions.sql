-- Migration: gói thuê bao "không giới hạn" hàng tháng — Phương án A (gia hạn thủ công qua VietQR)
-- Thiết kế để Phương án B (tự động trừ tiền, làm sau) chỉ CỘNG THÊM vào đây, không sửa lại:
-- extend_subscription() là điểm chung duy nhất cả 2 phương án sẽ gọi để gia hạn.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists subscription_enabled boolean not null default false;
alter table site_settings add column if not exists subscription_price_vnd integer not null default 499000;
alter table site_settings add column if not exists subscription_duration_days integer not null default 30;

-- Trạng thái thuê bao hiện tại của user — không quan tâm tiền đến bằng cách nào (renewal_type chỉ để ghi log)
create table if not exists subscriptions (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  status text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
  renewal_type text not null default 'manual' check (renewal_type in ('manual', 'auto')),
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_subscriptions_user on subscriptions(user_id, created_at desc);

-- Đơn hàng gia hạn qua VietQR — cùng pattern topup_orders, mã đơn dùng tiền tố GS để không trùng DH
create table if not exists subscription_orders (
  id bigserial primary key,
  order_code text unique not null,
  user_id uuid not null references user_profiles(user_id),
  amount_vnd integer not null,
  duration_days integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  sepay_transaction_id bigint,
  created_at timestamptz default now(),
  paid_at timestamptz
);
create index if not exists idx_subscription_orders_code on subscription_orders(order_code);
create index if not exists idx_subscription_orders_status_created on subscription_orders(status, created_at);

alter table subscriptions enable row level security;
alter table subscription_orders enable row level security;

-- Gia hạn thuê bao — nếu đang còn hạn thì cộng dồn thêm ngày, hết hạn rồi thì tính lại từ bây giờ.
-- p_renewal_type ghi lại đến từ đâu (manual = Phương án A hiện tại, auto = Phương án B sau này).
create or replace function extend_subscription(
  p_user_id uuid,
  p_duration_days integer,
  p_renewal_type text default 'manual'
) returns void as $$
declare
  v_current_expiry timestamptz;
  v_new_expiry timestamptz;
begin
  select expires_at into v_current_expiry
  from subscriptions
  where user_id = p_user_id and status = 'active'
  order by expires_at desc
  limit 1;

  if v_current_expiry is not null and v_current_expiry > now() then
    v_new_expiry := v_current_expiry + (p_duration_days || ' days')::interval;
  else
    v_new_expiry := now() + (p_duration_days || ' days')::interval;
  end if;

  insert into subscriptions (user_id, status, renewal_type, expires_at)
  values (p_user_id, 'active', p_renewal_type, v_new_expiry);
end;
$$ language plpgsql security definer set search_path = public;
