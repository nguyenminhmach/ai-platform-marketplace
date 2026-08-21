-- Migration: mở rộng catalog "Video từ ý tưởng truyện" — sửa giá Nano Banana Pro đang bán DƯỚI giá
-- vốn (1.800đ trong khi giá thật fal.ai là ~3.900đ/ảnh), thêm model GPT Image 2 (ảnh), VEO 3.1 +
-- MiniMax Hailuo 02 (video), thêm tỉ lệ khung hình + độ phân giải/thời lượng có giá riêng cho model
-- nào có dữ liệu giá thật (không bịa số cho model không có). Giá đã tra trực tiếp fal.ai/models trước
-- khi thêm — xem ghi chú nguồn trong plan. Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

alter table story_video_jobs add column if not exists aspect_ratio text;
alter table story_video_jobs add column if not exists image_resolution_key text;
alter table story_video_jobs add column if not exists video_duration_key text;

update mini_apps
set model_config = model_config || '{
  "image_models": [
    {"key": "flux-kontext", "provider": "BFL", "label": "Flux Kontext", "model": "fal-ai/flux-pro/kontext", "provider_cost_vnd": 1000, "multi_image": false, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "nano-banana-pro", "provider": "GOOGLE", "label": "Nano Banana Pro Edit", "model": "fal-ai/gemini-3-pro-image-preview/edit", "provider_cost_vnd": 3900, "multi_image": true, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "resolution_price_vnd": {"1K": 3900, "4K": 7800}},
    {"key": "gpt-image-2", "provider": "OPENAI", "label": "GPT Image 2 Edit", "model": "fal-ai/gpt-image-2/edit", "provider_cost_vnd": 5700, "multi_image": true, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]}
  ],
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"6": 6240, "10": 10400}},
    {"key": "veo3", "provider": "GOOGLE_VEO", "label": "VEO 3.1", "model": "fal-ai/veo3/image-to-video", "provider_cost_vnd": 31200, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 20800, "6": 31200, "8": 41600}},
    {"key": "hailuo-02", "provider": "HAILUOAI", "label": "MiniMax Hailuo 02", "model": "fal-ai/minimax/hailuo-02/standard/image-to-video", "provider_cost_vnd": 7020, "enabled": true, "duration_price_vnd": {"6": 7020, "10": 11700}}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';
