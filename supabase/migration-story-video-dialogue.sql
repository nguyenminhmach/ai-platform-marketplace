-- Migration: lời thoại có giọng nói cho từng cảnh của "Video từ ý tưởng truyện".
-- Tái dùng đúng pipeline đã chạy tốt trong dialogue_video: Kling image-to-video (câm, đã có sẵn)
-- -> ElevenLabs TTS -> Kling LipSync (fal-ai/kling-video/lipsync/audio-to-video) khớp môi.
-- Chỉ áp dụng cho cảnh có ĐÚNG 1 nhân vật trong khung hình (xem plan để biết lý do giới hạn).
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán toàn bộ -> Run.

alter table story_video_scenes add column if not exists dialogue_line text;
alter table story_video_scenes add column if not exists dialogue_speaker_position integer;
alter table story_video_scenes add column if not exists dialogue_audio_url text;
alter table story_video_scenes add column if not exists lipsync_fal_request_id text;
alter table story_video_scenes add column if not exists lipsync_url text;

alter table story_video_jobs add column if not exists lipsync_credit_tx_id bigint references credit_transactions(id);

-- lipsync_provider_cost_vnd là số ước tính ban đầu (VND/cảnh có thoại) — admin chỉnh lại sau khi có
-- số liệu thật, hiện trong bảng "Chi phí Fal.ai thật" (app/api/admin/story-video-costs/route.ts).
update mini_apps
set model_config = model_config || '{"lipsync_model": "fal-ai/kling-video/lipsync/audio-to-video", "lipsync_provider_cost_vnd": 9000}'::jsonb
where id = 'video-tu-y-tuong';
