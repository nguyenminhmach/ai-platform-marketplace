-- "Dự án" ở panel nhanh video-tu-y-tuong (content_projects) cần gắn được NỘI DUNG TẠO QUA
-- lib/story-video.ts (cả tab "hình ảnh" lẫn tab "video", sau khi 2 tab được chuyển sang dùng chung
-- pipeline đã ổn định này thay vì lib/prompt-image.ts riêng) -- KHÔNG được tái dùng cột
-- story_video_jobs.project_id hiện có, vì cột đó đã thuộc về 1 hệ thống "dự án" KHÁC hẳn và CÓ TRƯỚC
-- (story_video_projects -- "video nhiều chương", xem lib/story-video-projects.ts) -- dùng chung sẽ đụng
-- độ, 2 migration khác nhau định nghĩa FK khác nhau trên cùng 1 tên cột. Thêm cột MỚI, riêng biệt.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists content_project_id bigint references content_projects(id) on delete set null;
create index if not exists idx_story_video_jobs_content_project on story_video_jobs(content_project_id);
