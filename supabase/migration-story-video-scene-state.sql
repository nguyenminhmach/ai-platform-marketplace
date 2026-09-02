-- Scene State: nối tiếp bối cảnh/tư thế giữa các cảnh cho "Video từ ý tưởng truyện" (luồng mặc định,
-- không bật chuyển động liên tục). Xem plan để biết chi tiết thiết kế.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists location text;
alter table story_video_scenes add column if not exists end_pose text;
