-- MIN_SCENES ở code (lib/story-video.ts) đã hạ xuống 1 từ trước, nhưng constraint DB vẫn còn giữ
-- "between 2 and 8" (từ migration-story-video-catalog.sql) — chưa cập nhật theo, nên submit job với
-- đúng 1 phân cảnh bị Postgres chặn ở tầng DB (lỗi "violates check constraint
-- story_video_jobs_num_scenes_check"), dù validate ở code đã cho phép.
alter table story_video_jobs drop constraint if exists story_video_jobs_num_scenes_check;
alter table story_video_jobs add constraint story_video_jobs_num_scenes_check check (num_scenes between 1 and 8);
