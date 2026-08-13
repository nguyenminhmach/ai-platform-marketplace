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
