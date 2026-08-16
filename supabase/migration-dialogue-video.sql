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
