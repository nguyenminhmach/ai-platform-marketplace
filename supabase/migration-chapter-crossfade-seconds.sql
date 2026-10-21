-- Migration: thêm cột còn thiếu chapter_crossfade_seconds vào site_settings — code (lib/pricing.ts
-- getChapterCrossfadeSeconds, app/api/admin/settings/route.ts, app/admin/page.tsx) đã dùng cột này từ
-- trước nhưng chưa từng có migration thật tạo nó trong DB, gây lỗi "Could not find the
-- 'chapter_crossfade_seconds' column of 'site_settings' in the schema cache" khi lưu cấu hình ở /admin.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run.

alter table site_settings add column if not exists chapter_crossfade_seconds numeric(4, 2) not null default 0.4;
