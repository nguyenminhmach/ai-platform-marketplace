-- Migration: bucket lưu bản sao (mirror) ảnh phân cảnh do Fal.ai tạo ra, tải về ngay sau khi tạo xong
-- thay vì chỉ lưu thẳng URL CDN Fal.ai (fal.media) -- đo thật xác nhận Fal.ai CDN không cache, chậm hơn
-- hẳn Supabase Storage (có CDN/cache riêng, lần tải lại sau nhanh gấp 3 lần). Xem mirrorImageToStorage
-- trong lib/story-video.ts.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

insert into storage.buckets (id, name, public)
values ('story-video-scene-images', 'story-video-scene-images', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh phân cảnh đã mirror" on storage.objects;
create policy "Ai cũng xem được ảnh phân cảnh đã mirror" on storage.objects for select using (bucket_id = 'story-video-scene-images');
