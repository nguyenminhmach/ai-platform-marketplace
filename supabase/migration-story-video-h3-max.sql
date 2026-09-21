-- MiniMax H3 Max (image-to-video) — tự sinh giọng nói + khớp môi ngay trong lúc tạo video, đã xác nhận
-- hỗ trợ tiếng Việt qua test thật. Giá dùng mức THƯỜNG (sau khi hết khuyến mãi 50% ngày 30/9/2026) để
-- không bán dưới giá vốn khi khuyến mãi hết hạn: 768P $0.08/s x 5s = $0.40 x 26.000đ/USD = 10.400đ.
update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (model_config->'video_models') || '[{"key": "h3-max", "provider": "MINIMAX", "label": "MiniMax H3 Max (tự sinh giọng nói)", "model": "minimax/h3-max/image-to-video", "provider_cost_vnd": 10400, "enabled": true, "aspect_ratios": ["9:16", "16:9", "1:1"], "duration_price_vnd": {"5": 10400}}]'::jsonb
)
where id = 'video-tu-y-tuong';
