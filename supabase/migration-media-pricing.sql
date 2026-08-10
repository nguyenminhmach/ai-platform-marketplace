-- Migration: giá credit ảnh/video tính động theo chi phí thật + biên lợi nhuận tùy chỉnh
-- Công thức: credit_cost = ceil(provider_cost_vnd * (1 + margin%/100) / vnd_per_credit)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists media_margin_percent integer not null default 50;
alter table site_settings add column if not exists vnd_per_credit integer not null default 490;

-- Chi phí thật ước tính trả cho Fal.ai (VND) — admin có thể sửa lại khi Fal.ai đổi giá,
-- cập nhật trực tiếp cột model_config của từng Mini App qua Supabase khi cần.
update mini_apps set model_config = model_config || '{"provider_cost_vnd": 1000}'::jsonb
where id = 'tao-anh-quang-cao';

update mini_apps set model_config = model_config || '{"provider_cost_vnd": 12000}'::jsonb
where id = 'tao-video-quang-cao';
