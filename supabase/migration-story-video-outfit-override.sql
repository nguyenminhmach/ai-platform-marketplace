-- Migration: thêm cột outfit_override cho mỗi phân cảnh — Bước 6 (Tầng Appearance của
-- Character Profile 3 tầng: Identity/Appearance/Scene). Agent chia cảnh CHỈ điền cột này
-- khi ý tưởng truyện nói rõ có đổi trang phục (vd "mặc đồ ngủ ở nhà, sau đó ra ngoài khoác
-- áo len") — cảnh nào không đổi đồ thì để null như bình thường.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists outfit_override text;
