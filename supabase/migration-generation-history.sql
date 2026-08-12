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
