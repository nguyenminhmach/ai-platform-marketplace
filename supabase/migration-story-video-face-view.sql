-- Migration: thêm cột face_view cho mỗi phân cảnh — thử nghiệm Priority 3 (tách hướng mặt/ánh nhìn
-- khỏi hướng thân người). Agent chia cảnh CHỈ điền cột này khi ý tưởng truyện nói rõ 2 hướng khác
-- nhau (vd "thân quay sang phải nhưng mắt vẫn nhìn thẳng camera") — cảnh bình thường (mặt cùng hướng
-- thân) thì để null như trước.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists face_view text;
