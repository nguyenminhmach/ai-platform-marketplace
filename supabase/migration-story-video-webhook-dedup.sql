-- Fal.ai gửi webhook có thể trùng lặp (giao hàng "at-least-once", đã xác nhận thật qua log: cùng 1 sự
-- kiện tạo ảnh/video cho 1 cảnh bị xử lý đồng thời 2-3 lần) — vì webhook/route.ts trước đây không có cơ
-- chế chống trùng nào, mỗi lượt trùng lặp chạy lại toàn bộ logic (kể cả lưới an toàn danh tính tự vẽ
-- lại ảnh/video), tốn thêm tiền Fal.ai thật mà không mang lại lợi ích gì. Mirror đúng pattern
-- webhook_dedup đã dùng cho Sepay (migration-topup-orders.sql) — chỉ khác key là text (Fal.ai request_id
-- là chuỗi, không phải số).
create table if not exists story_video_webhook_dedup (
  dedup_key text primary key,
  created_at timestamptz default now()
);

alter table story_video_webhook_dedup enable row level security;
