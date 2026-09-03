-- Migration: sửa catalog "VEO 3.1 Lite (chuyển động liên tục)" — chỉ còn đúng 1 mức thời lượng 8s.
--
-- Lỗi thật: migration-story-video-veo31-lite-flf.sql trước đó thêm 3 mức (4s/6s/8s) dựa theo suy đoán
-- (trang docs Fal.ai không ghi rõ enum cho model FLF này, khác các model Veo thường). Khách chọn 4s
-- gặp lỗi 422 liên tục từ Fal.ai: "Đầu vào phải là '8s'" — xác nhận qua dashboard Fal.ai thật, model
-- FLF này CHỈ nhận đúng "8s", không có mức nào khác. Code (buildVideoRequestBody) đã ép cứng "8s" rồi,
-- migration này chỉ dọn lại catalog cho khớp, tránh dropdown hiện các mức sai.
--
-- Giá 8s = $0.03/s x 8s x 26.000đ/USD = 6.240đ (giữ nguyên số đã tính đúng từ trước).
--
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

update mini_apps
set model_config = jsonb_set(
  model_config,
  '{video_models}',
  (
    select jsonb_agg(
      case
        when elem->>'key' = 'veo31-lite-flf'
          then jsonb_set(elem, '{duration_price_vnd}', '{"8": 6240}'::jsonb)
        else elem
      end
    )
    from jsonb_array_elements(model_config->'video_models') as elem
  )
)
where id = 'video-tu-y-tuong';
