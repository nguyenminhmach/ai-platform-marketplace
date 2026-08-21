-- Migration: thêm "Độ phân giải" cho GPT Image 2 Edit — model này CÓ giá thật khác nhau theo độ
-- phân giải (đã kiểm tra fal.ai/models/fal-ai/gpt-image-2/edit: 1024px cao ~$0.219, 4K ~$0.413), nên
-- thêm được (khác Flux Kontext — đã kiểm tra fal.ai/models/fal-ai/flux-pro/kontext không có giá theo
-- resolution, giữ nguyên giá cố định, không thêm dropdown giả). Cách dùng: Supabase Dashboard -> SQL
-- Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{image_models}',
  (
    select jsonb_agg(
      case when entry->>'key' = 'gpt-image-2'
        then entry || '{"resolution_price_vnd": {"1024": 5700, "4K": 10700}}'::jsonb
        else entry
      end
    )
    from jsonb_array_elements(model_config->'image_models') as entry
  )
)
where id = 'video-tu-y-tuong';
