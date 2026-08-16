-- Migration: thư viện nhạc nền (admin upload sẵn) để ghép vào video AI tạo ra.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

create table if not exists background_music (
  id bigserial primary key,
  name text not null,
  file_url text not null,
  created_at timestamptz default now()
);

alter table background_music enable row level security;

-- Bucket lưu file nhạc admin upload — public đọc (để ffmpeg tải về ghép + phát thử được),
-- chỉ service_role mới ghi (không có policy insert cho anon/authenticated).
insert into storage.buckets (id, name, public)
values ('background-music', 'background-music', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng nghe được nhạc nền" on storage.objects;
create policy "Ai cũng nghe được nhạc nền" on storage.objects for select using (bucket_id = 'background-music');

-- Lưu video đã ghép nhạc riêng, giữ nguyên output_url gốc (video câm) để có thể đổi bài nhạc khác
-- mà không cần tạo lại video từ đầu.
alter table video_jobs add column if not exists output_url_with_music text;
alter table video_jobs add column if not exists music_track_id bigint references background_music(id);
