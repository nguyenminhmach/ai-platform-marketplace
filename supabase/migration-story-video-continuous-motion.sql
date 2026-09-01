-- Migration: chuyển động liên tục giữa các cảnh (Kling O1 First-Last-Frame-to-Video) cho
-- "Video từ ý tưởng truyện" — mỗi cảnh có thêm 1 "ảnh cuối" (end_image_url), ảnh cuối cảnh N chính là
-- ảnh đầu cảnh N+1 (chuỗi N+1 ảnh cho N cảnh, không phải 2N) — xem plan để biết chi tiết thiết kế.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists end_image_url text;
alter table story_video_scenes add column if not exists end_image_fal_request_id text;
alter table story_video_jobs add column if not exists continuous_motion boolean not null default false;

-- provider_cost_vnd = $0.084/s x 5s x 26.000đ/USD (mức duration mặc định 5s ở v1, model hỗ trợ
-- "3"-"10" nhưng chỉ expose 1 mức để giữ đơn giản).
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "kling-o1-flfv", "provider": "KLING", "label": "Kling O1 (chuyển động liên tục)", "model": "fal-ai/kling-video/o1/standard/image-to-video", "provider_cost_vnd": 10920, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"5": 10920}}]'::jsonb
)
where id = 'video-tu-y-tuong';
