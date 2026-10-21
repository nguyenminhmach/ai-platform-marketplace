-- Sửa lỗi thật "Could not find the 'aperture' column of 'story_video_scenes' in the schema cache"
-- khi test lại luồng video (tab "video") -- code ở lib/story-video.ts (resolveLightDirection/
-- resolveCameraBody/resolveLens/resolveAperture, dùng cho tính năng "cài đặt ánh sáng/máy ảnh" đã
-- xác nhận DONE+tested trong 1 phiên trước) đọc/ghi 4 cột light_direction, camera_body, lens,
-- aperture trên bảng story_video_scenes, nhưng không có file migration nào trong repo từng tạo các
-- cột này -- rất có thể đã áp qua Supabase MCP trực tiếp ở phiên trước (không lưu lại thành file),
-- và ít nhất cột "aperture" bị thiếu/mất trên database thật. Dùng IF NOT EXISTS cho cả 4 cột để an
-- toàn dù 3 cột kia đã có sẵn hay chưa.
alter table public.story_video_scenes
  add column if not exists light_direction text,
  add column if not exists camera_body text,
  add column if not exists lens text,
  add column if not exists aperture text;
