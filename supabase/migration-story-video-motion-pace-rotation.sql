-- Motion Timing Controller (mở rộng) — xem ghi nhớ project_story_video_scene_duration_architecture.
-- Agent viết kịch bản (generateStoryScript) giờ ước lượng thêm "pace" (fast/normal/slow, đọc ra từ
-- chính từ ngữ khách dùng trong truyện, vd "vội vã"/"từ tốn") và "rotation_degrees" (số độ xoay THẬT,
-- vì camera_view 6 giá trị rời rạc không phân biệt được "xoay 360 độ" với "không xoay" — cả 2 đều trả
-- về "front"). Code (buildMotionTimingSpec) dùng 2 field này để tính tốc độ + chia 5 giai đoạn
-- tăng/giảm tốc, thay vì để Agent viết chuyển động tự đoán mù nhịp độ.
alter table story_video_scenes add column if not exists pace text;
alter table story_video_scenes add column if not exists rotation_degrees numeric;
