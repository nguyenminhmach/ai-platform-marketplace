-- Migration: thêm VEO 3.1 Fast + VEO 3.1 Lite làm lựa chọn "Tiết kiệm hơn" cho Video phân cảnh —
-- rẻ hơn 50-85% so với VEO 3.1 hiện tại ($0.10/s và $0.03-0.08/s so với $0.20/s). Giá tra trực tiếp
-- fal.ai/models/fal-ai/veo3.1/fast/image-to-video và .../lite/image-to-video trước khi thêm. Cùng
-- schema request với "veo3" gốc (buildVideoRequestBody trong lib/story-video.ts đã mở rộng match model
-- này) — quy đổi giá theo mức KHÔNG tiếng (generate_audio: false), 720p mặc định cho Lite (mức rẻ nhất
-- $0.03/s), 720p/1080p đồng giá $0.10/s cho Fast. Tỉ giá 26.000đ/USD (đồng bộ các model VEO khác).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

update mini_apps
set model_config = model_config || '{
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"]},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"6": 6240, "10": 10400}},
    {"key": "veo3", "provider": "GOOGLE_VEO", "label": "VEO 3.1", "model": "fal-ai/veo3/image-to-video", "provider_cost_vnd": 31200, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 20800, "6": 31200, "8": 41600}},
    {"key": "veo31-fast", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Fast", "model": "fal-ai/veo3.1/fast/image-to-video", "provider_cost_vnd": 15600, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 10400, "6": 15600, "8": 20800}},
    {"key": "veo31-lite", "provider": "GOOGLE_VEO", "label": "VEO 3.1 Lite", "model": "fal-ai/veo3.1/lite/image-to-video", "provider_cost_vnd": 4680, "enabled": true, "aspect_ratios": ["16:9", "9:16"], "duration_price_vnd": {"4": 3120, "6": 4680, "8": 6240}},
    {"key": "hailuo-02", "provider": "HAILUOAI", "label": "MiniMax Hailuo 02", "model": "fal-ai/minimax/hailuo-02/standard/image-to-video", "provider_cost_vnd": 7020, "enabled": true, "duration_price_vnd": {"6": 7020, "10": 11700}}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';
