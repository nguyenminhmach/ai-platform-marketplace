-- Điền nội dung mặc định hợp lý cho 5 skill mới (đã tạo cột rỗng ở migration-story-video-skill-prompts.sql)
-- — mỗi câu là "Ghi chú thêm từ admin" nối vào SAU prompt mặc định hardcode trong lib/story-video.ts,
-- không thay thế. Anh sửa lại bất cứ lúc nào qua trang Admin, không cần chạy lại migration.
update mini_apps
set model_config = model_config || jsonb_build_object(
  'story_extractor_prompt',
    'Giữ nguyên mọi mốc thời gian, thời tiết, và số lượng nhân vật đã có trong truyện gốc — không tự thêm hoặc bỏ bớt chi tiết nào.',
  'story_validator_prompt',
    'Đặc biệt kiểm tra: nếu truyện có hành động đổi tư thế lớn (đứng dậy, ngồi xuống, quay người, di chuyển sang chỗ khác), hành động đó phải xuất hiện rõ trong ít nhất 1 cảnh — báo lỗi nếu bị bỏ sót.',
  'scene_image_prompt',
    'Ánh sáng tự nhiên, ấm áp như ảnh chụp ban ngày thật, trừ khi truyện mô tả rõ thời điểm khác. Giữ trang phục nhất quán giữa các cảnh trừ khi truyện có yêu cầu đổi đồ.',
  'motion_planner_prompt',
    'Ưu tiên chuyển động chậm rãi, tự nhiên, điện ảnh — tránh giật cục hoặc quá nhanh. Camera đứng yên trừ khi mô tả cảnh yêu cầu lia máy.',
  'continuity_checker_prompt',
    'Khi so sánh 2 ảnh để tìm lỗi, ưu tiên kiểm tra khuôn mặt (mắt, mũi, môi, hình dáng mặt) hơn trang phục hay kiểu tóc — trang phục/tóc có thể đổi hợp lý theo cảnh, nhưng khuôn mặt không được đổi.'
)
where id = 'video-tu-y-tuong';
