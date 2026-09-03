-- Migration: thêm VEO 3.1 Lite (First-Last-Frame-to-Video) làm lựa chọn "Chuyển động liên tục" thứ 2
-- cho "Video từ ý tưởng truyện" — bên cạnh Kling O1 đã có. Đây là model Fal.ai RIÊNG (khác hẳn model
-- "VEO 3.1 Lite" thường .../image-to-video đã có trong catalog, chỉ nhận 1 ảnh): endpoint
-- fal-ai/veo3.1/lite/first-last-frame-to-video nhận "first_frame_url" + "last_frame_url" — đúng cơ chế
-- ảnh cuối cảnh N = ảnh đầu cảnh N+1 đã xây cho continuousMotion, chỉ khác tên tham số so với Kling O1.
--
-- Giá đã tra fal.ai/models/fal-ai/veo3.1/lite/first-last-frame-to-video (2026-09-03): 720p không tiếng
-- $0.03/s (mức rẻ nhất, generate_audio: false — đồng bộ cách tính các model VEO khác trong catalog này).
-- Quy đổi 26.000đ/USD, duration mặc định 5s để khớp Kling O1 (model hỗ trợ "4s"/"6s"/"8s", chỉ expose
-- 3 mức đó vì đó là enum thật, không dùng "5s" như Kling).
--
-- LƯU Ý: model này BẮT BUỘC cả 2 ảnh (first_frame_url + last_frame_url là tham số required, không như
-- Kling O1 coi end_image_url là tuỳ chọn) — code (lib/story-video.ts, app/api/story-video/submit,
-- app/api/story-video/price) tự ép continuousMotion=true khi chọn đúng key "veo31-lite-flf", không cần
-- người dùng tự tick nữa.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "veo31-lite-flf", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Lite (chuyển động liên tục)", "model": "fal-ai/veo3.1/lite/first-last-frame-to-video", "provider_cost_vnd": 4680, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 3120, "6": 4680, "8": 6240}}]'::jsonb
)
where id = 'video-tu-y-tuong';
