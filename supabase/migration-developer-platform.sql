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
