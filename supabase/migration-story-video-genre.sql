-- Migration: thêm cột genre_key cho story_video_jobs — khách chọn thể loại (Tình cảm/Hài hước/Kinh
-- dị/Khoa học viễn tưởng/Đời thường/Bí ẩn) ở khối "Agent xử lý", chỉ là 1 khoá tra bảng CỐ ĐỊNH trong
-- code (xem GENRE_STYLE_GUIDES trong lib/story-video.ts) — không lưu tự do, không phải AI tự quyết.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists genre_key text;
