-- Migration: thêm cột motion_prompt cho story_video_scenes — lưu mô tả CHUYỂN ĐỘNG riêng cho bước
-- tạo VIDEO (khác scene_description vốn là mô tả ẢNH tĩnh do Agent chia cảnh viết). Sinh 1 lần lúc
-- chuẩn bị submit video (proceedToVideoStage trong lib/story-video.ts), tái dùng lại khi khách bấm
-- "Tạo lại" video 1 cảnh (regenerateSceneVideo) — không gọi lại AI viết chuyển động mỗi lần tạo lại.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists motion_prompt text;
