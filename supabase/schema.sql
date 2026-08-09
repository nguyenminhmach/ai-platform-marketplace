-- Schema database cho AI Marketplace (theo thiết kế Tập 4 mục 2.2)
-- Cách dùng: đăng nhập Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

-- Bảng user (mở rộng từ auth.users có sẵn của Supabase)
create table if not exists user_profiles (
  user_id uuid primary key references auth.users(id),
  credit_balance integer not null default 0,
  created_at timestamptz default now()
);

-- Ledger — nguồn sự thật duy nhất về credit, không sửa/xoá, chỉ thêm dòng mới
create table if not exists credit_transactions (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  amount integer not null,
  type text not null check (type in ('topup', 'usage', 'refund', 'bonus')),
  mini_app_id text,
  idempotency_key text unique not null,
  metadata jsonb,
  created_at timestamptz default now()
);

-- Danh mục Mini App
create table if not exists mini_apps (
  id text primary key,
  name text not null,
  description text not null,
  category text not null,
  credit_cost integer not null,
  model_config jsonb,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Log chi tiết mỗi lần chạy
create table if not exists usage_logs (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  credit_transaction_id bigint references credit_transactions(id),
  actual_cost_usd numeric(10,6),
  tokens_used integer,
  status text not null check (status in ('success', 'failed', 'refunded')),
  created_at timestamptz default now()
);

create index if not exists idx_credit_tx_user on credit_transactions(user_id, created_at desc);
create index if not exists idx_usage_logs_user on usage_logs(user_id, created_at desc);

-- Function trừ credit an toàn (chống race condition — Tập 4 mục 3.2)
create or replace function deduct_credit(
  p_user_id uuid,
  p_amount integer,
  p_mini_app_id text,
  p_idempotency_key text
) returns table(success boolean, new_balance integer, tx_id bigint) as $$
declare
  v_current_balance integer;
  v_tx_id bigint;
begin
  select credit_balance into v_current_balance
  from user_profiles
  where user_id = p_user_id
  for update;

  if v_current_balance is null then
    return query select false, 0, null::bigint;
    return;
  end if;

  if v_current_balance < p_amount then
    return query select false, v_current_balance, null::bigint;
    return;
  end if;

  insert into credit_transactions (user_id, amount, type, mini_app_id, idempotency_key)
  values (p_user_id, -p_amount, 'usage', p_mini_app_id, p_idempotency_key)
  returning id into v_tx_id;

  update user_profiles set credit_balance = credit_balance - p_amount
  where user_id = p_user_id;

  return query select true, v_current_balance - p_amount, v_tx_id;
end;
$$ language plpgsql;

-- Function hoàn credit khi Mini App chạy lỗi (Tập 4 mục 3.4)
create or replace function refund_credit(p_original_tx_id bigint) returns void as $$
declare
  v_original credit_transactions%rowtype;
begin
  select * into v_original from credit_transactions where id = p_original_tx_id;

  insert into credit_transactions (user_id, amount, type, mini_app_id, idempotency_key, metadata)
  values (
    v_original.user_id,
    -v_original.amount, -- đảo dấu để hoàn lại đúng số đã trừ
    'refund',
    v_original.mini_app_id,
    v_original.idempotency_key || '-refund',
    jsonb_build_object('original_tx_id', p_original_tx_id)
  );

  update user_profiles set credit_balance = credit_balance - v_original.amount
  where user_id = v_original.user_id;
end;
$$ language plpgsql;

-- Log lỗi nội bộ — nếu việc tặng credit chào mừng gặp sự cố, ghi lại thay vì làm hỏng cả việc đăng ký
create table if not exists debug_log (id bigserial primary key, msg text, created_at timestamptz default now());

-- Trigger: tự tạo user_profiles + tặng 20 credit dùng thử khi có user đăng ký mới (Tập 5 mục 3.2)
-- Bọc trong exception handler để lỗi tặng credit KHÔNG BAO GIỜ chặn việc đăng ký (đăng ký là luồng quan trọng nhất)
create or replace function handle_new_user() returns trigger as $$
begin
  begin
    insert into public.user_profiles (user_id, credit_balance) values (new.id, 20);
    insert into public.credit_transactions (user_id, amount, type, idempotency_key)
    values (new.id, 20, 'bonus', 'welcome-bonus-' || new.id::text);
  exception when others then
    insert into public.debug_log (msg) values ('handle_new_user lỗi cho user ' || new.id::text || ': ' || SQLERRM);
  end;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Dữ liệu Mini App ban đầu (khớp với lib/mock-mini-apps.ts hiện tại)
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  ('viet-mo-ta-san-pham', 'Viết mô tả sản phẩm từ ảnh', 'Tải ảnh sản phẩm lên, AI viết mô tả bán hàng hấp dẫn trong vài giây.', 'anh', 15, '{"model": "anthropic/claude-sonnet-4.6", "max_tokens": 500}'),
  ('tom-tat-van-ban', 'Tóm tắt văn bản', 'Dán văn bản dài, nhận bản tóm tắt ngắn gọn giữ đúng ý chính.', 'van-ban', 5, '{"model": "google/gemini-3-flash-preview", "max_tokens": 500}'),
  ('viet-caption', 'Viết caption Facebook/TikTok', 'Nhập chủ đề, AI viết caption thu hút kèm hashtag phù hợp.', 'van-ban', 8, '{"model": "google/gemini-3-flash-preview", "max_tokens": 300}'),
  ('dich-da-ngon-ngu', 'Dịch đa ngôn ngữ', 'Dịch tự nhiên giữa tiếng Việt và nhiều ngôn ngữ khác, không dịch máy cứng nhắc.', 'van-ban', 6, '{"model": "google/gemini-3-flash-preview", "max_tokens": 500}'),
  ('phan-tich-cam-xuc', 'Phân tích cảm xúc bình luận khách hàng', 'Dán danh sách bình luận, AI phân loại tích cực/tiêu cực và tóm tắt insight.', 'van-ban', 10, '{"model": "anthropic/claude-sonnet-4.6", "max_tokens": 500}')
on conflict (id) do nothing;

-- Row Level Security — deny-all mặc định, chỉ backend (service_role key) mới thao tác được trực tiếp
alter table user_profiles enable row level security;
alter table credit_transactions enable row level security;
alter table usage_logs enable row level security;

alter table mini_apps enable row level security;
create policy "Ai cũng xem được danh mục Mini App" on mini_apps for select using (is_active = true);
