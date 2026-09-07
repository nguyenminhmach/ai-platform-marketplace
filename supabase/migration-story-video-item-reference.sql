-- Migration: cho phép mỗi nhân vật đưa 1 ảnh THẬT của 1 vật phẩm riêng của họ (đôi giày, túi xách,
-- đồng hồ...) lên, để ảnh phân cảnh AI vẽ đúng y hệt món đó khi truyện tả nhân vật mặc/mang/cầm nó,
-- thay vì AI tự bịa ra kiểu dáng khác. Tuỳ chọn — không dùng thì hành vi giữ nguyên như trước.
-- Job 1 nhân vật dùng cột trên story_video_jobs (mirror location_reference_url), job nhiều nhân vật
-- dùng cột trên story_video_job_characters (mỗi hàng = 1 nhân vật, mirror character_sheet_url).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists item_reference_url text;
alter table story_video_job_characters add column if not exists item_reference_url text;
