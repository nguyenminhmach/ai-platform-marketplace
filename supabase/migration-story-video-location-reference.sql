-- Migration: cho phép khách đưa 1 ảnh THẬT của địa điểm (sân vườn, nhà, cửa hàng...) lên, để ảnh
-- phân cảnh AI tạo ra diễn ra đúng tại khung cảnh thật đó thay vì AI tự bịa bối cảnh chung chung.
-- 1 job chỉ có 1 ảnh địa điểm (dùng chung cho mọi cảnh), tuỳ chọn — không dùng thì hành vi giữ nguyên
-- như trước (AI tự vẽ bối cảnh theo mô tả truyện).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists location_reference_url text;
