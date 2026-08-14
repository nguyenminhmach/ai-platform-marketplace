-- Migration: cho người dùng tự khai báo "Áo" hay "Cả bộ" cho TỪNG ảnh trang phục tham chiếu, thay vì
-- để FASHN v1.6 tự đoán (category "auto" hay sai khi ảnh tham chiếu là cả bộ áo+quần/váy phối cùng).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_job_items add column if not exists category text not null default 'tops';
