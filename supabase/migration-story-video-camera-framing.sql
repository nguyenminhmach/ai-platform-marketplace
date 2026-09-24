-- Cỡ cảnh (shot_size) + góc máy (camera_angle) + chuyển động máy (camera_movement) — 3 trục MÁY QUAY
-- hoàn toàn khác "camera_view" (hướng NHÂN VẬT quay mặt, đã có sẵn). Agent chia cảnh tự chọn theo
-- đúng thuật ngữ điện ảnh chuẩn (StudioBinder/nitromediagroup), tiêm vào prompt tạo ảnh (shot_size +
-- camera_angle) và prompt tạo video (camera_movement).
alter table story_video_scenes add column if not exists shot_size text;
alter table story_video_scenes add column if not exists camera_angle text;
alter table story_video_scenes add column if not exists camera_movement text;
