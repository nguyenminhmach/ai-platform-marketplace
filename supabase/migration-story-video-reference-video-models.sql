-- 2 model video MỚI đã kiểm chứng THẬT qua API (gửi request thật, nhận về video.url hợp lệ) — cả 2 đều
-- chấp nhận gửi kèm ẢNH CHARACTER (mặt/góc) ngay lúc TẠO VIDEO, không chỉ dựa vào đúng 1 ảnh bắt đầu
-- cảnh như mọi model khác trong catalog hiện có. Đây là điểm khắc phục lỗi "khuôn mặt nhân vật đổi khi
-- quay lại camera" — model có sẵn ảnh mặt Character làm căn cứ xuyên suốt lúc sinh video, không phải tự
-- bịa khi ảnh bắt đầu cảnh đang quay lưng/khuất mặt.
--
-- fal-ai/kling-video/o1/reference-to-video: $0.112/giây, duration enum "3".."10", nhận "elements"
-- (frontal_image_url + reference_image_urls) tách riêng vai trò khỏi "image_urls" (ảnh bắt đầu cảnh).
-- fal-ai/veo3.1/reference-to-video: $0.20/giây @720p không tiếng, "image_urls" là 1 mảng phẳng gộp cả
-- ảnh cảnh lẫn ảnh Character — docs không liệt kê enum thời lượng khác ngoài mặc định "8s", nên CHỈ mở
-- đúng mức "8" (an toàn hơn đoán bừa, tránh lặp lại kiểu lỗi 422 đã gặp với veo3.1 lite FLF trước đây).
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[
    {
      "key": "kling-o1-reference",
      "provider": "KLING",
      "label": "Kling O1 Reference (giữ khuôn mặt khi quay người)",
      "model": "fal-ai/kling-video/o1/reference-to-video",
      "provider_cost_vnd": 14560,
      "enabled": true,
      "character_reference": true,
      "aspect_ratios": ["16:9", "9:16", "1:1"],
      "duration_price_vnd": {"3": 8736, "4": 11648, "5": 14560, "6": 17472, "7": 20384, "8": 23296}
    },
    {
      "key": "veo31-reference",
      "provider": "GOOGLE_VEO",
      "label": "VEO 3.1 Reference (giữ khuôn mặt khi quay người)",
      "model": "fal-ai/veo3.1/reference-to-video",
      "provider_cost_vnd": 41600,
      "enabled": true,
      "character_reference": true,
      "aspect_ratios": ["16:9", "9:16"],
      "duration_price_vnd": {"8": 41600}
    }
  ]'::jsonb
)
where id = 'video-tu-y-tuong';
