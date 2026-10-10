-- ===== BEGIN supabase/schema.sql =====
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


-- ===== END supabase/schema.sql =====

-- ===== BEGIN supabase/migration-topup-orders.sql =====
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


-- ===== END supabase/migration-topup-orders.sql =====

-- ===== BEGIN supabase/migration-tao-anh-quang-cao.sql =====
-- Migration: thêm Mini App "Tạo ảnh quảng cáo sản phẩm" (Giai đoạn 1 — sinh ảnh qua Fal.ai/Flux Kontext)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'tao-anh-quang-cao',
    'Tạo ảnh quảng cáo sản phẩm',
    'Tải ảnh sản phẩm thật lên (không bắt buộc), mô tả bối cảnh mong muốn, AI tạo ảnh quảng cáo mới giữ đúng sản phẩm.',
    'anh',
    20,
    '{"model": "fal-ai/flux-pro/kontext", "output_type": "image"}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-tao-anh-quang-cao.sql =====

-- ===== BEGIN supabase/migration-site-settings.sql =====
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


-- ===== END supabase/migration-site-settings.sql =====

-- ===== BEGIN supabase/migration-video-jobs.sql =====
-- Migration: hạ tầng cho Mini App tạo video (Giai đoạn 2 — bất đồng bộ qua Fal.ai)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists video_jobs (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  fal_request_id text,
  input_prompt text,
  start_frame_url text,
  end_frame_url text,
  output_url text,
  credit_tx_id bigint references credit_transactions(id),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_video_jobs_user on video_jobs(user_id, created_at desc);
create index if not exists idx_video_jobs_pending on video_jobs(status, created_at) where status in ('pending', 'processing');
create index if not exists idx_video_jobs_fal_request on video_jobs(fal_request_id);

-- RLS deny-all mặc định (giống các bảng khác) — chỉ backend (service_role key) thao tác trực tiếp được
alter table video_jobs enable row level security;

-- Bucket lưu file video kết quả — public đọc (để phát lại được), chỉ service_role mới ghi được (không có policy insert cho anon/authenticated)
insert into storage.buckets (id, name, public)
values ('videos', 'videos', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được video" on storage.objects;
create policy "Ai cũng xem được video" on storage.objects for select using (bucket_id = 'videos');

-- Trigger tự cập nhật updated_at mỗi lần sửa dòng
create or replace function set_video_job_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_video_jobs_updated_at on video_jobs;
create trigger trg_video_jobs_updated_at
  before update on video_jobs
  for each row execute function set_video_job_updated_at();

-- Mini App "Tạo video quảng cáo ngắn" — model Fal.ai cần xác nhận lại ID chính xác khi test thật
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'tao-video-quang-cao',
    'Tạo video quảng cáo ngắn',
    'Mô tả cảnh muốn tạo, có thể thêm ảnh khung hình đầu/cuối, AI tạo video ngắn 4-5 giây.',
    'video',
    400,
    '{"model": "fal-ai/kling-video/v1.6/standard/image-to-video", "output_type": "video"}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-video-jobs.sql =====

-- ===== BEGIN supabase/migration-subscriptions.sql =====
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


-- ===== END supabase/migration-subscriptions.sql =====

-- ===== BEGIN supabase/migration-signup-bonus-toggle.sql =====
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


-- ===== END supabase/migration-signup-bonus-toggle.sql =====

-- ===== BEGIN supabase/migration-media-pricing.sql =====
-- Migration: giá credit ảnh/video tính động theo chi phí thật + biên lợi nhuận tùy chỉnh
-- Công thức: credit_cost = ceil(provider_cost_vnd * (1 + margin%/100) / vnd_per_credit)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists media_margin_percent integer not null default 50;
alter table site_settings add column if not exists vnd_per_credit integer not null default 490;

-- Chi phí thật trả cho Fal.ai (VND) — lấy trực tiếp từ fal.ai/pricing (2026-08-10):
-- Ảnh (Flux Kontext Pro): $0.04/ảnh ≈ 1.000đ
-- Video (Kling 1.6 standard image-to-video): $0.056/giây x 5 giây mặc định ≈ 7.300đ
-- Admin có thể sửa lại khi Fal.ai đổi giá — cập nhật trực tiếp cột model_config qua Supabase.
update mini_apps set model_config = model_config || '{"provider_cost_vnd": 1000}'::jsonb
where id = 'tao-anh-quang-cao';

update mini_apps set model_config = model_config || '{"provider_cost_vnd": 7300}'::jsonb
where id = 'tao-video-quang-cao';


-- ===== END supabase/migration-media-pricing.sql =====

-- ===== BEGIN supabase/migration-developer-platform.sql =====
-- Migration: hạ tầng Giai đoạn 4 — nền tảng cho nhà phát triển bên thứ 3 tạo Mini App
-- Theo đúng thiết kế đã chốt ở tai-lieu-ai-platform/tap-8-kien-truc-nen-tang-nha-phat-trien.md mục 1
-- Chỉ MỞ RỘNG THÊM trên schema Ledger hiện có (user_profiles/credit_transactions/mini_apps/usage_logs),
-- không sửa lại logic cũ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

-- Bảng nhà phát triển
create table if not exists developers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references user_profiles(user_id), -- 1 tài khoản có thể vừa là dev vừa là khách dùng
  display_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  payout_method jsonb, -- thông tin tài khoản ngân hàng nhận tiền
  revenue_share_pct numeric(5,2) not null default 60.00, -- % dev nhận, tuỳ chỉnh theo từng dev
  created_at timestamptz default now()
);

-- Mở rộng mini_apps hiện có — liên kết dev + trạng thái kiểm duyệt + trần chi phí AI/ngày
alter table mini_apps add column if not exists developer_id uuid references developers(id);
alter table mini_apps add column if not exists review_status text not null default 'approved'
  check (review_status in ('draft', 'pending_review', 'approved', 'rejected', 'suspended'));
alter table mini_apps add column if not exists daily_cost_cap_usd numeric(10,2);

-- 7 Mini App hiện có đều do nền tảng tự làm — đánh dấu rõ để phân biệt với app của dev sau này
update mini_apps set review_status = 'approved' where developer_id is null;

-- Sổ cái thu nhập nhà phát triển — cùng nguyên tắc ledger như credit_transactions (không sửa/xoá dòng)
create table if not exists developer_earnings (
  id bigserial primary key,
  developer_id uuid not null references developers(id),
  mini_app_id text not null references mini_apps(id),
  usage_log_id bigint references usage_logs(id), -- tham chiếu đúng lượt chạy sinh ra khoản này
  amount_vnd numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'reversed')),
  payout_batch_id bigint,
  created_at timestamptz default now()
);

-- Đợt chi trả hàng tháng
create table if not exists payout_batches (
  id bigserial primary key,
  developer_id uuid not null references developers(id),
  total_amount_vnd numeric(12,2) not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  paid_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_dev_earnings_dev on developer_earnings(developer_id, status);
create index if not exists idx_mini_apps_dev on mini_apps(developer_id);
create index if not exists idx_mini_apps_review_status on mini_apps(review_status);

-- RLS deny-all mặc định (giống các bảng nội bộ khác) — chỉ backend (service_role key) thao tác trực tiếp được
alter table developers enable row level security;
alter table developer_earnings enable row level security;
alter table payout_batches enable row level security;


-- ===== END supabase/migration-developer-platform.sql =====

-- ===== BEGIN supabase/migration-developer-run.sql =====
-- Migration: cấu hình tỷ giá USD->VND dùng để quy đổi actual_cost_usd dev tự báo cáo
-- (Tập 8 mục 3.3) khi tính hoa hồng — admin chỉnh được, không hardcode.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists usd_to_vnd_rate numeric(10,2) not null default 26000;


-- ===== END supabase/migration-developer-run.sql =====

-- ===== BEGIN supabase/migration-homepage-chips.sql =====
-- Migration: gộp hàng "Mô tả/Tóm tắt/Caption/Dịch/Cảm xúc" và hàng "Tất cả/Ảnh/Văn bản/..."
-- thành 1 hàng chip duy nhất trên trang chủ, thêm chip "Markets" ở cuối, và cho admin
-- sắp xếp thứ tự + xoá bớt chip qua /admin.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists homepage_chips jsonb not null default '[
  {"id": "cat-tat-ca", "type": "category", "label": "Tất cả", "value": "tat-ca"},
  {"id": "cat-anh", "type": "category", "label": "Ảnh", "value": "anh"},
  {"id": "cat-van-ban", "type": "category", "label": "Văn bản", "value": "van-ban"},
  {"id": "cat-video", "type": "category", "label": "Video", "value": "video"},
  {"id": "cat-am-thanh", "type": "category", "label": "Âm thanh", "value": "am-thanh"},
  {"id": "search-mo-ta", "type": "search", "label": "Mô tả", "value": "mô tả sản phẩm"},
  {"id": "search-tom-tat", "type": "search", "label": "Tóm tắt", "value": "tóm tắt văn bản"},
  {"id": "search-caption", "type": "search", "label": "Caption", "value": "caption"},
  {"id": "search-dich", "type": "search", "label": "Dịch", "value": "dịch"},
  {"id": "search-cam-xuc", "type": "search", "label": "Cảm xúc", "value": "cảm xúc"},
  {"id": "link-markets", "type": "link", "label": "Markets", "value": "/markets"}
]'::jsonb;


-- ===== END supabase/migration-homepage-chips.sql =====

-- ===== BEGIN supabase/migration-generation-history.sql =====
-- Migration: lưu lại link ảnh/video đã tạo thành công, để user xem lại (gallery "Lịch sử kết quả")
-- Trước đây link ảnh chỉ trả về cho trình duyệt lúc đó rồi mất, không lưu ở đâu cả.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists generation_history (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  output_type text not null check (output_type in ('image', 'video')),
  output_url text not null,
  created_at timestamptz default now()
);

create index if not exists idx_generation_history_user on generation_history(user_id, created_at desc);

-- RLS deny-all mặc định (giống các bảng nội bộ khác) — chỉ backend (service_role key) thao tác trực tiếp được
alter table generation_history enable row level security;


-- ===== END supabase/migration-generation-history.sql =====

-- ===== BEGIN supabase/migration-outfit-swap.sql =====
-- Migration: thêm Mini App "Thay trang phục cho người mẫu" — ghép 1 ảnh người mẫu với tối đa 10 ảnh
-- trang phục tham chiếu qua Fal.ai Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit).
-- Giá tính động THEO TỪNG ẢNH rồi nhân với số bộ đồ ở lúc chạy (khác các app ảnh khác chỉ tính 1 lần cố định)
-- — credit_cost ở đây chỉ là placeholder hiển thị, giá thật tính trong lib/outfit-swap.ts.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'thay-trang-phuc',
    'Thay trang phục cho người mẫu',
    'Tải 1 ảnh người mẫu + tối đa 10 ảnh trang phục tham chiếu, AI ghép người mẫu mặc thử từng bộ đồ, giữ nguyên khuôn mặt/dáng người/bối cảnh.',
    'anh',
    12,
    '{"model": "fal-ai/gemini-3-pro-image-preview/edit", "output_type": "image", "provider_cost_vnd": 3900}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-outfit-swap.sql =====

-- ===== BEGIN supabase/migration-demo-images.sql =====
-- Bucket lưu ảnh minh hoạ admin upload cho card Mini App trên trang chủ (vd "Thay trang phục").
-- Public đọc (để hiện được trên card), chỉ service_role mới ghi (không có policy insert cho anon/authenticated).
insert into storage.buckets (id, name, public)
values ('demo-images', 'demo-images', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh demo" on storage.objects;
create policy "Ai cũng xem được ảnh demo" on storage.objects for select using (bucket_id = 'demo-images');


-- ===== END supabase/migration-demo-images.sql =====

-- ===== BEGIN supabase/migration-outfit-swap-jobs.sql =====
-- Migration: chuyển "Thay trang phục cho người mẫu" từ đồng bộ (giữ 1 request tới 60s) sang bất
-- đồng bộ (job nền) — theo đúng mô hình video_jobs, tránh bị Vercel giết task giữa chừng làm mất
-- credit không hoàn (đã xảy ra thật, xem migration-video-jobs.sql để so sánh cấu trúc).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

-- 1 hàng = 1 lượt bấm "Chạy ngay" (có thể gồm nhiều bộ trang phục)
create table if not exists outfit_swap_jobs (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  model_image_url text not null,
  prompt text not null,
  total_credit integer not null,
  credit_tx_id bigint references credit_transactions(id),
  status text not null default 'processing' check (status in ('processing', 'done', 'failed')),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 1 hàng = 1 bộ trang phục = 1 lần gọi Fal.ai riêng (model chỉ nhận tối đa 2 ảnh/lần)
create table if not exists outfit_swap_job_items (
  id bigserial primary key,
  job_id bigint not null references outfit_swap_jobs(id) on delete cascade,
  garment_image_url text not null,
  fal_request_id text,
  status text not null default 'processing' check (status in ('processing', 'done', 'failed')),
  output_url text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_outfit_swap_jobs_user on outfit_swap_jobs(user_id, created_at desc);
create index if not exists idx_outfit_swap_jobs_pending on outfit_swap_jobs(status, created_at) where status = 'processing';
create index if not exists idx_outfit_swap_job_items_job on outfit_swap_job_items(job_id);
create index if not exists idx_outfit_swap_job_items_fal_request on outfit_swap_job_items(fal_request_id);

-- RLS deny-all mặc định (giống các bảng khác) — chỉ backend (service_role key) thao tác trực tiếp được
alter table outfit_swap_jobs enable row level security;
alter table outfit_swap_job_items enable row level security;

-- Trigger tự cập nhật updated_at mỗi lần sửa dòng (dùng chung 1 hàm cho cả 2 bảng)
create or replace function set_outfit_swap_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_outfit_swap_jobs_updated_at on outfit_swap_jobs;
create trigger trg_outfit_swap_jobs_updated_at
  before update on outfit_swap_jobs
  for each row execute function set_outfit_swap_updated_at();

drop trigger if exists trg_outfit_swap_job_items_updated_at on outfit_swap_job_items;
create trigger trg_outfit_swap_job_items_updated_at
  before update on outfit_swap_job_items
  for each row execute function set_outfit_swap_updated_at();


-- ===== END supabase/migration-outfit-swap-jobs.sql =====

-- ===== BEGIN supabase/migration-outfit-swap-model-choice.sql =====
-- Migration: cho app "Thay trang phục" chạy song song 2 model (đa năng có prompt + FASHN try-on
-- chuyên biệt), admin bật/tắt từng model qua model_config.models.{generic,fashn}.enabled,
-- người dùng chỉ thấy nút chọn khi cả 2 đều bật (mặc định FASHN).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_jobs add column if not exists model_choice text;


-- ===== END supabase/migration-outfit-swap-model-choice.sql =====

-- ===== BEGIN supabase/migration-outfit-swap-uploads.sql =====
-- Migration: bucket lưu ảnh input (người mẫu + trang phục tham chiếu) cho app "Thay trang phục".
-- Trước đây gửi thẳng base64 trong request chạy AI -> 6-7 ảnh gộp chung dễ vượt giới hạn ~4.5MB/request
-- của Vercel, bị chặn thẳng ở tầng hạ tầng (413), lặp lại liên tục khi user chọn nhiều ảnh trang phục.
-- Nay upload từng ảnh lên Storage TRƯỚC, request chạy AI chỉ còn gửi URL (vài chục byte).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into storage.buckets (id, name, public)
values ('outfit-swap-uploads', 'outfit-swap-uploads', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh input thay trang phục" on storage.objects;
create policy "Ai cũng xem được ảnh input thay trang phục" on storage.objects for select using (bucket_id = 'outfit-swap-uploads');


-- ===== END supabase/migration-outfit-swap-uploads.sql =====

-- ===== BEGIN supabase/migration-outfit-swap-fashn-max.sql =====
-- Migration: thêm model thứ 3 "FASHN Try-On Max" cho app "Thay trang phục" — chất lượng/fidelity
-- cao hơn v1.6, nhưng chạy qua API RIÊNG của FASHN (api.fashn.ai), không qua Fal.ai như 2 model kia,
-- nên cần cột provider để biết dùng cơ chế poll nào khi chốt kết quả (xem lib/outfit-swap-jobs.ts).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_job_items add column if not exists provider text not null default 'fal';


-- ===== END supabase/migration-outfit-swap-fashn-max.sql =====

-- ===== BEGIN supabase/migration-outfit-swap-garment-category.sql =====
-- Migration: cho người dùng tự khai báo "Áo" hay "Cả bộ" cho TỪNG ảnh trang phục tham chiếu, thay vì
-- để FASHN v1.6 tự đoán (category "auto" hay sai khi ảnh tham chiếu là cả bộ áo+quần/váy phối cùng).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_job_items add column if not exists category text not null default 'tops';


-- ===== END supabase/migration-outfit-swap-garment-category.sql =====

-- ===== BEGIN supabase/migration-youtube-connections.sql =====
-- Migration: lưu token OAuth YouTube của từng user để đăng video thẳng từ app lên kênh YouTube của họ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists youtube_connections (
  user_id uuid primary key references user_profiles(user_id),
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  channel_title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS deny-all mặc định (giống các bảng khác) — chỉ backend (service_role key) thao tác trực tiếp được.
-- Token OAuth là dữ liệu nhạy cảm, tuyệt đối không để lộ qua client-side query.
alter table youtube_connections enable row level security;

create or replace function set_youtube_connection_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_youtube_connections_updated_at on youtube_connections;
create trigger trg_youtube_connections_updated_at
  before update on youtube_connections
  for each row execute function set_youtube_connection_updated_at();


-- ===== END supabase/migration-youtube-connections.sql =====

-- ===== BEGIN supabase/migration-background-music.sql =====
-- Migration: thư viện nhạc nền (admin upload sẵn) để ghép vào video AI tạo ra.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists background_music (
  id bigserial primary key,
  name text not null,
  file_url text not null,
  created_at timestamptz default now()
);

alter table background_music enable row level security;

-- Bucket lưu file nhạc admin upload — public đọc (để ffmpeg tải về ghép + phát thử được),
-- chỉ service_role mới ghi (không có policy insert cho anon/authenticated).
insert into storage.buckets (id, name, public)
values ('background-music', 'background-music', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng nghe được nhạc nền" on storage.objects;
create policy "Ai cũng nghe được nhạc nền" on storage.objects for select using (bucket_id = 'background-music');

-- Lưu video đã ghép nhạc riêng, giữ nguyên output_url gốc (video câm) để có thể đổi bài nhạc khác
-- mà không cần tạo lại video từ đầu.
alter table video_jobs add column if not exists output_url_with_music text;
alter table video_jobs add column if not exists music_track_id bigint references background_music(id);


-- ===== END supabase/migration-background-music.sql =====

-- ===== BEGIN supabase/migration-dialogue-video.sql =====
-- Migration: Mini App "Video đồng nhất nhân vật" — 2 nhân vật đối thoại tiếng Việt.
-- Pipeline: (1) mỗi nhân vật -> Kling image-to-video (câm) -> (2) ElevenLabs TTS đọc lời thoại
-- tiếng Việt -> (3) Kling LipSync khớp môi -> (4) ghép 2 clip lại bằng ffmpeg (đã có sẵn từ
-- tính năng ghép nhạc). Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

create table if not exists dialogue_video_jobs (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  status text not null default 'pending' check (
    status in ('pending', 'generating_video', 'generating_audio', 'lipsyncing', 'stitching', 'done', 'failed')
  ),

  a_image_url text not null,
  a_line text not null,
  a_fal_request_id text,
  a_video_url text,
  a_audio_url text,
  a_lipsync_fal_request_id text,
  a_lipsync_url text,

  b_image_url text not null,
  b_line text not null,
  b_fal_request_id text,
  b_video_url text,
  b_audio_url text,
  b_lipsync_fal_request_id text,
  b_lipsync_url text,

  output_url text,
  credit_tx_id bigint references credit_transactions(id),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_dialogue_video_jobs_user on dialogue_video_jobs(user_id, created_at desc);
create index if not exists idx_dialogue_video_jobs_pending on dialogue_video_jobs(status, created_at)
  where status not in ('done', 'failed');

alter table dialogue_video_jobs enable row level security;

create or replace function set_dialogue_video_job_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dialogue_video_jobs_updated_at on dialogue_video_jobs;
create trigger trg_dialogue_video_jobs_updated_at
  before update on dialogue_video_jobs
  for each row execute function set_dialogue_video_job_updated_at();

-- Mini App mới — giá tạm ước tính (2x chi phí video hiện có + TTS không đáng kể + 2x lipsync),
-- admin có thể chỉnh lại provider_cost_vnd sau khi có số liệu thật từ lần chạy đầu tiên.
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'video-doi-thoai-nhan-vat',
    'Video đồng nhất nhân vật',
    'Tải ảnh 2 nhân vật + viết lời thoại cho từng người, AI tạo video 2 người đối thoại bằng tiếng Việt, giữ đúng gương mặt từng người.',
    'video',
    600,
    '{"output_type": "video", "provider_cost_vnd": 16000, "video_model": "fal-ai/kling-video/v1.6/standard/image-to-video", "lipsync_model": "fal-ai/kling-video/lipsync/audio-to-video"}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-dialogue-video.sql =====

-- ===== BEGIN supabase/migration-dialogue-video-multi-character.sql =====
-- Migration: đổi "Video đồng nhất nhân vật" từ cố định 2 nhân vật (A/B) sang tối đa 4 nhân vật —
-- theo đúng mô hình bảng con của outfit_swap_job_items (1 job cha, nhiều item con, mỗi item chạy
-- riêng qua 3 bước: video-gen -> TTS -> lipsync). Tính năng vừa deploy, chưa có job thật nào chạy
-- nên an toàn để đổi cấu trúc thẳng thay vì viết migration giữ dữ liệu cũ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table dialogue_video_jobs drop column if exists a_image_url;
alter table dialogue_video_jobs drop column if exists a_line;
alter table dialogue_video_jobs drop column if exists a_fal_request_id;
alter table dialogue_video_jobs drop column if exists a_video_url;
alter table dialogue_video_jobs drop column if exists a_audio_url;
alter table dialogue_video_jobs drop column if exists a_lipsync_fal_request_id;
alter table dialogue_video_jobs drop column if exists a_lipsync_url;
alter table dialogue_video_jobs drop column if exists b_image_url;
alter table dialogue_video_jobs drop column if exists b_line;
alter table dialogue_video_jobs drop column if exists b_fal_request_id;
alter table dialogue_video_jobs drop column if exists b_video_url;
alter table dialogue_video_jobs drop column if exists b_audio_url;
alter table dialogue_video_jobs drop column if exists b_lipsync_fal_request_id;
alter table dialogue_video_jobs drop column if exists b_lipsync_url;

-- 1 hàng = 1 nhân vật trong 1 job — thứ tự ghép cuối cùng theo "position" (0, 1, 2...)
create table if not exists dialogue_video_characters (
  id bigserial primary key,
  job_id bigint not null references dialogue_video_jobs(id) on delete cascade,
  position integer not null,
  image_url text not null,
  line text not null,
  fal_request_id text,
  video_url text,
  audio_url text,
  lipsync_fal_request_id text,
  lipsync_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_dialogue_video_characters_job on dialogue_video_characters(job_id, position);
create index if not exists idx_dialogue_video_characters_fal_request on dialogue_video_characters(fal_request_id);
create index if not exists idx_dialogue_video_characters_lipsync_fal_request on dialogue_video_characters(lipsync_fal_request_id);

alter table dialogue_video_characters enable row level security;

create or replace function set_dialogue_video_character_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_dialogue_video_characters_updated_at on dialogue_video_characters;
create trigger trg_dialogue_video_characters_updated_at
  before update on dialogue_video_characters
  for each row execute function set_dialogue_video_character_updated_at();

-- Giá cần tăng theo số nhân vật (trước đây cố định cho đúng 2 người) — chuyển sang tính động theo
-- provider_cost_vnd/nhân vật thay vì 1 mức giá chung cho cả job. App tự nhân theo số nhân vật khách
-- chọn ở bước /api/mini-app/[id]/price (xem lib/dialogue-video.ts).
update mini_apps
set model_config = model_config || '{"provider_cost_vnd_per_character": 8000}'::jsonb
where id = 'video-doi-thoai-nhan-vat';


-- ===== END supabase/migration-dialogue-video-multi-character.sql =====

-- ===== BEGIN supabase/migration-motion-transfer.sql =====
-- Migration: app "Nhảy theo video mẫu" — Kling Motion Control (fal-ai/kling-video/v2.6/standard/motion-control),
-- nhận 1 ảnh nhân vật + 1 video mẫu chuyển động, tái dùng bảng video_jobs sẵn có (start_frame_url =
-- ảnh nhân vật, end_frame_url = video mẫu — chỉ khác ý nghĩa, không đổi schema).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into storage.buckets (id, name, public)
values ('motion-transfer-uploads', 'motion-transfer-uploads', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được file input nhảy theo video mẫu" on storage.objects;
create policy "Ai cũng xem được file input nhảy theo video mẫu" on storage.objects for select using (bucket_id = 'motion-transfer-uploads');

-- Video mẫu (tối đa 15MB) vượt xa giới hạn ~4.5MB request body của Vercel nên KHÔNG upload qua API
-- route như các bucket ảnh khác — trình duyệt upload thẳng lên Storage bằng anon key (đã đăng nhập),
-- cần policy insert riêng vì service_role không tham gia bước này.
drop policy if exists "User đã đăng nhập upload được file nhảy theo video mẫu" on storage.objects;
create policy "User đã đăng nhập upload được file nhảy theo video mẫu" on storage.objects for insert to authenticated with check (bucket_id = 'motion-transfer-uploads');

-- provider_cost_vnd tính theo giả định video mẫu tối đa 10s x $0.07/s x 26.000đ/USD — ước lượng
-- giá trần (worst-case), không tính đúng theo độ dài thật vì Fal chỉ tính phí sau khi chạy xong.
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'nhay-theo-video-mau',
    'Nhảy theo video mẫu',
    'Tải 1 ảnh nhân vật + 1 video mẫu chuyển động (tối đa 10 giây), AI cho nhân vật nhảy/chuyển động theo đúng video mẫu.',
    'video',
    56,
    '{"model": "fal-ai/kling-video/v2.6/standard/motion-control", "output_type": "video", "input_mode": "motion-control", "provider_cost_vnd": 18200}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-motion-transfer.sql =====

-- ===== BEGIN supabase/migration-video-truoc-sau.sql =====
-- Migration: app "Video trước/sau" — 2 ảnh bắt buộc (trước + sau), Kling nối chuyển cảnh mượt giữa
-- 2 trạng thái. Tái dùng đúng model + hạ tầng video_jobs của "Tạo video quảng cáo ngắn"
-- (lib/ai-router.ts đã sẵn xử lý cả image_url lẫn tail_image_url cùng lúc, không cần sửa code backend).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'video-truoc-sau',
    'Video trước/sau',
    'Tải ảnh "trước" + ảnh "sau", AI tạo video chuyển cảnh mượt mà từ trạng thái này sang trạng thái kia — phù hợp quảng cáo mỹ phẩm/làm đẹp, video đổi trang phục, unboxing sản phẩm.',
    'video',
    23,
    '{"model": "fal-ai/kling-video/v1.6/standard/image-to-video", "output_type": "video", "provider_cost_vnd": 7300}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-video-truoc-sau.sql =====

-- ===== BEGIN supabase/migration-video-quality-tiers.sql =====
-- Migration: 2 tier chất lượng cho app "Tạo video quảng cáo ngắn" — "basic" (Kling v1.6, giá cố
-- định, không đổi) và "premium" (Kling v2.1 Pro, giá tính theo duration 5s/10s thật). Không cần sửa
-- schema bảng, chỉ cập nhật model_config theo đúng cấu trúc models.{key} đã dùng cho "Thay trang phục".
-- Giá premium quy đổi từ USD thật (fal.ai/models/fal-ai/kling-video/v2.1/pro/image-to-video, tra
-- 2026-08-17): $0.49 (5s) và $0.90 (10s) × 26.000đ/USD.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = (model_config || '{
  "models": {
    "basic": {
      "model": "fal-ai/kling-video/v1.6/standard/image-to-video",
      "provider_cost_vnd": 7300,
      "enabled": true
    },
    "premium": {
      "model": "fal-ai/kling-video/v2.1/pro/image-to-video",
      "provider_cost_vnd_5s": 12740,
      "provider_cost_vnd_10s": 23400,
      "enabled": true
    }
  }
}'::jsonb) - 'provider_cost_vnd'
where id = 'tao-video-quang-cao';

-- Áp dụng y hệt cho "Video trước/sau" — Kling v2.1 Pro cũng nhận tail_image_url (ảnh sau) nên tái
-- dùng đúng 2 tier trên, không cần giá riêng khác.
update mini_apps
set model_config = (model_config || '{
  "models": {
    "basic": {
      "model": "fal-ai/kling-video/v1.6/standard/image-to-video",
      "provider_cost_vnd": 7300,
      "enabled": true
    },
    "premium": {
      "model": "fal-ai/kling-video/v2.1/pro/image-to-video",
      "provider_cost_vnd_5s": 12740,
      "provider_cost_vnd_10s": 23400,
      "enabled": true
    }
  }
}'::jsonb) - 'provider_cost_vnd'
where id = 'video-truoc-sau';


-- ===== END supabase/migration-video-quality-tiers.sql =====

-- ===== BEGIN supabase/migration-video-budget-tier.sql =====
-- Migration: tier thứ 3 "Tiết kiệm" (LTX-2.3 Fast) cho "Tạo video quảng cáo ngắn" và "Video trước/sau"
-- — rẻ hơn cả tier "Cơ bản" (Kling v1.6), video 6s (mặc định model) thay vì ~5s. LTX-2.3 nhận
-- start_image_url/end_image_url (khác tên tham số image_url/tail_image_url của Kling) nên cần đánh
-- dấu param_style: "ltx" để lib/ai-router.ts build đúng body khi gọi Fal.
-- Giá quy đổi từ USD thật (fal.ai/models/fal-ai/ltx-2.3/image-to-video/fast, tra 2026-08-17):
-- $0.04/s (1080p) × 6 giây mặc định × 26.000đ/USD = 6.240đ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{models,budget}',
  '{
    "model": "fal-ai/ltx-2.3/image-to-video/fast",
    "provider_cost_vnd": 6240,
    "enabled": true,
    "param_style": "ltx"
  }'::jsonb
)
where id in ('tao-video-quang-cao', 'video-truoc-sau');


-- ===== END supabase/migration-video-budget-tier.sql =====

-- ===== BEGIN supabase/migration-motion-transfer-tiers.sql =====
-- Migration: 2 tier chất lượng (Cơ bản/Cao cấp) cho "Nhảy theo video mẫu" — tier trước đây chỉ có 1
-- model cố định (Kling v2.6 Standard motion-control), chưa từng so sánh giá với lựa chọn khác.
-- Tier "Cao cấp" giá CỐ ĐỊNH (không theo duration) — độ dài video phụ thuộc video mẫu khách upload,
-- không phải lựa chọn 5s/10s như "Tạo video quảng cáo ngắn".
-- Giá quy đổi từ USD thật (tra 2026-08-17, giả định video mẫu tối đa 10s như trước):
-- - Cơ bản: fal-ai/kling-video/v2.6/standard/motion-control, $0.07/s x 10s x 26.000đ = 18.200đ (giữ nguyên).
-- - Cao cấp: fal-ai/kling-video/v3/pro/motion-control, $0.168/s x 10s x 26.000đ = 43.680đ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = (model_config || '{
  "models": {
    "basic": {
      "model": "fal-ai/kling-video/v2.6/standard/motion-control",
      "provider_cost_vnd": 18200,
      "enabled": true
    },
    "premium": {
      "model": "fal-ai/kling-video/v3/pro/motion-control",
      "provider_cost_vnd": 43680,
      "enabled": true
    }
  }
}'::jsonb) - 'provider_cost_vnd'
where id = 'nhay-theo-video-mau';


-- ===== END supabase/migration-motion-transfer-tiers.sql =====

-- ===== BEGIN supabase/migration-free-trial.sql =====
-- Migration: hạ tầng cho tool dùng thử miễn phí không cần đăng nhập (/thu-mien-phi, "Xoá nền ảnh")
-- — mồi kéo traffic mới, chi phí Fal.ai do platform tự trả (không qua credit khách).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

-- 1 dòng = 1 lượt dùng thử — dùng để giới hạn theo IP/cookie (per-identity) và đếm tổng/ngày (trần
-- chi phí toàn cục). Không lưu ảnh input/output (chỉ là demo tức thời, không cần lịch sử lâu dài).
create table if not exists free_trial_log (
  id bigserial primary key,
  tool text not null,
  ip text,
  cookie_id text,
  created_at timestamptz default now()
);

create index if not exists idx_free_trial_log_tool_time on free_trial_log(tool, created_at);
create index if not exists idx_free_trial_log_ip on free_trial_log(tool, ip, created_at);
create index if not exists idx_free_trial_log_cookie on free_trial_log(tool, cookie_id, created_at);

alter table free_trial_log enable row level security;

-- Trần tổng chi phí/ngày cho toàn bộ tool dùng thử miễn phí — admin chỉnh trong /admin, an toàn
-- tài chính nếu bị lạm dụng hoặc bất ngờ viral. Mặc định 50 lượt/ngày (~23.400đ ở giá Bria RMBG 2.0).
alter table site_settings add column if not exists free_trial_daily_cap integer not null default 50;


-- ===== END supabase/migration-free-trial.sql =====

-- ===== BEGIN supabase/migration-story-video.sql =====
-- Migration: Mini App "Video từ ý tưởng truyện" — 1 ý tưởng truyện + 1 ảnh nhân vật -> AI tự chia
-- 2-5 phân cảnh -> mỗi cảnh tạo 1 ảnh giữ nhân vật (Flux Kontext) -> mỗi cảnh động hoá thành video
-- (Kling v1.6 image-to-video) -> ghép N clip lại thành 1 video hoàn chỉnh bằng ffmpeg (đã có sẵn từ
-- tính năng "Video đồng nhất nhân vật"). 1 job cha + N hàng con (1 hàng/cảnh), xử lý song song, ghép
-- theo "position". Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

create table if not exists story_video_jobs (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  status text not null default 'pending' check (
    status in ('pending', 'splitting_story', 'generating_images', 'generating_videos', 'stitching', 'done', 'failed')
  ),

  story_description text not null,
  num_scenes integer not null check (num_scenes between 2 and 5),
  character_image_url text not null,

  output_url text,
  credit_tx_id bigint references credit_transactions(id),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_story_video_jobs_user on story_video_jobs(user_id, created_at desc);
create index if not exists idx_story_video_jobs_pending on story_video_jobs(status, created_at)
  where status not in ('done', 'failed');

alter table story_video_jobs enable row level security;

create or replace function set_story_video_job_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_story_video_jobs_updated_at on story_video_jobs;
create trigger trg_story_video_jobs_updated_at
  before update on story_video_jobs
  for each row execute function set_story_video_job_updated_at();

-- 1 hàng = 1 phân cảnh trong 1 job — thứ tự ghép cuối cùng theo "position" (0, 1, 2...). Cùng 1 hàng
-- mang cả kết quả bước ảnh (stage "image") lẫn bước video (stage "video") vì bước 2 dùng chính ảnh
-- của bước 1 làm đầu vào, không phải 2 bảng con tách rời như dialogue_video_characters.
create table if not exists story_video_scenes (
  id bigserial primary key,
  job_id bigint not null references story_video_jobs(id) on delete cascade,
  position integer not null,
  scene_description text,
  image_fal_request_id text,
  image_url text,
  video_fal_request_id text,
  video_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_story_video_scenes_job on story_video_scenes(job_id, position);
create index if not exists idx_story_video_scenes_image_fal_request on story_video_scenes(image_fal_request_id);
create index if not exists idx_story_video_scenes_video_fal_request on story_video_scenes(video_fal_request_id);

alter table story_video_scenes enable row level security;

create or replace function set_story_video_scene_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_story_video_scenes_updated_at on story_video_scenes;
create trigger trg_story_video_scenes_updated_at
  before update on story_video_scenes
  for each row execute function set_story_video_scene_updated_at();

-- Giá tăng theo số phân cảnh khách chọn (2-5 cảnh) — mỗi cảnh tốn 1 lần gọi ảnh (Flux Kontext, giá
-- tham khảo từ app "Tạo ảnh quảng cáo sản phẩm") + 1 lần gọi video (Kling v1.6 standard 5s, giá tham
-- khảo từ app "Video trước/sau"). Admin chỉnh lại provider_cost_vnd_per_scene_* sau khi có số liệu
-- thật từ lần chạy đầu tiên.
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'video-tu-y-tuong',
    'Video từ ý tưởng truyện',
    'Nhập ý tưởng truyện + tải 1 ảnh nhân vật, AI tự chia thành nhiều phân cảnh, tạo ảnh giữ đúng nhân vật cho từng cảnh rồi động hoá thành 1 video hoàn chỉnh.',
    'video',
    900,
    '{"output_type": "video", "image_model": "fal-ai/flux-pro/kontext", "video_model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd_per_scene_image": 1000, "provider_cost_vnd_per_scene_video": 7300}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  model_config = excluded.model_config,
  is_active = true;


-- ===== END supabase/migration-story-video.sql =====

-- ===== BEGIN supabase/migration-story-video-staged.sql =====
-- Migration: chia "Video từ ý tưởng truyện" thành 2 nấc, đúng cách Genful làm — mặc định chỉ chạy
-- "chia phân cảnh + tạo ảnh" (rẻ), dừng lại cho khách xem trước, khách ưng mới bấm tiếp "Tạo video"
-- (đắt hơn nhiều). Có tuỳ chọn "tự động tạo video luôn" để gộp 1 lượt như trước (autoVideo=true).
-- App chưa có job thật nào chạy nên an toàn đổi thẳng cấu trúc cột. Cách dùng: Supabase Dashboard ->
-- SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists auto_video boolean not null default false;

-- Tách 1 khoản credit_tx_id thành 2 khoản riêng: trừ ảnh lúc submit, trừ video lúc bấm "Tạo video"
-- (hoặc cùng lúc nếu auto_video=true) — cho phép hoàn tiền đúng phần nếu chỉ 1 trong 2 bước lỗi.
alter table story_video_jobs rename column credit_tx_id to image_credit_tx_id;
alter table story_video_jobs add column if not exists video_credit_tx_id bigint references credit_transactions(id);

-- Snapshot giá vốn/cảnh (VND) của model đã chọn lúc submit — dùng để tính lại giá tạo video ở bước
-- 2 (có thể diễn ra rất lâu sau bước 1) mà không phụ thuộc catalog admin có sửa/tắt entry đó chưa.
alter table story_video_jobs add column if not exists image_provider_cost_vnd_per_scene numeric;
alter table story_video_jobs add column if not exists video_provider_cost_vnd_per_scene numeric;

alter table story_video_jobs drop constraint if exists story_video_jobs_status_check;
alter table story_video_jobs add constraint story_video_jobs_status_check check (
  status in ('pending', 'splitting_story', 'generating_images', 'images_ready', 'generating_videos', 'stitching', 'done', 'failed')
);


-- ===== END supabase/migration-story-video-staged.sql =====

-- ===== BEGIN supabase/migration-story-video-catalog.sql =====
-- Migration: nâng "Video từ ý tưởng truyện" từ 1 model cố định + 1 ảnh nhân vật lên catalog nhiều
-- nhà cung cấp (giống Genful) + tối đa 3 ảnh nhân vật + tối đa 8 phân cảnh. App chưa có job thật nào
-- chạy nên an toàn để đổi thẳng cấu trúc cột, không cần giữ dữ liệu cũ (cùng tiền lệ
-- migration-dialogue-video-multi-character.sql). Cách dùng: Supabase Dashboard -> SQL Editor -> dán
-- toàn bộ -> Run.

alter table story_video_jobs drop column if exists character_image_url;
alter table story_video_jobs add column if not exists character_image_urls text[] not null default '{}';
alter table story_video_jobs alter column character_image_urls drop default;

-- Snapshot model Fal.ai thật đã dùng lúc submit (không tra lại model_config mỗi lần cần, vì admin có
-- thể sửa/tắt catalog giữa lúc job đang chạy — bước poll fallback phải dùng đúng model đã submit).
alter table story_video_jobs add column if not exists image_model text;
alter table story_video_jobs add column if not exists video_model text;

alter table story_video_jobs drop constraint if exists story_video_jobs_num_scenes_check;
alter table story_video_jobs add constraint story_video_jobs_num_scenes_check check (num_scenes between 2 and 8);

-- Catalog nhiều nhà cung cấp cho model ảnh/video — thay thế 2 field cố định "image_model"/"video_model"
-- cũ. Mỗi entry: key (định danh nội bộ), provider (nhóm hiển thị dropdown), label, model (Fal.ai model
-- id thật), provider_cost_vnd (giá vốn/cảnh), multi_image (model có nhận nhiều ảnh tham chiếu cùng lúc
-- không — quyết định gửi "image_url" hay "image_urls" khi gọi Fal.ai), enabled.
update mini_apps
set model_config = (model_config - 'image_model' - 'video_model' - 'provider_cost_vnd_per_scene_image' - 'provider_cost_vnd_per_scene_video') || '{
  "image_models": [
    {"key": "flux-kontext", "provider": "BFL", "label": "Flux Kontext", "model": "fal-ai/flux-pro/kontext", "provider_cost_vnd": 1000, "multi_image": false, "enabled": true},
    {"key": "nano-banana-pro", "provider": "GOOGLE", "label": "Nano Banana Pro Edit", "model": "fal-ai/gemini-3-pro-image-preview/edit", "provider_cost_vnd": 1800, "multi_image": true, "enabled": true}
  ],
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-catalog.sql =====

-- ===== BEGIN supabase/migration-story-video-expand-catalog.sql =====
-- Migration: mở rộng catalog "Video từ ý tưởng truyện" — sửa giá Nano Banana Pro đang bán DƯỚI giá
-- vốn (1.800đ trong khi giá thật fal.ai là ~3.900đ/ảnh), thêm model GPT Image 2 (ảnh), VEO 3.1 +
-- MiniMax Hailuo 02 (video), thêm tỉ lệ khung hình + độ phân giải/thời lượng có giá riêng cho model
-- nào có dữ liệu giá thật (không bịa số cho model không có). Giá đã tra trực tiếp fal.ai/models trước
-- khi thêm — xem ghi chú nguồn trong plan. Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

alter table story_video_jobs add column if not exists aspect_ratio text;
alter table story_video_jobs add column if not exists image_resolution_key text;
alter table story_video_jobs add column if not exists video_duration_key text;

update mini_apps
set model_config = model_config || '{
  "image_models": [
    {"key": "flux-kontext", "provider": "BFL", "label": "Flux Kontext", "model": "fal-ai/flux-pro/kontext", "provider_cost_vnd": 1000, "multi_image": false, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "nano-banana-pro", "provider": "GOOGLE", "label": "Nano Banana Pro Edit", "model": "fal-ai/gemini-3-pro-image-preview/edit", "provider_cost_vnd": 3900, "multi_image": true, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "resolution_price_vnd": {"1K": 3900, "4K": 7800}},
    {"key": "gpt-image-2", "provider": "OPENAI", "label": "GPT Image 2 Edit", "model": "fal-ai/gpt-image-2/edit", "provider_cost_vnd": 5700, "multi_image": true, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]}
  ],
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"6": 6240, "10": 10400}},
    {"key": "veo3", "provider": "GOOGLE_VEO", "label": "VEO 3.1", "model": "fal-ai/veo3/image-to-video", "provider_cost_vnd": 31200, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 20800, "6": 31200, "8": 41600}},
    {"key": "hailuo-02", "provider": "HAILUOAI", "label": "MiniMax Hailuo 02", "model": "fal-ai/minimax/hailuo-02/standard/image-to-video", "provider_cost_vnd": 7020, "enabled": true, "duration_price_vnd": {"6": 7020, "10": 11700}}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-expand-catalog.sql =====

-- ===== BEGIN supabase/migration-story-video-gpt-image2-resolution.sql =====
-- Migration: thêm "Độ phân giải" cho GPT Image 2 Edit — model này CÓ giá thật khác nhau theo độ
-- phân giải (đã kiểm tra fal.ai/models/fal-ai/gpt-image-2/edit: 1024px cao ~$0.219, 4K ~$0.413), nên
-- thêm được (khác Flux Kontext — đã kiểm tra fal.ai/models/fal-ai/flux-pro/kontext không có giá theo
-- resolution, giữ nguyên giá cố định, không thêm dropdown giả). Cách dùng: Supabase Dashboard -> SQL
-- Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{image_models}',
  (
    select jsonb_agg(
      case when entry->>'key' = 'gpt-image-2'
        then entry || '{"resolution_price_vnd": {"1024": 5700, "4K": 10700}}'::jsonb
        else entry
      end
    )
    from jsonb_array_elements(model_config->'image_models') as entry
  )
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-gpt-image2-resolution.sql =====

-- ===== BEGIN supabase/migration-story-video-character-step.sql =====
-- Migration: thêm bước "Tạo Character" (chạy TRƯỚC bước chia cảnh) cho "Video từ ý tưởng truyện" —
-- ảnh nhân vật khách tải lên (thường chụp góc lẻ, ánh sáng/nền lộn xộn) được chuyển thành 1 ảnh
-- Character sheet chuẩn (nhiều góc, ánh sáng đều, giữ nguyên khuôn mặt/trang phục) TRƯỚC khi dùng làm
-- tham chiếu cho từng cảnh — thay vì dùng thẳng ảnh gốc lộn xộn cho cả N lần gọi model ảnh như trước.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists character_sheet_url text;
alter table story_video_jobs add column if not exists character_credit_tx_id bigint references credit_transactions(id);
alter table story_video_jobs add column if not exists character_fal_request_id text;
-- 'generated' (gọi GPT Image 2 tạo mới) | 'uploaded_sheet' (AI phân loại ảnh khách tải lên đã là
-- sheet nhiều góc, dùng thẳng không tốn credit) | 'reused' (chọn từ thư viện Character đã lưu).
alter table story_video_jobs add column if not exists character_source text;

alter table story_video_jobs drop constraint if exists story_video_jobs_status_check;
alter table story_video_jobs add constraint story_video_jobs_status_check check (
  status in (
    'pending', 'generating_character', 'character_ready',
    'splitting_story', 'generating_images', 'images_ready',
    'generating_videos', 'stitching', 'done', 'failed'
  )
);

create index if not exists idx_story_video_jobs_character_fal_request on story_video_jobs(character_fal_request_id);

-- Thư viện Character tái sử dụng — khách lưu lại 1 Character sheet đã ưng ý để dùng cho video sau
-- (không cần tải ảnh + tốn credit tạo Character lại từ đầu mỗi lần).
create table if not exists story_characters (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  image_url text not null,
  label text,
  created_at timestamptz default now()
);

create index if not exists idx_story_characters_user on story_characters(user_id, created_at desc);

alter table story_characters enable row level security;


-- ===== END supabase/migration-story-video-character-step.sql =====

-- ===== BEGIN supabase/migration-story-video-min-scenes-1.sql =====
-- MIN_SCENES ở code (lib/story-video.ts) đã hạ xuống 1 từ trước, nhưng constraint DB vẫn còn giữ
-- "between 2 and 8" (từ migration-story-video-catalog.sql) — chưa cập nhật theo, nên submit job với
-- đúng 1 phân cảnh bị Postgres chặn ở tầng DB (lỗi "violates check constraint
-- story_video_jobs_num_scenes_check"), dù validate ở code đã cho phép.
alter table story_video_jobs drop constraint if exists story_video_jobs_num_scenes_check;
alter table story_video_jobs add constraint story_video_jobs_num_scenes_check check (num_scenes between 1 and 8);


-- ===== END supabase/migration-story-video-min-scenes-1.sql =====

-- ===== BEGIN supabase/migration-story-video-character-angles.sql =====
-- Migration: cắt Character sheet (6 góc gộp 1 ảnh) thành 6 ảnh riêng ngay sau khi AI vẽ xong, để
-- Reference Selector (bước sau) chọn đúng ảnh góc cần cho từng cảnh thay vì luôn gửi cả tấm gộp.
-- Chỉ áp dụng cho sheet do CHÍNH APP tự vẽ ra (character_source = 'generated') — bố cục 6 ô luôn cố
-- định theo đúng prompt của mình nên cắt bằng toạ độ cố định an toàn. Sheet khách tự tải lên
-- (uploaded_sheet) KHÔNG cắt vì không đảm bảo đúng bố cục 3x2 này.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

insert into storage.buckets (id, name, public)
values ('story-video-character-angles', 'story-video-character-angles', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh góc Character đã cắt" on storage.objects;
create policy "Ai cũng xem được ảnh góc Character đã cắt" on storage.objects for select using (bucket_id = 'story-video-character-angles');

-- JSON dạng {"front": "...", "three_quarter_left": "...", "three_quarter_right": "...", "side": "...",
-- "back": "...", "face": "..."} — null nếu sheet chưa/không cắt được (uploaded_sheet, skipped, lỗi cắt).
alter table story_video_jobs add column if not exists character_angle_urls jsonb;
alter table story_characters add column if not exists angle_urls jsonb;


-- ===== END supabase/migration-story-video-character-angles.sql =====

-- ===== BEGIN supabase/migration-story-video-scene-camera-view.sql =====
-- Migration: thêm cột camera_view cho mỗi phân cảnh — Agent chia cảnh giờ trả thêm góc quay cần dùng
-- (front/3-4 trái/3-4 phải/nghiêng/sau lưng/cận mặt) cho từng cảnh, để bước sau (Reference Selector)
-- tra bảng chọn đúng ảnh góc đã cắt sẵn (xem migration-story-video-character-angles.sql) thay vì luôn
-- gửi cả tấm Character sheet gộp cho mọi cảnh như hiện tại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists camera_view text;


-- ===== END supabase/migration-story-video-scene-camera-view.sql =====

-- ===== BEGIN supabase/migration-story-video-outfit-override.sql =====
-- Migration: thêm cột outfit_override cho mỗi phân cảnh — Bước 6 (Tầng Appearance của
-- Character Profile 3 tầng: Identity/Appearance/Scene). Agent chia cảnh CHỈ điền cột này
-- khi ý tưởng truyện nói rõ có đổi trang phục (vd "mặc đồ ngủ ở nhà, sau đó ra ngoài khoác
-- áo len") — cảnh nào không đổi đồ thì để null như bình thường.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists outfit_override text;


-- ===== END supabase/migration-story-video-outfit-override.sql =====

-- ===== BEGIN supabase/migration-story-video-face-view.sql =====
-- Migration: thêm cột face_view cho mỗi phân cảnh — thử nghiệm Priority 3 (tách hướng mặt/ánh nhìn
-- khỏi hướng thân người). Agent chia cảnh CHỈ điền cột này khi ý tưởng truyện nói rõ 2 hướng khác
-- nhau (vd "thân quay sang phải nhưng mắt vẫn nhìn thẳng camera") — cảnh bình thường (mặt cùng hướng
-- thân) thì để null như trước.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists face_view text;


-- ===== END supabase/migration-story-video-face-view.sql =====

-- ===== BEGIN supabase/migration-story-video-genre.sql =====
-- Migration: thêm cột genre_key cho story_video_jobs — khách chọn thể loại (Tình cảm/Hài hước/Kinh
-- dị/Khoa học viễn tưởng/Đời thường/Bí ẩn) ở khối "Agent xử lý", chỉ là 1 khoá tra bảng CỐ ĐỊNH trong
-- code (xem GENRE_STYLE_GUIDES trong lib/story-video.ts) — không lưu tự do, không phải AI tự quyết.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists genre_key text;


-- ===== END supabase/migration-story-video-genre.sql =====

-- ===== BEGIN supabase/migration-story-video-motion-prompt.sql =====
-- Migration: thêm cột motion_prompt cho story_video_scenes — lưu mô tả CHUYỂN ĐỘNG riêng cho bước
-- tạo VIDEO (khác scene_description vốn là mô tả ẢNH tĩnh do Agent chia cảnh viết). Sinh 1 lần lúc
-- chuẩn bị submit video (proceedToVideoStage trong lib/story-video.ts), tái dùng lại khi khách bấm
-- "Tạo lại" video 1 cảnh (regenerateSceneVideo) — không gọi lại AI viết chuyển động mỗi lần tạo lại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists motion_prompt text;


-- ===== END supabase/migration-story-video-motion-prompt.sql =====

-- ===== BEGIN supabase/migration-story-video-multi-character.sql =====
-- Migration: hỗ trợ NHIỀU nhân vật cùng xuất hiện chung 1 khung hình cho "Video từ ý tưởng truyện"
-- (vd video tuần trăng mật, cầu hôn — 2 người cần cùng có mặt trong ảnh, khác app "dialogue-video"
-- vốn quay riêng từng người). Bảng mới CHỈ dùng khi job có từ 2 nhân vật trở lên — job 1 nhân vật vẫn
-- dùng nguyên các cột cũ trên story_video_jobs (character_sheet_url/character_angle_urls/...), không
-- đụng job cũ, không cần migrate dữ liệu.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

create table if not exists story_video_job_characters (
  id bigserial primary key,
  job_id bigint not null references story_video_jobs(id) on delete cascade,
  position integer not null,
  label text,
  source_image_urls text[] not null default '{}',
  story_character_id bigint references story_characters(id),
  character_sheet_url text,
  character_angle_urls jsonb,
  character_source text,
  character_fal_request_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_story_video_job_characters_job on story_video_job_characters(job_id, position);

alter table story_video_scenes add column if not exists character_positions integer[];


-- ===== END supabase/migration-story-video-multi-character.sql =====

-- ===== BEGIN supabase/migration-story-video-location-reference.sql =====
-- Migration: cho phép khách đưa 1 ảnh THẬT của địa điểm (sân vườn, nhà, cửa hàng...) lên, để ảnh
-- phân cảnh AI tạo ra diễn ra đúng tại khung cảnh thật đó thay vì AI tự bịa bối cảnh chung chung.
-- 1 job chỉ có 1 ảnh địa điểm (dùng chung cho mọi cảnh), tuỳ chọn — không dùng thì hành vi giữ nguyên
-- như trước (AI tự vẽ bối cảnh theo mô tả truyện).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists location_reference_url text;


-- ===== END supabase/migration-story-video-location-reference.sql =====

-- ===== BEGIN supabase/migration-story-video-veo31-fast-lite.sql =====
-- Migration: thêm VEO 3.1 Fast + VEO 3.1 Lite làm lựa chọn "Tiết kiệm hơn" cho Video phân cảnh —
-- rẻ hơn 50-85% so với VEO 3.1 hiện tại ($0.10/s và $0.03-0.08/s so với $0.20/s). Giá tra trực tiếp
-- fal.ai/models/fal-ai/veo3.1/fast/image-to-video và .../lite/image-to-video trước khi thêm. Cùng
-- schema request với "veo3" gốc (buildVideoRequestBody trong lib/story-video.ts đã mở rộng match model
-- này) — quy đổi giá theo mức KHÔNG tiếng (generate_audio: false), 720p mặc định cho Lite (mức rẻ nhất
-- $0.03/s), 720p/1080p đồng giá $0.10/s cho Fast. Tỉ giá 26.000đ/USD (đồng bộ các model VEO khác).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

update mini_apps
set model_config = model_config || '{
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"6": 6240, "10": 10400}},
    {"key": "veo3", "provider": "GOOGLE_VEO", "label": "VEO 3.1", "model": "fal-ai/veo3/image-to-video", "provider_cost_vnd": 31200, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 20800, "6": 31200, "8": 41600}},
    {"key": "veo31-fast", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Fast", "model": "fal-ai/veo3.1/fast/image-to-video", "provider_cost_vnd": 15600, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 10400, "6": 15600, "8": 20800}},
    {"key": "veo31-lite", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Lite", "model": "fal-ai/veo3.1/lite/image-to-video", "provider_cost_vnd": 4680, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 3120, "6": 4680, "8": 6240}},
    {"key": "hailuo-02", "provider": "HAILUOAI", "label": "MiniMax Hailuo 02", "model": "fal-ai/minimax/hailuo-02/standard/image-to-video", "provider_cost_vnd": 7020, "enabled": true, "duration_price_vnd": {"6": 7020, "10": 11700}}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-veo31-fast-lite.sql =====

-- ===== BEGIN supabase/migration-mini-apps-display-order.sql =====
-- Migration: thêm cột display_order cho mini_apps — cho admin tự sắp xếp thứ tự hiện trên trang chủ
-- (số nhỏ hơn hiện trước) thay vì cố định theo thứ tự khai báo trong lib/mock-mini-apps.ts. Backfill
-- đúng thứ tự HIỆN TẠI của 12 app tĩnh (cách nhau 10 để admin còn chỗ chèn app mới vào giữa), app khác
-- (app admin tự thêm/app dev) giữ mặc định 9999 để vẫn hiện sau như hành vi cũ, không đổi gì cho tới
-- khi admin chủ động sửa số thứ tự.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

alter table mini_apps add column if not exists display_order integer not null default 9999;

update mini_apps set display_order = 10 where id = 'viet-mo-ta-san-pham';
update mini_apps set display_order = 20 where id = 'tom-tat-van-ban';
update mini_apps set display_order = 30 where id = 'viet-caption';
update mini_apps set display_order = 40 where id = 'dich-da-ngon-ngu';
update mini_apps set display_order = 50 where id = 'tao-anh-quang-cao';
update mini_apps set display_order = 60 where id = 'tao-video-quang-cao';
update mini_apps set display_order = 70 where id = 'video-truoc-sau';
update mini_apps set display_order = 80 where id = 'nhay-theo-video-mau';
update mini_apps set display_order = 90 where id = 'video-doi-thoai-nhan-vat';
update mini_apps set display_order = 100 where id = 'video-tu-y-tuong';
update mini_apps set display_order = 110 where id = 'thay-trang-phuc';
update mini_apps set display_order = 120 where id = 'phan-tich-cam-xuc';


-- ===== END supabase/migration-mini-apps-display-order.sql =====

-- ===== BEGIN supabase/migration-story-video-dialogue.sql =====
-- Migration: lời thoại có giọng nói cho từng cảnh của "Video từ ý tưởng truyện".
-- Tái dùng đúng pipeline đã chạy tốt trong dialogue_video: Kling image-to-video (câm, đã có sẵn)
-- -> ElevenLabs TTS -> Kling LipSync (fal-ai/kling-video/lipsync/audio-to-video) khớp môi.
-- Chỉ áp dụng cho cảnh có ĐÚNG 1 nhân vật trong khung hình (xem plan để biết lý do giới hạn).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists dialogue_line text;
alter table story_video_scenes add column if not exists dialogue_speaker_position integer;
alter table story_video_scenes add column if not exists dialogue_audio_url text;
alter table story_video_scenes add column if not exists lipsync_fal_request_id text;
alter table story_video_scenes add column if not exists lipsync_url text;

alter table story_video_jobs add column if not exists lipsync_credit_tx_id bigint references credit_transactions(id);

-- lipsync_provider_cost_vnd là số ước tính ban đầu (VND/cảnh có thoại) — admin chỉnh lại sau khi có
-- số liệu thật, hiện trong bảng "Chi phí Fal.ai thật" (app/api/admin/story-video-costs/route.ts).
update mini_apps
set model_config = model_config || '{"lipsync_model": "fal-ai/kling-video/lipsync/audio-to-video", "lipsync_provider_cost_vnd": 9000}'::jsonb
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-dialogue.sql =====

-- ===== BEGIN supabase/migration-story-video-continuous-motion.sql =====
-- Migration: chuyển động liên tục giữa các cảnh (Kling O1 First-Last-Frame-to-Video) cho
-- "Video từ ý tưởng truyện" — mỗi cảnh có thêm 1 "ảnh cuối" (end_image_url), ảnh cuối cảnh N chính là
-- ảnh đầu cảnh N+1 (chuỗi N+1 ảnh cho N cảnh, không phải 2N) — xem plan để biết chi tiết thiết kế.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists end_image_url text;
alter table story_video_scenes add column if not exists end_image_fal_request_id text;
alter table story_video_jobs add column if not exists continuous_motion boolean not null default false;

-- provider_cost_vnd = $0.084/s x 5s x 26.000đ/USD (mức duration mặc định 5s ở v1, model hỗ trợ
-- "3"-"10" nhưng chỉ expose 1 mức để giữ đơn giản).
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "kling-o1-flfv", "provider": "KLING", "label": "Kling O1 (chuyển động liên tục)", "model": "fal-ai/kling-video/o1/standard/image-to-video", "provider_cost_vnd": 10920, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"5": 10920}}]'::jsonb
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-continuous-motion.sql =====

-- ===== BEGIN supabase/migration-story-video-scene-state.sql =====
-- Scene State: nối tiếp bối cảnh/tư thế giữa các cảnh cho "Video từ ý tưởng truyện" (luồng mặc định,
-- không bật chuyển động liên tục). Xem plan để biết chi tiết thiết kế.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists location text;
alter table story_video_scenes add column if not exists end_pose text;


-- ===== END supabase/migration-story-video-scene-state.sql =====

-- ===== BEGIN supabase/migration-story-video-veo31-lite-flf.sql =====
-- Migration: thêm VEO 3.1 Lite (First-Last-Frame-to-Video) làm lựa chọn "Chuyển động liên tục" thứ 2
-- cho "Video từ ý tưởng truyện" — bên cạnh Kling O1 đã có. Đây là model Fal.ai RIÊNG (khác hẳn model
-- "VEO 3.1 Lite" thường .../image-to-video đã có trong catalog, chỉ nhận 1 ảnh): endpoint
-- fal-ai/veo3.1/lite/first-last-frame-to-video nhận "first_frame_url" + "last_frame_url" — đúng cơ chế
-- ảnh cuối cảnh N = ảnh đầu cảnh N+1 đã xây cho continuousMotion, chỉ khác tên tham số so với Kling O1.
--
-- Giá đã tra fal.ai/models/fal-ai/veo3.1/lite/first-last-frame-to-video (2026-09-03): 720p không tiếng
-- $0.03/s (mức rẻ nhất, generate_audio: false — đồng bộ cách tính các model VEO khác trong catalog này).
-- Quy đổi 26.000đ/USD, duration mặc định 5s để khớp Kling O1 (model hỗ trợ "4s"/"6s"/"8s", chỉ expose
-- 3 mức đó vì đó là enum thật, không dùng "5s" như Kling).
--
-- LƯU Ý: model này BẮT BUỘC cả 2 ảnh (first_frame_url + last_frame_url là tham số required, không như
-- Kling O1 coi end_image_url là tuỳ chọn) — code (lib/story-video.ts, app/api/story-video/submit,
-- app/api/story-video/price) tự ép continuousMotion=true khi chọn đúng key "veo31-lite-flf", không cần
-- người dùng tự tick nữa.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "veo31-lite-flf", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Lite (chuyển động liên tục)", "model": "fal-ai/veo3.1/lite/first-last-frame-to-video", "provider_cost_vnd": 4680, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 3120, "6": 4680, "8": 6240}}]'::jsonb
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-veo31-lite-flf.sql =====

-- ===== BEGIN supabase/migration-story-video-dedupe-catalog.sql =====
-- Migration: dọn entry trùng lặp trong model_config.video_models của "Video từ ý tưởng truyện" —
-- migration-story-video-continuous-motion.sql (thêm "kling-o1-flfv") có vẻ đã chạy 2 lần trên DB thật,
-- khiến dropdown "Video phân cảnh" hiện 2 dòng "Kling O1 (chuyển động liên tục)" giống hệt nhau.
--
-- Giữ lại đúng 1 bản/key (bản xuất hiện ĐẦU TIÊN trong mảng), không đổi thứ tự các entry còn lại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (
    select jsonb_agg(elem order by ord)
    from (
      select distinct on (elem->>'key') elem, ord
      from jsonb_array_elements(model_config->'video_models') with ordinality as t(elem, ord)
      order by elem->>'key', ord
    ) dedup
  )
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-dedupe-catalog.sql =====

-- ===== BEGIN supabase/migration-story-video-fix-veo-flf-duration.sql =====
-- Migration: sửa catalog "VEO 3.1 Lite (chuyển động liên tục)" — chỉ còn đúng 1 mức thời lượng 8s.
--
-- Lỗi thật: migration-story-video-veo31-lite-flf.sql trước đó thêm 3 mức (4s/6s/8s) dựa theo suy đoán
-- (trang docs Fal.ai không ghi rõ enum cho model FLF này, khác các model Veo thường). Khách chọn 4s
-- gặp lỗi 422 liên tục từ Fal.ai: "Đầu vào phải là '8s'" — xác nhận qua dashboard Fal.ai thật, model
-- FLF này CHỈ nhận đúng "8s", không có mức nào khác. Code (buildVideoRequestBody) đã ép cứng "8s" rồi,
-- migration này chỉ dọn lại catalog cho khớp, tránh dropdown hiện các mức sai.
--
-- Giá 8s = $0.03/s x 8s x 26.000đ/USD = 6.240đ (giữ nguyên số đã tính đúng từ trước).
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (
    select jsonb_agg(
      case
        when elem->>'key' = 'veo31-lite-flf'
          then jsonb_set(elem, '{duration_price_vnd}', '{"8": 6240}'::jsonb)
        else elem
      end
    )
    from jsonb_array_elements(model_config->'video_models') as elem
  )
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-fix-veo-flf-duration.sql =====

-- ===== BEGIN supabase/migration-story-video-atomic-images-ready.sql =====
-- Sửa race condition: nhiều webhook ảnh (image/image_end) của cùng 1 job story-video có thể đến gần
-- như cùng lúc. Cách cũ (mỗi webhook tự SELECT toàn bộ cảnh rồi so sánh ở phía JS) không atomic —
-- 2 webhook có thể cùng đọc snapshot "còn thiếu ảnh" trước khi cái còn lại kịp ghi xong, nên KHÔNG
-- webhook nào tự nhận là "cái cuối cùng" và job kẹt mãi ở status "generating_images" dù ảnh đã đủ
-- (đã gặp thật với job #72 — 6/6 cảnh có đủ image_url + end_image_url nhưng status không tự chuyển).
-- Hàm này khoá đúng 1 dòng job ("for update") nên nhiều lệnh gọi đồng thời cho CÙNG job sẽ tự xếp
-- hàng tuần tự ở DB — chỉ đúng 1 lệnh gọi thấy "đủ cảnh + đang đúng status generating_images" và được
-- phép chuyển sang "images_ready", các lệnh gọi khác (đến trước khi đủ, hoặc đến sau khi đã có người
-- chuyển rồi) đều trả về false, không làm gì thêm — không cần khoá ở tầng ứng dụng.
create or replace function try_mark_story_video_images_ready(p_job_id bigint) returns boolean as $$
declare
  v_status text;
  v_continuous_motion boolean;
  v_missing_count integer;
begin
  select status, continuous_motion into v_status, v_continuous_motion
  from story_video_jobs
  where id = p_job_id
  for update;

  if v_status is null or v_status <> 'generating_images' then
    return false;
  end if;

  select count(*) into v_missing_count
  from story_video_scenes
  where job_id = p_job_id
    and (image_url is null or (v_continuous_motion and end_image_url is null));

  if v_missing_count > 0 then
    return false;
  end if;

  update story_video_jobs set status = 'images_ready' where id = p_job_id;
  return true;
end;
$$ language plpgsql;


-- ===== END supabase/migration-story-video-atomic-images-ready.sql =====

-- ===== BEGIN supabase/migration-story-video-end-description.sql =====
-- Chế độ "chuyển động liên tục" sinh thêm "end_description" (mô tả khoảnh khắc KẾT THÚC của cảnh,
-- dùng làm ảnh cuối) khi Agent chia cảnh, nhưng trước giờ chỉ giữ tạm trong bộ nhớ lúc submit rồi bỏ
-- đi — không lưu vào DB. Cần lưu lại để sau này có thể "Tạo lại" đúng ảnh cuối 1 cảnh (dùng lại đúng
-- mô tả gốc) mà không phải đoán lại từ "scene_description" (chỉ là mô tả khoảnh khắc ĐẦU).
alter table story_video_scenes add column if not exists end_description text;


-- ===== END supabase/migration-story-video-end-description.sql =====

-- ===== BEGIN supabase/migration-story-video-skill-prompts.sql =====
-- 7-skill architecture: mỗi bước AI trong pipeline story-video có 1 field hướng dẫn riêng trong
-- model_config, admin sửa được ngay trên trang Admin, không cần deploy lại code.
-- 2/7 skill (story-planner = prompt_helper_instructions, character-manager = character_prompt) đã có
-- sẵn từ trước — migration này chỉ thêm 5 field còn thiếu, giá trị mặc định rỗng (rỗng = code tự dùng
-- bản mặc định hardcode, đúng hành vi 2 field cũ).
update mini_apps
set model_config = model_config || jsonb_build_object(
  'story_extractor_prompt', coalesce(model_config->>'story_extractor_prompt', ''),
  'story_validator_prompt', coalesce(model_config->>'story_validator_prompt', ''),
  'scene_image_prompt', coalesce(model_config->>'scene_image_prompt', ''),
  'motion_planner_prompt', coalesce(model_config->>'motion_planner_prompt', ''),
  'continuity_checker_prompt', coalesce(model_config->>'continuity_checker_prompt', '')
)
where id = 'video-tu-y-tuong';

-- Chế độ "dẫn trạng thái qua khung hình thật" (frame-chaining) — nối tiếp cảnh bằng khung hình THẬT
-- trích từ video vừa render (khác continuous_motion cũ dùng ảnh AI tự đoán trước) — xem lib/story-video.ts.
alter table story_video_jobs add column if not exists frame_chain_mode boolean not null default false;
alter table story_video_scenes add column if not exists last_frame_url text;


-- ===== END supabase/migration-story-video-skill-prompts.sql =====

-- ===== BEGIN supabase/migration-story-video-skill-content.sql =====
-- Điền nội dung mặc định hợp lý cho 5 skill mới (đã tạo cột rỗng ở migration-story-video-skill-prompts.sql)
-- — mỗi câu là "Ghi chú thêm từ admin" nối vào SAU prompt mặc định hardcode trong lib/story-video.ts,
-- không thay thế. Anh sửa lại bất cứ lúc nào qua trang Admin, không cần chạy lại migration.
update mini_apps
set model_config = model_config || jsonb_build_object(
  'story_extractor_prompt',
    'Giữ nguyên mọi mốc thời gian, thời tiết, và số lượng nhân vật đã có trong truyện gốc — không tự thêm hoặc bỏ bớt chi tiết nào.',
  'story_validator_prompt',
    'Đặc biệt kiểm tra: nếu truyện có hành động đổi tư thế lớn (đứng dậy, ngồi xuống, quay người, di chuyển sang chỗ khác), hành động đó phải xuất hiện rõ trong ít nhất 1 cảnh — báo lỗi nếu bị bỏ sót.',
  'scene_image_prompt',
    'Ánh sáng tự nhiên, ấm áp như ảnh chụp ban ngày thật, trừ khi truyện mô tả rõ thời điểm khác. Giữ trang phục nhất quán giữa các cảnh trừ khi truyện có yêu cầu đổi đồ.',
  'motion_planner_prompt',
    'Ưu tiên chuyển động chậm rãi, tự nhiên, điện ảnh — tránh giật cục hoặc quá nhanh. Camera đứng yên trừ khi mô tả cảnh yêu cầu lia máy.',
  'continuity_checker_prompt',
    'Khi so sánh 2 ảnh để tìm lỗi, ưu tiên kiểm tra khuôn mặt (mắt, mũi, môi, hình dáng mặt) hơn trang phục hay kiểu tóc — trang phục/tóc có thể đổi hợp lý theo cảnh, nhưng khuôn mặt không được đổi.'
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-skill-content.sql =====

-- ===== BEGIN supabase/migration-story-video-identity-retry.sql =====
-- Frame-chaining — lưới an toàn lớp 2: đếm số lần đã vẽ lại 1 cảnh do AI phát hiện sai danh tính
-- (checkSceneIdentityMatch), trước khi quay về ảnh Character gốc làm phương án dự phòng cuối cùng —
-- xem applyFrameChainImageResult() trong lib/story-video.ts.
alter table story_video_scenes add column if not exists identity_retry_count integer not null default 0;


-- ===== END supabase/migration-story-video-identity-retry.sql =====

-- ===== BEGIN supabase/migration-story-video-item-reference.sql =====
-- Migration: cho phép mỗi nhân vật đưa 1 ảnh THẬT của 1 vật phẩm riêng của họ (đôi giày, túi xách,
-- đồng hồ...) lên, để ảnh phân cảnh AI vẽ đúng y hệt món đó khi truyện tả nhân vật mặc/mang/cầm nó,
-- thay vì AI tự bịa ra kiểu dáng khác. Tuỳ chọn — không dùng thì hành vi giữ nguyên như trước.
-- Job 1 nhân vật dùng cột trên story_video_jobs (mirror location_reference_url), job nhiều nhân vật
-- dùng cột trên story_video_job_characters (mỗi hàng = 1 nhân vật, mirror character_sheet_url).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists item_reference_url text;
alter table story_video_job_characters add column if not exists item_reference_url text;


-- ===== END supabase/migration-story-video-item-reference.sql =====

-- ===== BEGIN supabase/migration-story-video-motion-timing.sql =====
-- Motion Timing Controller: mỗi cảnh có thể cần thời lượng video khác nhau tuỳ lượng chuyển động
-- (cảnh hành động nhỏ ép vào khung thời gian dài -> model tự bịa thêm chuyển động thừa để lấp đầy;
-- cảnh hành động lớn ép vào khung thời gian ngắn -> model phải tua nhanh, ra chuyển động giật). Trước
-- đây MỌI cảnh trong 1 job dùng chung đúng 1 "video_duration_key" khách chọn 1 lần lúc submit. Cột
-- này lưu thời lượng RIÊNG cho từng cảnh (do skill motion-planner tự ước lượng dựa vào lượng chuyển
-- động trong "motion_prompt" của chính cảnh đó) -- null thì rơi về video_duration_key của job như cũ
-- (không có gì thay đổi, không hồi quy).
alter table story_video_scenes add column if not exists motion_duration_key text;


-- ===== END supabase/migration-story-video-motion-timing.sql =====

-- ===== BEGIN supabase/migration-story-video-reference-video-models.sql =====
-- 2 model video MỚI đã kiểm chứng THẬT qua API (gửi request thật, nhận về video.url hợp lệ) — cả 2 đều
-- chấp nhận gửi kèm ẢNH CHARACTER (mặt/góc) ngay lúc TẠO VIDEO, không chỉ dựa vào đúng 1 ảnh bắt đầu
-- cảnh như mọi model khác trong catalog hiện có. Đây là điểm khắc phục lỗi "khuôn mặt nhân vật đổi khi
-- quay lại camera" — model có sẵn ảnh mặt Character làm căn cứ xuyên suốt lúc sinh video, không phải tự
-- bịa khi ảnh bắt đầu cảnh đang quay lưng/khuất mặt.
--
-- fal-ai/kling-video/o1/reference-to-video: $0.112/giây, duration enum "3".."10", nhận "elements"
-- (frontal_image_url + reference_image_urls) tách riêng vai trò khỏi "image_urls" (ảnh bắt đầu cảnh).
-- fal-ai/veo3.1/reference-to-video: $0.20/giây @720p không tiếng, "image_urls" là 1 mảng phẳng gộp cả
-- ảnh cảnh lẫn ảnh Character — docs không liệt kê enum thời lượng khác ngoài mặc định "8s", nên CHỈ mở
-- đúng mức "8" (an toàn hơn đoán bừa, tránh lặp lại kiểu lỗi 422 đã gặp với veo3.1 lite FLF trước đây).
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[
    {
      "key": "kling-o1-reference",
      "provider": "KLING",
      "label": "Kling O1 Reference (giữ khuôn mặt khi quay người)",
      "model": "fal-ai/kling-video/o1/reference-to-video",
      "provider_cost_vnd": 14560,
      "enabled": true,
      "character_reference": true,
      "aspect_ratios": ["16:9", "9:16", "1:1"],
      "duration_price_vnd": {"3": 8736, "4": 11648, "5": 14560, "6": 17472, "7": 20384, "8": 23296}
    },
    {
      "key": "veo31-reference",
      "provider": "GOOGLE_VEO",
      "label": "VEO 3.1 Reference (giữ khuôn mặt khi quay người)",
      "model": "fal-ai/veo3.1/reference-to-video",
      "provider_cost_vnd": 41600,
      "enabled": true,
      "character_reference": true,
      "aspect_ratios": ["16:9", "9:16"],
      "duration_price_vnd": {"8": 41600}
    }
  ]'::jsonb
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-reference-video-models.sql =====

-- ===== BEGIN supabase/migration-story-video-natural-duration.sql =====
-- Lưu riêng thời lượng "tự nhiên" (natural duration) do Motion Timing Controller ước lượng cho mỗi
-- cảnh, TÁCH BIỆT với motion_duration_key (mức thời lượng THẬT SỰ gửi cho model video, làm tròn theo
-- catalog model đó, vd "8" dù natural chỉ 6s). Dùng để: khi mức đã chọn (generation) >= nhu cầu thật
-- (natural), tự thêm chỉ dẫn "giữ nguyên tư thế sau Ns" + cắt (trim) video còn đúng Ns sau khi tải về
-- -- loại bỏ phần model tự bịa thêm chuyển động thừa (đã ghi chú "aimless/drifting" trong
-- SCENE_PROMPT_FROM_IMAGE_SYSTEM từ trước), KHÔNG tốn thêm chi phí (vẫn dùng đúng mức duration đã
-- chọn, chỉ trim bớt phần cuối clip tải về).
alter table story_video_scenes add column if not exists natural_duration_seconds numeric;


-- ===== END supabase/migration-story-video-natural-duration.sql =====

-- ===== BEGIN supabase/migration-fix-deduct-credit-idempotency.sql =====
-- Fix: deduct_credit() không thực sự idempotent -- khi cùng 1 idempotency_key được gọi lại lần 2
-- (webhook retry, khách bấm lại nút, race condition), function chỉ INSERT thẳng và để lỗi unique
-- constraint "credit_transactions_idempotency_key_key" của Postgres ném ra ngoài. Lỗi Postgres thô
-- đó lộ thẳng ra UI cho khách thấy (do route đã đổi sang surface real error message thay vì fallback
-- chung). Sửa: SELECT trước để phát hiện key đã xử lý rồi thì trả lại đúng kết quả cũ, không trừ
-- credit lần 2, không ném lỗi; thêm khối EXCEPTION bắt riêng unique_violation làm lưới an toàn cho
-- race hiếm (2 lượt gọi cùng lúc cùng vượt qua được SELECT trước khi lượt nào INSERT xong).
create or replace function deduct_credit(
  p_user_id uuid,
  p_amount integer,
  p_mini_app_id text,
  p_idempotency_key text
) returns table(success boolean, new_balance integer, tx_id bigint) as $$
declare
  v_current_balance integer;
  v_tx_id bigint;
  v_existing_id bigint;
begin
  select id into v_existing_id from credit_transactions where idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    select credit_balance into v_current_balance from user_profiles where user_id = p_user_id;
    return query select true, v_current_balance, v_existing_id;
    return;
  end if;

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

  begin
    insert into credit_transactions (user_id, amount, type, mini_app_id, idempotency_key)
    values (p_user_id, -p_amount, 'usage', p_mini_app_id, p_idempotency_key)
    returning id into v_tx_id;
  exception when unique_violation then
    select id into v_tx_id from credit_transactions where idempotency_key = p_idempotency_key;
    select credit_balance into v_current_balance from user_profiles where user_id = p_user_id;
    return query select true, v_current_balance, v_tx_id;
    return;
  end;

  update user_profiles set credit_balance = credit_balance - p_amount
  where user_id = p_user_id;

  return query select true, v_current_balance - p_amount, v_tx_id;
end;
$$ language plpgsql;


-- ===== END supabase/migration-fix-deduct-credit-idempotency.sql =====

-- ===== BEGIN supabase/migration-story-video-preplanned-actions.sql =====
-- Bước "Tạo kịch bản" (xem lib/story-video.ts: generateStoryScript/planStoryVideoScenes/runSceneStage) --
-- lưu lại mảng "actions" khách đã xác nhận lúc submit (chỉ luồng 1 nhân vật, AI tự vẽ ảnh), để
-- continueStoryVideoToSceneStage (chạy SAU, khi Character phải tạo mới qua webhook -- không cùng
-- request với lúc submit) vẫn dùng đúng kịch bản đã hiện giá cho khách, không chia cảnh lại từ đầu
-- bằng splitStoryIntoScenes (LLM cũ, không khớp giá đã xác nhận).
alter table story_video_jobs add column if not exists preplanned_actions jsonb;


-- ===== END supabase/migration-story-video-preplanned-actions.sql =====

-- ===== BEGIN supabase/migration-story-video-motion-pace-rotation.sql =====
-- Motion Timing Controller (mở rộng) — xem ghi nhớ project_story_video_scene_duration_architecture.
-- Agent viết kịch bản (generateStoryScript) giờ ước lượng thêm "pace" (fast/normal/slow, đọc ra từ
-- chính từ ngữ khách dùng trong truyện, vd "vội vã"/"từ tốn") và "rotation_degrees" (số độ xoay THẬT,
-- vì camera_view 6 giá trị rời rạc không phân biệt được "xoay 360 độ" với "không xoay" — cả 2 đều trả
-- về "front"). Code (buildMotionTimingSpec) dùng 2 field này để tính tốc độ + chia 5 giai đoạn
-- tăng/giảm tốc, thay vì để Agent viết chuyển động tự đoán mù nhịp độ.
alter table story_video_scenes add column if not exists pace text;
alter table story_video_scenes add column if not exists rotation_degrees numeric;


-- ===== END supabase/migration-story-video-motion-pace-rotation.sql =====

-- ===== BEGIN supabase/migration-story-video-multi-item.sql =====
alter table story_video_jobs add column if not exists item_reference_urls text[];
alter table story_video_job_characters add column if not exists item_reference_urls text[];


-- ===== END supabase/migration-story-video-multi-item.sql =====

-- ===== BEGIN supabase/migration-story-video-flux-kontext-multi.sql =====
-- Thêm 2 model ảnh mới vào catalog "Video từ ý tưởng truyện": FLUX.1 Kontext [pro] Multi và
-- [max] Multi — bản Multi THẬT SỰ hỗ trợ nhiều ảnh tham chiếu (image_urls[]), khác bản thường
-- (fal-ai/flux-pro/kontext, key "flux-kontext" đã có sẵn) chỉ nhận đúng 1 ảnh (image_url).
-- Giá đã tra thật qua fal.ai (26.000đ/USD): Pro Multi $0.04/ảnh, Max Multi $0.08/ảnh — rẻ hơn
-- nhiều so với 2 model multi-image đang có (Nano Banana Pro 3.900đ, GPT Image 2 Edit 5.700đ).
-- Không cần sửa code: buildImageRequestBody() đã tự gửi đúng field "image_urls" cho mọi model
-- có multi_image: true.
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{image_models}',
  (model_config->'image_models') || '[
    {
      "key": "flux-kontext-pro-multi",
      "label": "Flux Kontext Pro Multi",
      "model": "fal-ai/flux-pro/kontext/multi",
      "enabled": true,
      "provider": "BFL",
      "multi_image": true,
      "aspect_ratios": ["9:16", "16:9", "1:1"],
      "provider_cost_vnd": 1040
    },
    {
      "key": "flux-kontext-max-multi",
      "label": "Flux Kontext Max Multi",
      "model": "fal-ai/flux-pro/kontext/max/multi",
      "enabled": true,
      "provider": "BFL",
      "multi_image": true,
      "aspect_ratios": ["9:16", "16:9", "1:1"],
      "provider_cost_vnd": 2080
    }
  ]'::jsonb
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-flux-kontext-multi.sql =====

-- ===== BEGIN supabase/migration-story-video-character-text-description.sql =====
alter table story_video_jobs add column if not exists character_appearance_description text;
alter table story_video_job_characters add column if not exists appearance_description text;


-- ===== END supabase/migration-story-video-character-text-description.sql =====

-- ===== BEGIN supabase/migration-story-video-h3-max.sql =====
-- MiniMax H3 Max (image-to-video) — tự sinh giọng nói + khớp môi ngay trong lúc tạo video, đã xác nhận
-- hỗ trợ tiếng Việt qua test thật. Giá dùng mức THƯỜNG (sau khi hết khuyến mãi 50% ngày 30/9/2026) để
-- không bán dưới giá vốn khi khuyến mãi hết hạn: 768P $0.08/s x 5s = $0.40 x 26.000đ/USD = 10.400đ.
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "h3-max", "provider": "MINIMAX", "label": "MiniMax H3 Max (tự sinh giọng nói)", "model": "minimax/h3-max/image-to-video", "provider_cost_vnd": 10400, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"5": 10400}}]'::jsonb
)
where id = 'video-tu-y-tuong';


-- ===== END supabase/migration-story-video-h3-max.sql =====

-- ===== BEGIN supabase/migration-story-video-webhook-dedup.sql =====
-- Fal.ai gửi webhook có thể trùng lặp (giao hàng "at-least-once", đã xác nhận thật qua log: cùng 1 sự
-- kiện tạo ảnh/video cho 1 cảnh bị xử lý đồng thời 2-3 lần) — vì webhook/route.ts trước đây không có cơ
-- chế chống trùng nào, mỗi lượt trùng lặp chạy lại toàn bộ logic (kể cả lưới an toàn danh tính tự vẽ
-- lại ảnh/video), tốn thêm tiền Fal.ai thật mà không mang lại lợi ích gì. Mirror đúng pattern
-- webhook_dedup đã dùng cho Sepay (migration-topup-orders.sql) — chỉ khác key là text (Fal.ai request_id
-- là chuỗi, không phải số).
create table if not exists story_video_webhook_dedup (
  dedup_key text primary key,
  created_at timestamptz default now()
);

alter table story_video_webhook_dedup enable row level security;


-- ===== END supabase/migration-story-video-webhook-dedup.sql =====

-- ===== BEGIN supabase/migration-story-video-camera-framing.sql =====
-- Cỡ cảnh (shot_size) + góc máy (camera_angle) + chuyển động máy (camera_movement) — 3 trục MÁY QUAY
-- hoàn toàn khác "camera_view" (hướng NHÂN VẬT quay mặt, đã có sẵn). Agent chia cảnh tự chọn theo
-- đúng thuật ngữ điện ảnh chuẩn (StudioBinder/nitromediagroup), tiêm vào prompt tạo ảnh (shot_size +
-- camera_angle) và prompt tạo video (camera_movement).
alter table story_video_scenes add column if not exists shot_size text;
alter table story_video_scenes add column if not exists camera_angle text;
alter table story_video_scenes add column if not exists camera_movement text;


-- ===== END supabase/migration-story-video-camera-framing.sql =====

-- ===== BEGIN supabase/migration-story-video-location-mask.sql =====
-- Vị trí đứng chính xác trong ảnh Bối cảnh/Địa điểm — ảnh mask cùng kích thước ảnh gốc (trắng = đặt
-- nhân vật vào đây, đen = giữ nguyên) do khách khoanh vùng ở frontend. Chỉ có tác dụng khi
-- image_model đang dùng là "fal-ai/gpt-image-2/edit" (model duy nhất hỗ trợ mask_url thật sự, xem
-- buildImageRequestBody trong lib/story-video.ts).
alter table story_video_jobs add column if not exists location_reference_mask_url text;


-- ===== END supabase/migration-story-video-location-mask.sql =====

-- ===== BEGIN supabase/migration-story-video-location-mask-zones.sql =====
-- Nhiều nhân vật, nhiều vị trí trong CÙNG 1 ảnh Bối cảnh — mỗi phần tử JSON là 1 vùng
-- {position, xPct, yPct, wPct, hPct} (toạ độ chuẩn hoá 0..1) gán đúng 1 nhân vật. location_reference_mask_url
-- vẫn là ẢNH MASK DUY NHẤT (gộp mọi vùng trắng lại) — cột này chỉ để biết vùng nào của ai, dùng viết
-- chỉ dẫn văn bản mô tả vị trí tương đối (trái/phải/giữa...) cho từng người trong prompt.
alter table story_video_jobs add column if not exists location_reference_mask_zones jsonb;


-- ===== END supabase/migration-story-video-location-mask-zones.sql =====

-- ===== BEGIN supabase/migration-story-video-projects.sql =====
-- Video NHIỀU CHƯƠNG: 1 "dự án" gồm nhiều chương, mỗi chương là 1 job story_video_jobs chạy đầy đủ pipeline
-- hiện có (ý tưởng riêng, ảnh nhân vật/bối cảnh riêng, model riêng) ra 1 video ngắn. Khách bấm "Kết thúc"
-- thì ghép video các chương (theo chapter_index) thành video cuối. Lõi tạo video không đổi — chỉ thêm bảng
-- dự án + 2 cột gắn job vào dự án.
create table if not exists story_video_projects (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  mini_app_id text not null references mini_apps(id),
  status text not null default 'active' check (status in ('active', 'finalizing', 'done', 'failed')),
  -- Khoá theo chương 1: mọi chương phải cùng tỉ lệ khung hình để video cuối không bị viền đen lung tung.
  aspect_ratio text,
  final_output_url text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_story_video_projects_user on story_video_projects(user_id, created_at desc);
alter table story_video_projects enable row level security;

alter table story_video_jobs add column if not exists project_id bigint references story_video_projects(id);
alter table story_video_jobs add column if not exists chapter_index integer;
create index if not exists idx_story_video_jobs_project on story_video_jobs(project_id, chapter_index);


-- ===== END supabase/migration-story-video-projects.sql =====

-- ===== BEGIN supabase/migrations/admin_sessions.sql =====
-- Bảng lưu admin session token (random, không suy ra được từ mật khẩu) để logout thực sự
-- vô hiệu hoá được — thay cho token cũ = sha256(password + salt cố định), luôn ra cùng 1 giá
-- trị mọi lần đăng nhập nên không thể thu hồi. Xem lib/admin-auth.ts.
create table if not exists admin_sessions (
  token text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Chỉ service_role (server, qua getSupabaseAdmin()) mới được đọc/ghi bảng này — deny-all cho
-- anon/authenticated, giống pattern các bảng nội bộ khác trong project.
alter table admin_sessions enable row level security;

drop policy if exists "deny all admin_sessions" on admin_sessions;
create policy "deny all admin_sessions" on admin_sessions
  for all
  using (false)
  with check (false);

-- Dọn định kỳ session hết hạn (verifyAdminToken cũng tự xoá lúc phát hiện hết hạn, nhưng
-- session không ai gọi tới thì cứ nằm im — dọn bằng pg_cron cho sạch). cron.schedule() với job_name
-- dạng 3-tham số tự idempotent (gọi lại chỉ update job cũ cùng tên, không tạo trùng). Bỏ qua nếu
-- project chưa bật extension pg_cron — không bắt buộc, chỉ cần bảng admin_sessions tồn tại là code
-- lib/admin-auth.ts đã chạy được.
select cron.schedule(
  'cleanup-expired-admin-sessions',
  '0 3 * * *', -- 3h sáng mỗi ngày
  $$ delete from admin_sessions where expires_at < now(); $$
);


-- ===== END supabase/migrations/admin_sessions.sql =====

-- ===== BEGIN supabase/migration-reference-elements.sql =====
-- Kho tham chiếu chung (@mention) — xem lib/reference-elements.ts

create table if not exists reference_elements (
  id bigint generated by default as identity primary key,
  user_id uuid not null,
  type text not null check (type in ('character', 'location', 'prop')),
  name text not null,
  element_id text not null,
  description text,
  image_urls text[] not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists reference_elements_user_element_id_idx
  on reference_elements(user_id, element_id);

alter table reference_elements enable row level security;


-- ===== END supabase/migration-reference-elements.sql =====

