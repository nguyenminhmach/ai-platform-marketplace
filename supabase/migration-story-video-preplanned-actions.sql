-- Bước "Tạo kịch bản" (xem lib/story-video.ts: generateStoryScript/planStoryVideoScenes/runSceneStage) --
-- lưu lại mảng "actions" khách đã xác nhận lúc submit (chỉ luồng 1 nhân vật, AI tự vẽ ảnh), để
-- continueStoryVideoToSceneStage (chạy SAU, khi Character phải tạo mới qua webhook -- không cùng
-- request với lúc submit) vẫn dùng đúng kịch bản đã hiện giá cho khách, không chia cảnh lại từ đầu
-- bằng splitStoryIntoScenes (LLM cũ, không khớp giá đã xác nhận).
alter table story_video_jobs add column if not exists preplanned_actions jsonb;
