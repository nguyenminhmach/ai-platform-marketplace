-- Theo thảo luận: khách có thể đã tải lên nhiều ảnh THẬT của 1 nhân vật (@mention) đã tự đủ các góc
-- cần (chính diện/nghiêng trái/nghiêng phải/sau lưng) -- trong trường hợp đó gọi AI gộp sheet
-- (CHARACTER_SHEET_MODEL, lib/story-video.ts) là vô ích, chỉ tốn thêm credit, vì ảnh thật tự nó đã
-- nhất quán giữa các cảnh (không có rủi ro AI "bịa" góc thiếu khác nhau mỗi lần như sheet).
-- Thêm cột lưu bản đồ góc->ảnh (reuse đúng cấu trúc CharacterAngleUrls đã dùng cho
-- story_video_jobs.character_angle_urls/story_video_job_characters.character_angle_urls) để:
-- 1) cache kết quả phân loại góc ảnh thô (classifyAngleCoverage) -- không gọi AI phân loại lại mỗi
--    lần dùng cùng 1 nhân vật.
-- 2) NHÂN TIỆN sửa luôn 1 khoảng hở có từ trước (migration-reference-element-character-sheet-cache.sql):
--    applyCharacterStageResult() trước đây chỉ ghi ngược character_sheet_url về reference_elements khi
--    tạo sheet xong, KHÔNG ghi ngược character_angle_urls đã cắt sẵn -- khiến các job SAU dùng lại
--    @mention cùng 1 nhân vật (nhánh existingCharacterSheetUrl) luôn rơi về fallback "gửi cả sheet"
--    thay vì gửi đúng ảnh góc cần, dù đã cắt sẵn ở lần tạo đầu tiên.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table reference_elements add column if not exists character_angle_urls jsonb;
