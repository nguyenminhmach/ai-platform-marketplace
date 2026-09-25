-- Vị trí đứng chính xác trong ảnh Bối cảnh/Địa điểm — ảnh mask cùng kích thước ảnh gốc (trắng = đặt
-- nhân vật vào đây, đen = giữ nguyên) do khách khoanh vùng ở frontend. Chỉ có tác dụng khi
-- image_model đang dùng là "fal-ai/gpt-image-2/edit" (model duy nhất hỗ trợ mask_url thật sự, xem
-- buildImageRequestBody trong lib/story-video.ts).
alter table story_video_jobs add column if not exists location_reference_mask_url text;
