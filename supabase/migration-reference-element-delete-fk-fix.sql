-- Sửa lỗi thật user báo: "không xóa được nhân vật" trong modal "Hình ảnh tham chiếu" (và trang
-- /reference-elements) -- nút "Xoá" gọi DELETE /api/reference-elements/[id] nhưng KHÔNG báo lỗi gì cả
-- khi thất bại (xem ReferencePickerModal.tsx/app/reference-elements/page.tsx: handleDelete chỉ
-- `if (res.ok) ...`, im lặng bỏ qua nếu !res.ok) -- khiến khách tưởng nút không hoạt động.
--
-- Nguyên nhân thật: migration-reference-element-character-sheet-cache.sql thêm cột
-- story_video_jobs.character_reference_element_id REFERENCES reference_elements(id) nhưng KHÔNG chỉ
-- định "on delete" -- mặc định Postgres là "NO ACTION", tức CHẶN HẲN việc xoá 1 reference_elements đã
-- từng được dùng để tạo Character cho bất kỳ job nào (lỗi 23503 foreign key violation) -- xảy ra với
-- MỌI nhân vật đã dùng để tạo video ít nhất 1 lần, đúng khớp các nhân vật "Mai"/"LAN" trong ảnh chụp
-- màn hình user gửi.
--
-- Sửa: đổi constraint sang "ON DELETE SET NULL" -- xoá nhân vật vẫn cho phép, job cũ chỉ mất đi con
-- trỏ ghi-ngược (character_reference_element_id = null), không ảnh hưởng gì tới dữ liệu job đó (ảnh
-- character_sheet_url/character_angle_urls của job đã copy riêng ra từ lúc tạo, không phụ thuộc
-- reference_elements còn tồn tại hay không).
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

do $$
declare
  constraint_name text;
begin
  select tc.constraint_name into constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
  where tc.table_name = 'story_video_jobs'
    and kcu.column_name = 'character_reference_element_id'
    and tc.constraint_type = 'FOREIGN KEY'
  limit 1;

  if constraint_name is not null then
    execute format('alter table story_video_jobs drop constraint %I', constraint_name);
  end if;

  alter table story_video_jobs
    add constraint story_video_jobs_character_reference_element_id_fkey
    foreign key (character_reference_element_id)
    references reference_elements(id)
    on delete set null;
end $$;
