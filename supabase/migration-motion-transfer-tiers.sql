-- Migration: 2 tier chất lượng (Cơ bản/Cao cấp) cho "Nhảy theo video mẫu" — tier trước đây chỉ có 1
-- model cố định (Kling v2.6 Standard motion-control), chưa từng so sánh giá với lựa chọn khác.
-- Tier "Cao cấp" giá CỐ ĐỊNH (không theo duration) — độ dài video phụ thuộc video mẫu khách upload,
-- không phải lựa chọn 5s/10s như "Tạo video quảng cáo ngắn".
-- Giá quy đổi từ USD thật (tra 2026-08-17, giả định video mẫu tối đa 10s như trước):
-- - Cơ bản: fal-ai/kling-video/v2.6/standard/motion-control, $0.07/s x 10s x 26.000đ = 18.200đ (giữ nguyên).
-- - Cao cấp: fal-ai/kling-video/v3/pro/motion-control, $0.168/s x 10s x 26.000đ = 43.680đ.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

update mini_apps
set model_config = (model_config || '{
  "models": {
    "basic": {
      "model": "fal-ai/kling-video/v2.6/standard/motion-control",
      "provider_cost_vnd": 18200,
      "enabled": true
    },
    "premium": {
      "model": "fal-ai/kling-video/v3/pro/motion-control",
      "provider_cost_vnd": 43680,
      "enabled": true
    }
  }
}'::jsonb) - 'provider_cost_vnd'
where id = 'nhay-theo-video-mau';
