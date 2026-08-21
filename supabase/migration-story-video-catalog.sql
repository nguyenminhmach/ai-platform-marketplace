-- Migration: nâng "Video từ ý tưởng truyện" từ 1 model cố định + 1 ảnh nhân vật lên catalog nhiều
-- nhà cung cấp (giống Genful) + tối đa 3 ảnh nhân vật + tối đa 8 phân cảnh. App chưa có job thật nào
-- chạy nên an toàn để đổi thẳng cấu trúc cột, không cần giữ dữ liệu cũ (cùng tiền lệ
-- migration-dialogue-video-multi-character.sql). Cách dùng: Supabase Dashboard -> SQL Editor -> dán
-- toàn bộ -> Run.

alter table story_video_jobs drop column if exists character_image_url;
alter table story_video_jobs add column if not exists character_image_urls text[] not null default '{}';
alter table story_video_jobs alter column character_image_urls drop default;

-- Snapshot model Fal.ai thật đã dùng lúc submit (không tra lại model_config mỗi lần cần, vì admin có
-- thể sửa/tắt catalog giữa lúc job đang chạy — bước poll fallback phải dùng đúng model đã submit).
alter table story_video_jobs add column if not exists image_model text;
alter table story_video_jobs add column if not exists video_model text;

alter table story_video_jobs drop constraint if exists story_video_jobs_num_scenes_check;
alter table story_video_jobs add constraint story_video_jobs_num_scenes_check check (num_scenes between 2 and 8);

-- Catalog nhiều nhà cung cấp cho model ảnh/video — thay thế 2 field cố định "image_model"/"video_model"
-- cũ. Mỗi entry: key (định danh nội bộ), provider (nhóm hiển thị dropdown), label, model (Fal.ai model
-- id thật), provider_cost_vnd (giá vốn/cảnh), multi_image (model có nhận nhiều ảnh tham chiếu cùng lúc
-- không — quyết định gửi "image_url" hay "image_urls" khi gọi Fal.ai), enabled.
update mini_apps
set model_config = (model_config - 'image_model' - 'video_model' - 'provider_cost_vnd_per_scene_image' - 'provider_cost_vnd_per_scene_video') || '{
  "image_models": [
    {"key": "flux-kontext", "provider": "BFL", "label": "Flux Kontext", "model": "fal-ai/flux-pro/kontext", "provider_cost_vnd": 1000, "multi_image": false, "enabled": true},
    {"key": "nano-banana-pro", "provider": "GOOGLE", "label": "Nano Banana Pro Edit", "model": "fal-ai/gemini-3-pro-image-preview/edit", "provider_cost_vnd": 1800, "multi_image": true, "enabled": true}
  ],
  "video_models": [
    {"key": "kling-1.6", "provider": "KLING", "label": "Kling v1.6 Standard", "model": "fal-ai/kling-video/v1.6/standard/image-to-video", "provider_cost_vnd": 7300, "enabled": true},
    {"key": "ltx-2.3", "provider": "LTX", "label": "LTX-2.3 Fast", "model": "fal-ai/ltx-2.3/image-to-video/fast", "provider_cost_vnd": 6240, "enabled": true}
  ]
}'::jsonb
where id = 'video-tu-y-tuong';
