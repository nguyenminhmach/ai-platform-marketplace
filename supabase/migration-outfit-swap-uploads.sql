-- Migration: bucket lưu ảnh input (người mẫu + trang phục tham chiếu) cho app "Thay trang phục".
-- Trước đây gửi thẳng base64 trong request chạy AI -> 6-7 ảnh gộp chung dễ vượt giới hạn ~4.5MB/request
-- của Vercel, bị chặn thẳng ở tầng hạ tầng (413), lặp lại liên tục khi user chọn nhiều ảnh trang phục.
-- Nay upload từng ảnh lên Storage TRƯỚC, request chạy AI chỉ còn gửi URL (vài chục byte).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into storage.buckets (id, name, public)
values ('outfit-swap-uploads', 'outfit-swap-uploads', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh input thay trang phục" on storage.objects;
create policy "Ai cũng xem được ảnh input thay trang phục" on storage.objects for select using (bucket_id = 'outfit-swap-uploads');
