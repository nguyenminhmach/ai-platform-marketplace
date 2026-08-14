-- Migration: thêm model thứ 3 "FASHN Try-On Max" cho app "Thay trang phục" — chất lượng/fidelity
-- cao hơn v1.6, nhưng chạy qua API RIÊNG của FASHN (api.fashn.ai), không qua Fal.ai như 2 model kia,
-- nên cần cột provider để biết dùng cơ chế poll nào khi chốt kết quả (xem lib/outfit-swap-jobs.ts).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table outfit_swap_job_items add column if not exists provider text not null default 'fal';
