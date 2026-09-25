-- Nhiều nhân vật, nhiều vị trí trong CÙNG 1 ảnh Bối cảnh — mỗi phần tử JSON là 1 vùng
-- {position, xPct, yPct, wPct, hPct} (toạ độ chuẩn hoá 0..1) gán đúng 1 nhân vật. location_reference_mask_url
-- vẫn là ẢNH MASK DUY NHẤT (gộp mọi vùng trắng lại) — cột này chỉ để biết vùng nào của ai, dùng viết
-- chỉ dẫn văn bản mô tả vị trí tương đối (trái/phải/giữa...) cho từng người trong prompt.
alter table story_video_jobs add column if not exists location_reference_mask_zones jsonb;
