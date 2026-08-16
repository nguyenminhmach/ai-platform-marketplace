-- Migration: app "Nhảy theo video mẫu" — Kling Motion Control (fal-ai/kling-video/v2.6/standard/motion-control),
-- nhận 1 ảnh nhân vật + 1 video mẫu chuyển động, tái dùng bảng video_jobs sẵn có (start_frame_url =
-- ảnh nhân vật, end_frame_url = video mẫu — chỉ khác ý nghĩa, không đổi schema).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into storage.buckets (id, name, public)
values ('motion-transfer-uploads', 'motion-transfer-uploads', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được file input nhảy theo video mẫu" on storage.objects;
create policy "Ai cũng xem được file input nhảy theo video mẫu" on storage.objects for select using (bucket_id = 'motion-transfer-uploads');

-- Video mẫu (tối đa 15MB) vượt xa giới hạn ~4.5MB request body của Vercel nên KHÔNG upload qua API
-- route như các bucket ảnh khác — trình duyệt upload thẳng lên Storage bằng anon key (đã đăng nhập),
-- cần policy insert riêng vì service_role không tham gia bước này.
drop policy if exists "User đã đăng nhập upload được file nhảy theo video mẫu" on storage.objects;
create policy "User đã đăng nhập upload được file nhảy theo video mẫu" on storage.objects for insert to authenticated with check (bucket_id = 'motion-transfer-uploads');

-- provider_cost_vnd tính theo giả định video mẫu tối đa 10s x $0.07/s x 26.000đ/USD — ước lượng
-- giá trần (worst-case), không tính đúng theo độ dài thật vì Fal chỉ tính phí sau khi chạy xong.
insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'nhay-theo-video-mau',
    'Nhảy theo video mẫu',
    'Tải 1 ảnh nhân vật + 1 video mẫu chuyển động (tối đa 10 giây), AI cho nhân vật nhảy/chuyển động theo đúng video mẫu.',
    'video',
    56,
    '{"model": "fal-ai/kling-video/v2.6/standard/motion-control", "output_type": "video", "input_mode": "motion-control", "provider_cost_vnd": 18200}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;
