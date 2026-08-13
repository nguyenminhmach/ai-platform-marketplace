-- Migration: thêm Mini App "Thay trang phục cho người mẫu" — ghép 1 ảnh người mẫu với tối đa 10 ảnh
-- trang phục tham chiếu qua Fal.ai Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit).
-- Giá tính động THEO TỪNG ẢNH rồi nhân với số bộ đồ ở lúc chạy (khác các app ảnh khác chỉ tính 1 lần cố định)
-- — credit_cost ở đây chỉ là placeholder hiển thị, giá thật tính trong lib/outfit-swap.ts.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'thay-trang-phuc',
    'Thay trang phục cho người mẫu',
    'Tải 1 ảnh người mẫu + tối đa 10 ảnh trang phục tham chiếu, AI ghép người mẫu mặc thử từng bộ đồ, giữ nguyên khuôn mặt/dáng người/bối cảnh.',
    'anh',
    12,
    '{"model": "fal-ai/gemini-3-pro-image-preview/edit", "output_type": "image", "provider_cost_vnd": 3900}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;
