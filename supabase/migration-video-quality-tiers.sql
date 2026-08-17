-- Migration: 2 tier chất lượng cho app "Tạo video quảng cáo ngắn" — "basic" (Kling v1.6, giá cố
-- định, không đổi) và "premium" (Kling v2.1 Pro, giá tính theo duration 5s/10s thật). Không cần sửa
-- schema bảng, chỉ cập nhật model_config theo đúng cấu trúc models.{key} đã dùng cho "Thay trang phục".
-- Giá premium quy đổi từ USD thật (fal.ai/models/fal-ai/kling-video/v2.1/pro/image-to-video, tra
-- 2026-08-17): $0.49 (5s) và $0.90 (10s) × 26.000đ/USD.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = (model_config || '{
  "models": {
    "basic": {
      "model": "fal-ai/kling-video/v1.6/standard/image-to-video",
      "provider_cost_vnd": 7300,
      "enabled": true
    },
    "premium": {
      "model": "fal-ai/kling-video/v2.1/pro/image-to-video",
      "provider_cost_vnd_5s": 12740,
      "provider_cost_vnd_10s": 23400,
      "enabled": true
    }
  }
}'::jsonb) - 'provider_cost_vnd'
where id = 'tao-video-quang-cao';
