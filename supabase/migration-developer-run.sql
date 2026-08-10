-- Migration: cấu hình tỷ giá USD->VND dùng để quy đổi actual_cost_usd dev tự báo cáo
-- (Tập 8 mục 3.3) khi tính hoa hồng — admin chỉnh được, không hardcode.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists usd_to_vnd_rate numeric(10,2) not null default 26000;
