-- Migration: thêm bước "Tạo Character" (chạy TRƯỚC bước chia cảnh) cho "Video từ ý tưởng truyện" —
-- ảnh nhân vật khách tải lên (thường chụp góc lẻ, ánh sáng/nền lộn xộn) được chuyển thành 1 ảnh
-- Character sheet chuẩn (nhiều góc, ánh sáng đều, giữ nguyên khuôn mặt/trang phục) TRƯỚC khi dùng làm
-- tham chiếu cho từng cảnh — thay vì dùng thẳng ảnh gốc lộn xộn cho cả N lần gọi model ảnh như trước.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists character_sheet_url text;
alter table story_video_jobs add column if not exists character_credit_tx_id bigint references credit_transactions(id);
alter table story_video_jobs add column if not exists character_fal_request_id text;
-- 'generated' (gọi GPT Image 2 tạo mới) | 'uploaded_sheet' (AI phân loại ảnh khách tải lên đã là
-- sheet nhiều góc, dùng thẳng không tốn credit) | 'reused' (chọn từ thư viện Character đã lưu).
alter table story_video_jobs add column if not exists character_source text;

alter table story_video_jobs drop constraint if exists story_video_jobs_status_check;
alter table story_video_jobs add constraint story_video_jobs_status_check check (
  status in (
    'pending', 'generating_character', 'character_ready',
    'splitting_story', 'generating_images', 'images_ready',
    'generating_videos', 'stitching', 'done', 'failed'
  )
);

create index if not exists idx_story_video_jobs_character_fal_request on story_video_jobs(character_fal_request_id);

-- Thư viện Character tái sử dụng — khách lưu lại 1 Character sheet đã ưng ý để dùng cho video sau
-- (không cần tải ảnh + tốn credit tạo Character lại từ đầu mỗi lần).
create table if not exists story_characters (
  id bigserial primary key,
  user_id uuid not null references user_profiles(user_id),
  image_url text not null,
  label text,
  created_at timestamptz default now()
);

create index if not exists idx_story_characters_user on story_characters(user_id, created_at desc);

alter table story_characters enable row level security;
