-- Bổ sung cho Bước 6: thanh toán Sepay VietQR nạp credit
-- Chạy đoạn này riêng (không chạy chung với schema.sql cũ) trong SQL Editor

create table if not exists topup_orders (
  id bigserial primary key,
  order_code text unique not null,
  user_id uuid not null references user_profiles(user_id),
  package_id text not null,
  credits integer not null,
  amount_vnd integer not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  sepay_transaction_id bigint,
  created_at timestamptz default now(),
  paid_at timestamptz
);

create index if not exists idx_topup_orders_code on topup_orders(order_code);
create index if not exists idx_topup_orders_status_created on topup_orders(status, created_at);

-- Chống xử lý trùng lặp khi Sepay gọi lại webhook nhiều lần cho cùng 1 giao dịch
create table if not exists webhook_dedup (
  event_id bigint primary key,
  processed_at timestamptz default now()
);

alter table topup_orders enable row level security;
alter table webhook_dedup enable row level security;

-- Cộng credit an toàn khi thanh toán Sepay thành công — cùng nguyên tắc atomic như deduct_credit
create or replace function credit_topup(
  p_user_id uuid,
  p_amount integer,
  p_order_code text
) returns void as $$
begin
  insert into public.credit_transactions (user_id, amount, type, idempotency_key)
  values (p_user_id, p_amount, 'topup', 'topup-' || p_order_code);

  update public.user_profiles set credit_balance = credit_balance + p_amount
  where user_id = p_user_id;
end;
$$ language plpgsql security definer set search_path = public;
