-- Frame-chaining — lưới an toàn lớp 2: đếm số lần đã vẽ lại 1 cảnh do AI phát hiện sai danh tính
-- (checkSceneIdentityMatch), trước khi quay về ảnh Character gốc làm phương án dự phòng cuối cùng —
-- xem applyFrameChainImageResult() trong lib/story-video.ts.
alter table story_video_scenes add column if not exists identity_retry_count integer not null default 0;
