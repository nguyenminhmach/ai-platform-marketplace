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
