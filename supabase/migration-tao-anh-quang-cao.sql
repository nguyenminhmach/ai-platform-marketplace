-- Migration: thêm Mini App "Tạo ảnh quảng cáo sản phẩm" (Giai đoạn 1 — sinh ảnh qua Fal.ai/Flux Kontext)
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'tao-anh-quang-cao',
    'Tạo ảnh quảng cáo sản phẩm',
    'Tải ảnh sản phẩm thật lên (không bắt buộc), mô tả bối cảnh mong muốn, AI tạo ảnh quảng cáo mới giữ đúng sản phẩm.',
    'anh',
    20,
    '{"model": "fal-ai/flux-pro/kontext", "output_type": "image"}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;
