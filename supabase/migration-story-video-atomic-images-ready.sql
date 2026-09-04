-- Sửa race condition: nhiều webhook ảnh (image/image_end) của cùng 1 job story-video có thể đến gần
-- như cùng lúc. Cách cũ (mỗi webhook tự SELECT toàn bộ cảnh rồi so sánh ở phía JS) không atomic —
-- 2 webhook có thể cùng đọc snapshot "còn thiếu ảnh" trước khi cái còn lại kịp ghi xong, nên KHÔNG
-- webhook nào tự nhận là "cái cuối cùng" và job kẹt mãi ở status "generating_images" dù ảnh đã đủ
-- (đã gặp thật với job #72 — 6/6 cảnh có đủ image_url + end_image_url nhưng status không tự chuyển).
-- Hàm này khoá đúng 1 dòng job ("for update") nên nhiều lệnh gọi đồng thời cho CÙNG job sẽ tự xếp
-- hàng tuần tự ở DB — chỉ đúng 1 lệnh gọi thấy "đủ cảnh + đang đúng status generating_images" và được
-- phép chuyển sang "images_ready", các lệnh gọi khác (đến trước khi đủ, hoặc đến sau khi đã có người
-- chuyển rồi) đều trả về false, không làm gì thêm — không cần khoá ở tầng ứng dụng.
create or replace function try_mark_story_video_images_ready(p_job_id bigint) returns boolean as $$
declare
  v_status text;
  v_continuous_motion boolean;
  v_missing_count integer;
begin
  select status, continuous_motion into v_status, v_continuous_motion
  from story_video_jobs
  where id = p_job_id
  for update;

  if v_status is null or v_status <> 'generating_images' then
    return false;
  end if;

  select count(*) into v_missing_count
  from story_video_scenes
  where job_id = p_job_id
    and (image_url is null or (v_continuous_motion and end_image_url is null));

  if v_missing_count > 0 then
    return false;
  end if;

  update story_video_jobs set status = 'images_ready' where id = p_job_id;
  return true;
end;
$$ language plpgsql;
