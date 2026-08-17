-- Migration: tier thứ 3 "Tiết kiệm" (LTX-2.3 Fast) cho "Tạo video quảng cáo ngắn" và "Video trước/sau"
-- — rẻ hơn cả tier "Cơ bản" (Kling v1.6), video 6s (mặc định model) thay vì ~5s. LTX-2.3 nhận
-- start_image_url/end_image_url (khác tên tham số image_url/tail_image_url của Kling) nên cần đánh
-- dấu param_style: "ltx" để lib/ai-router.ts build đúng body khi gọi Fal.
-- Giá quy đổi từ USD thật (fal.ai/models/fal-ai/ltx-2.3/image-to-video/fast, tra 2026-08-17):
-- $0.04/s (1080p) × 6 giây mặc định × 26.000đ/USD = 6.240đ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{models,budget}',
  '{
    "model": "fal-ai/ltx-2.3/image-to-video/fast",
    "provider_cost_vnd": 6240,
    "enabled": true,
    "param_style": "ltx"
  }'::jsonb
)
where id in ('tao-video-quang-cao', 'video-truoc-sau');
