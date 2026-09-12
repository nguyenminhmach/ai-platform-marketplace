-- Thêm 2 model ảnh mới vào catalog "Video từ ý tưởng truyện": FLUX.1 Kontext [pro] Multi và
-- [max] Multi — bản Multi THẬT SỰ hỗ trợ nhiều ảnh tham chiếu (image_urls[]), khác bản thường
-- (fal-ai/flux-pro/kontext, key "flux-kontext" đã có sẵn) chỉ nhận đúng 1 ảnh (image_url).
-- Giá đã tra thật qua fal.ai (26.000đ/USD): Pro Multi $0.04/ảnh, Max Multi $0.08/ảnh — rẻ hơn
-- nhiều so với 2 model multi-image đang có (Nano Banana Pro 3.900đ, GPT Image 2 Edit 5.700đ).
-- Không cần sửa code: buildImageRequestBody() đã tự gửi đúng field "image_urls" cho mọi model
-- có multi_image: true.
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{image_models}',
  (model_config->'image_models') || '[
    {
      "key": "flux-kontext-pro-multi",
      "label": "Flux Kontext Pro Multi",
      "model": "fal-ai/flux-pro/kontext/multi",
      "enabled": true,
      "provider": "BFL",
      "multi_image": true,
      "aspect_ratios": ["9:16", "16:9", "1:1"],
      "provider_cost_vnd": 1040
    },
    {
      "key": "flux-kontext-max-multi",
      "label": "Flux Kontext Max Multi",
      "model": "fal-ai/flux-pro/kontext/max/multi",
      "enabled": true,
      "provider": "BFL",
      "multi_image": true,
      "aspect_ratios": ["9:16", "16:9", "1:1"],
      "provider_cost_vnd": 2080
    }
  ]'::jsonb
)
where id = 'video-tu-y-tuong';
