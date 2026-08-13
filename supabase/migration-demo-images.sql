-- Bucket lưu ảnh minh hoạ admin upload cho card Mini App trên trang chủ (vd "Thay trang phục").
-- Public đọc (để hiện được trên card), chỉ service_role mới ghi (không có policy insert cho anon/authenticated).
insert into storage.buckets (id, name, public)
values ('demo-images', 'demo-images', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh demo" on storage.objects;
create policy "Ai cũng xem được ảnh demo" on storage.objects for select using (bucket_id = 'demo-images');
