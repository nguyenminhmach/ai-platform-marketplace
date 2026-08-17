-- Migration: app "Video trước/sau" — 2 ảnh bắt buộc (trước + sau), Kling nối chuyển cảnh mượt giữa
-- 2 trạng thái. Tái dùng đúng model + hạ tầng video_jobs của "Tạo video quảng cáo ngắn"
-- (lib/ai-router.ts đã sẵn xử lý cả image_url lẫn tail_image_url cùng lúc, không cần sửa code backend).
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

insert into mini_apps (id, name, description, category, credit_cost, model_config) values
  (
    'video-truoc-sau',
    'Video trước/sau',
    'Tải ảnh "trước" + ảnh "sau", AI tạo video chuyển cảnh mượt mà từ trạng thái này sang trạng thái kia — phù hợp quảng cáo mỹ phẩm/làm đẹp, video đổi trang phục, unboxing sản phẩm.',
    'video',
    23,
    '{"model": "fal-ai/kling-video/v1.6/standard/image-to-video", "output_type": "video", "provider_cost_vnd": 7300}'
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  credit_cost = excluded.credit_cost,
  model_config = excluded.model_config,
  is_active = true;
