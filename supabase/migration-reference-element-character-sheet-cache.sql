-- Sửa lỗi thật user báo: "đã có ảnh character rồi vẫn tạo lại" — mỗi khi @mention 1 nhân vật từ kho
-- tham chiếu (reference_elements) để tạo video, luồng tạo Character (lib/story-video.ts) luôn tạo
-- MỚI 1 tấm character sheet (tốn credit + thời gian) vì reference_elements chỉ lưu ảnh THÔ (từng góc
-- rời), không lưu lại sheet đã tạo xong lần trước để dùng lại. Thêm 2 cột để cache:
-- - reference_elements.character_sheet_url: tấm sheet 6 góc đã tạo xong gần nhất cho element này (chỉ
--   có nghĩa với type='character'); lần sau @mention cùng element, dùng thẳng sheet này, bỏ qua bước
--   tạo mới.
-- - story_video_jobs.character_reference_element_id: job NÀO tạo sheet cho ELEMENT nào (chỉ set khi
--   job tạo sheet MỚI từ 1 element, không phải từ ảnh tải rời/thư viện story_characters) — để
--   applyCharacterStageResult biết ghi ngược sheet vừa tạo xong về đúng element đó.
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table reference_elements add column if not exists character_sheet_url text;
alter table story_video_jobs add column if not exists character_reference_element_id bigint references reference_elements(id);
