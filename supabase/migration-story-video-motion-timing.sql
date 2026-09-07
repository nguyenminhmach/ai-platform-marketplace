-- Motion Timing Controller: mỗi cảnh có thể cần thời lượng video khác nhau tuỳ lượng chuyển động
-- (cảnh hành động nhỏ ép vào khung thời gian dài -> model tự bịa thêm chuyển động thừa để lấp đầy;
-- cảnh hành động lớn ép vào khung thời gian ngắn -> model phải tua nhanh, ra chuyển động giật). Trước
-- đây MỌI cảnh trong 1 job dùng chung đúng 1 "video_duration_key" khách chọn 1 lần lúc submit. Cột
-- này lưu thời lượng RIÊNG cho từng cảnh (do skill motion-planner tự ước lượng dựa vào lượng chuyển
-- động trong "motion_prompt" của chính cảnh đó) -- null thì rơi về video_duration_key của job như cũ
-- (không có gì thay đổi, không hồi quy).
alter table story_video_scenes add column if not exists motion_duration_key text;
