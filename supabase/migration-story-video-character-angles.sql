-- Migration: cắt Character sheet (6 góc gộp 1 ảnh) thành 6 ảnh riêng ngay sau khi AI vẽ xong, để
-- Reference Selector (bước sau) chọn đúng ảnh góc cần cho từng cảnh thay vì luôn gửi cả tấm gộp.
-- Chỉ áp dụng cho sheet do CHÍNH APP tự vẽ ra (character_source = 'generated') — bố cục 6 ô luôn cố
-- định theo đúng prompt của mình nên cắt bằng toạ độ cố định an toàn. Sheet khách tự tải lên
-- (uploaded_sheet) KHÔNG cắt vì không đảm bảo đúng bố cục 3x2 này.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

insert into storage.buckets (id, name, public)
values ('story-video-character-angles', 'story-video-character-angles', true)
on conflict (id) do nothing;

drop policy if exists "Ai cũng xem được ảnh góc Character đã cắt" on storage.objects;
create policy "Ai cũng xem được ảnh góc Character đã cắt" on storage.objects for select using (bucket_id = 'story-video-character-angles');

-- JSON dạng {"front": "...", "three_quarter_left": "...", "three_quarter_right": "...", "side": "...",
-- "back": "...", "face": "..."} — null nếu sheet chưa/không cắt được (uploaded_sheet, skipped, lỗi cắt).
alter table story_video_jobs add column if not exists character_angle_urls jsonb;
alter table story_characters add column if not exists angle_urls jsonb;
