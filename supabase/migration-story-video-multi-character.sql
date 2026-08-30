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
