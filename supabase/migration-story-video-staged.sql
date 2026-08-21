-- Migration: chia "Video từ ý tưởng truyện" thành 2 nấc, đúng cách Genful làm — mặc định chỉ chạy
-- "chia phân cảnh + tạo ảnh" (rẻ), dừng lại cho khách xem trước, khách ưng mới bấm tiếp "Tạo video"
-- (đắt hơn nhiều). Có tuỳ chọn "tự động tạo video luôn" để gộp 1 lượt như trước (autoVideo=true).
-- App chưa có job thật nào chạy nên an toàn đổi thẳng cấu trúc cột. Cách dùng: Supabase Dashboard ->
-- SQL Editor -> dán toàn bộ -> Run.

alter table story_video_jobs add column if not exists auto_video boolean not null default false;

-- Tách 1 khoản credit_tx_id thành 2 khoản riêng: trừ ảnh lúc submit, trừ video lúc bấm "Tạo video"
-- (hoặc cùng lúc nếu auto_video=true) — cho phép hoàn tiền đúng phần nếu chỉ 1 trong 2 bước lỗi.
alter table story_video_jobs rename column credit_tx_id to image_credit_tx_id;
alter table story_video_jobs add column if not exists video_credit_tx_id bigint references credit_transactions(id);

-- Snapshot giá vốn/cảnh (VND) của model đã chọn lúc submit — dùng để tính lại giá tạo video ở bước
-- 2 (có thể diễn ra rất lâu sau bước 1) mà không phụ thuộc catalog admin có sửa/tắt entry đó chưa.
alter table story_video_jobs add column if not exists image_provider_cost_vnd_per_scene numeric;
alter table story_video_jobs add column if not exists video_provider_cost_vnd_per_scene numeric;

alter table story_video_jobs drop constraint if exists story_video_jobs_status_check;
alter table story_video_jobs add constraint story_video_jobs_status_check check (
  status in ('pending', 'splitting_story', 'generating_images', 'images_ready', 'generating_videos', 'stitching', 'done', 'failed')
);
