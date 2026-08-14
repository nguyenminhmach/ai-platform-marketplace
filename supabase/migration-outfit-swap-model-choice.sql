-- Migration: cho app "Thay trang phục" chạy song song 2 model (đa năng có prompt + FASHN try-on
-- chuyên biệt), admin bật/tắt từng model qua model_config.models.{generic,fashn}.enabled,
-- người dùng chỉ thấy nút chọn khi cả 2 đều bật (mặc định FASHN).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_jobs add column if not exists model_choice text;
