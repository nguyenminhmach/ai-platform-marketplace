-- Migration: thêm cột camera_view cho mỗi phân cảnh — Agent chia cảnh giờ trả thêm góc quay cần dùng
-- (front/3-4 trái/3-4 phải/nghiêng/sau lưng/cận mặt) cho từng cảnh, để bước sau (Reference Selector)
-- tra bảng chọn đúng ảnh góc đã cắt sẵn (xem migration-story-video-character-angles.sql) thay vì luôn
-- gửi cả tấm Character sheet gộp cho mọi cảnh như hiện tại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists camera_view text;
