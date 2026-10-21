-- Sửa lỗi thật "new row for relation 'story_video_jobs' violates check constraint
-- 'story_video_jobs_status_check'" khi test lại luồng video (tab "video").
--
-- Đối chiếu lib/story-video.ts với constraint hiện tại (migration-story-video-character-step.sql):
-- code gán status 'scenes_ready' (bước xem trước bố cục MIỄN PHÍ sau khi chia cảnh, trước khi tốn
-- credit tạo ảnh thật -- continueStoryVideoToSceneStage) và 'cancelled' (handleCancelStoryVideo),
-- nhưng constraint status_check chưa từng được cập nhật để cho phép 2 giá trị này -- cùng kiểu lỗi
-- "cột/giá trị code cần nhưng migration chưa theo kịp" như cột aperture vừa sửa.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs drop constraint if exists story_video_jobs_status_check;
alter table story_video_jobs add constraint story_video_jobs_status_check check (
  status in (
    'pending', 'generating_character', 'character_ready',
    'splitting_story', 'scenes_ready', 'generating_images', 'images_ready',
    'generating_videos', 'stitching', 'done', 'failed', 'cancelled'
  )
);
