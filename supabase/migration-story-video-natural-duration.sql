-- Lưu riêng thời lượng "tự nhiên" (natural duration) do Motion Timing Controller ước lượng cho mỗi
-- cảnh, TÁCH BIỆT với motion_duration_key (mức thời lượng THẬT SỰ gửi cho model video, làm tròn theo
-- catalog model đó, vd "8" dù natural chỉ 6s). Dùng để: khi mức đã chọn (generation) >= nhu cầu thật
-- (natural), tự thêm chỉ dẫn "giữ nguyên tư thế sau Ns" + cắt (trim) video còn đúng Ns sau khi tải về
-- -- loại bỏ phần model tự bịa thêm chuyển động thừa (đã ghi chú "aimless/drifting" trong
-- SCENE_PROMPT_FROM_IMAGE_SYSTEM từ trước), KHÔNG tốn thêm chi phí (vẫn dùng đúng mức duration đã
-- chọn, chỉ trim bớt phần cuối clip tải về).
alter table story_video_scenes add column if not exists natural_duration_seconds numeric;
