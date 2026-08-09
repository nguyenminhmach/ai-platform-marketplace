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
