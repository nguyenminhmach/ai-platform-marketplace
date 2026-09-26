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
