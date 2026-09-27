-- Bảng lưu admin session token (random, không suy ra được từ mật khẩu) để logout thực sự
-- vô hiệu hoá được — thay cho token cũ = sha256(password + salt cố định), luôn ra cùng 1 giá
-- trị mọi lần đăng nhập nên không thể thu hồi. Xem lib/admin-auth.ts.
create table if not exists admin_sessions (
  token text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Chỉ service_role (server, qua getSupabaseAdmin()) mới được đọc/ghi bảng này — deny-all cho
-- anon/authenticated, giống pattern các bảng nội bộ khác trong project.
alter table admin_sessions enable row level security;

drop policy if exists "deny all admin_sessions" on admin_sessions;
create policy "deny all admin_sessions" on admin_sessions
  for all
  using (false)
  with check (false);

-- Dọn định kỳ session hết hạn (verifyAdminToken cũng tự xoá lúc phát hiện hết hạn, nhưng
-- session không ai gọi tới thì cứ nằm im — dọn bằng pg_cron cho sạch). cron.schedule() với job_name
-- dạng 3-tham số tự idempotent (gọi lại chỉ update job cũ cùng tên, không tạo trùng). Bỏ qua nếu
-- project chưa bật extension pg_cron — không bắt buộc, chỉ cần bảng admin_sessions tồn tại là code
-- lib/admin-auth.ts đã chạy được.
select cron.schedule(
  'cleanup-expired-admin-sessions',
  '0 3 * * *', -- 3h sáng mỗi ngày
  $$ delete from admin_sessions where expires_at < now(); $$
);
