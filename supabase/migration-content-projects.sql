-- Migration: "Dự án" — gom nội dung (ảnh/video) khách tạo ở panel nhanh "Không gian cho mọi ý tưởng"
-- (app/video-tu-y-tuong) theo từng dự án đặt tên riêng, xem lại được sau. Cách dùng: Supabase Dashboard
-- → SQL Editor → dán toàn bộ file này → Run.

create table if not exists content_projects (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  name text not null,
  is_private boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_content_projects_user on content_projects(user_id, created_at desc);

-- RLS deny-all mặc định (giống các bảng nội bộ khác trong dự án) — chỉ backend (service_role key) thao
-- tác trực tiếp được, không mở trực tiếp cho client.
alter table content_projects enable row level security;

-- Gắn nội dung đã tạo (ảnh/video) vào đúng dự án — nullable, không có nghĩa là "chưa gán dự án nào"
-- (hành vi cũ, không đổi gì với dữ liệu/luồng cũ).
alter table generation_history add column if not exists project_id bigint references content_projects(id) on delete set null;
alter table prompt_image_jobs add column if not exists project_id bigint references content_projects(id) on delete set null;
alter table story_video_jobs add column if not exists project_id bigint references content_projects(id) on delete set null;

create index if not exists idx_generation_history_project on generation_history(project_id, created_at desc);
