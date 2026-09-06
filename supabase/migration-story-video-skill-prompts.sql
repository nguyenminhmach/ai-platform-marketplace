-- 7-skill architecture: mỗi bước AI trong pipeline story-video có 1 field hướng dẫn riêng trong
-- model_config, admin sửa được ngay trên trang Admin, không cần deploy lại code.
-- 2/7 skill (story-planner = prompt_helper_instructions, character-manager = character_prompt) đã có
-- sẵn từ trước — migration này chỉ thêm 5 field còn thiếu, giá trị mặc định rỗng (rỗng = code tự dùng
-- bản mặc định hardcode, đúng hành vi 2 field cũ).
update mini_apps
set model_config = model_config || jsonb_build_object(
  'story_extractor_prompt', coalesce(model_config->>'story_extractor_prompt', ''),
  'story_validator_prompt', coalesce(model_config->>'story_validator_prompt', ''),
  'scene_image_prompt', coalesce(model_config->>'scene_image_prompt', ''),
  'motion_planner_prompt', coalesce(model_config->>'motion_planner_prompt', ''),
  'continuity_checker_prompt', coalesce(model_config->>'continuity_checker_prompt', '')
)
where id = 'video-tu-y-tuong';

-- Chế độ "dẫn trạng thái qua khung hình thật" (frame-chaining) — nối tiếp cảnh bằng khung hình THẬT
-- trích từ video vừa render (khác continuous_motion cũ dùng ảnh AI tự đoán trước) — xem lib/story-video.ts.
alter table story_video_jobs add column if not exists frame_chain_mode boolean not null default false;
alter table story_video_scenes add column if not exists last_frame_url text;
