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
