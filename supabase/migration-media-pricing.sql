-- Migration: giá credit ảnh/video tính động theo chi phí thật + biên lợi nhuận tùy chỉnh
-- Công thức: credit_cost = ceil(provider_cost_vnd * (1 + margin%/100) / vnd_per_credit)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists media_margin_percent integer not null default 50;
alter table site_settings add column if not exists vnd_per_credit integer not null default 490;

-- Chi phí thật trả cho Fal.ai (VND) — lấy trực tiếp từ fal.ai/pricing (2026-08-10):
-- Ảnh (Flux Kontext Pro): $0.04/ảnh ≈ 1.000đ
-- Video (Kling 1.6 standard image-to-video): $0.056/giây x 5 giây mặc định ≈ 7.300đ
-- Admin có thể sửa lại khi Fal.ai đổi giá — cập nhật trực tiếp cột model_config qua Supabase.
update mini_apps set model_config = model_config || '{"provider_cost_vnd": 1000}'::jsonb
where id = 'tao-anh-quang-cao';

update mini_apps set model_config = model_config || '{"provider_cost_vnd": 7300}'::jsonb
where id = 'tao-video-quang-cao';
