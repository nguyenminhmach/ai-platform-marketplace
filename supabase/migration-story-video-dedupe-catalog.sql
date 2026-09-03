-- Migration: dọn entry trùng lặp trong model_config.video_models của "Video từ ý tưởng truyện" —
-- migration-story-video-continuous-motion.sql (thêm "kling-o1-flfv") có vẻ đã chạy 2 lần trên DB thật,
-- khiến dropdown "Video phân cảnh" hiện 2 dòng "Kling O1 (chuyển động liên tục)" giống hệt nhau.
--
-- Giữ lại đúng 1 bản/key (bản xuất hiện ĐẦU TIÊN trong mảng), không đổi thứ tự các entry còn lại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (
    select jsonb_agg(elem order by ord)
    from (
      select distinct on (elem->>'key') elem, ord
      from jsonb_array_elements(model_config->'video_models') with ordinality as t(elem, ord)
      order by elem->>'key', ord
    ) dedup
  )
)
where id = 'video-tu-y-tuong';
