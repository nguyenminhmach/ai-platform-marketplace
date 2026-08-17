-- Migration: hạ tầng cho tool dùng thử miễn phí không cần đăng nhập (/thu-mien-phi, "Xoá nền ảnh")
-- — mồi kéo traffic mới, chi phí Fal.ai do platform tự trả (không qua credit khách).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

-- 1 dòng = 1 lượt dùng thử — dùng để giới hạn theo IP/cookie (per-identity) và đếm tổng/ngày (trần
-- chi phí toàn cục). Không lưu ảnh input/output (chỉ là demo tức thời, không cần lịch sử lâu dài).
create table if not exists free_trial_log (
  id bigserial primary key,
  tool text not null,
  ip text,
  cookie_id text,
  created_at timestamptz default now()
);

create index if not exists idx_free_trial_log_tool_time on free_trial_log(tool, created_at);
create index if not exists idx_free_trial_log_ip on free_trial_log(tool, ip, created_at);
create index if not exists idx_free_trial_log_cookie on free_trial_log(tool, cookie_id, created_at);

alter table free_trial_log enable row level security;

-- Trần tổng chi phí/ngày cho toàn bộ tool dùng thử miễn phí — admin chỉnh trong /admin, an toàn
-- tài chính nếu bị lạm dụng hoặc bất ngờ viral. Mặc định 50 lượt/ngày (~23.400đ ở giá Bria RMBG 2.0).
alter table site_settings add column if not exists free_trial_daily_cap integer not null default 50;
