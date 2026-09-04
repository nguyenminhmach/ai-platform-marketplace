-- Chế độ "chuyển động liên tục" sinh thêm "end_description" (mô tả khoảnh khắc KẾT THÚC của cảnh,
-- dùng làm ảnh cuối) khi Agent chia cảnh, nhưng trước giờ chỉ giữ tạm trong bộ nhớ lúc submit rồi bỏ
-- đi — không lưu vào DB. Cần lưu lại để sau này có thể "Tạo lại" đúng ảnh cuối 1 cảnh (dùng lại đúng
-- mô tả gốc) mà không phải đoán lại từ "scene_description" (chỉ là mô tả khoảnh khắc ĐẦU).
alter table story_video_scenes add column if not exists end_description text;
