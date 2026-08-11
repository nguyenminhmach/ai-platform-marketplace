-- Migration: gộp hàng "Mô tả/Tóm tắt/Caption/Dịch/Cảm xúc" và hàng "Tất cả/Ảnh/Văn bản/..."
-- thành 1 hàng chip duy nhất trên trang chủ, thêm chip "Markets" ở cuối, và cho admin
-- sắp xếp thứ tự + xoá bớt chip qua /admin.
-- Cách dùng: Supabase Dashboard → SQL Editor → dán toàn bộ file này → Run

alter table site_settings add column if not exists homepage_chips jsonb not null default '[
  {"id": "cat-tat-ca", "type": "category", "label": "Tất cả", "value": "tat-ca"},
  {"id": "cat-anh", "type": "category", "label": "Ảnh", "value": "anh"},
  {"id": "cat-van-ban", "type": "category", "label": "Văn bản", "value": "van-ban"},
  {"id": "cat-video", "type": "category", "label": "Video", "value": "video"},
  {"id": "cat-am-thanh", "type": "category", "label": "Âm thanh", "value": "am-thanh"},
  {"id": "search-mo-ta", "type": "search", "label": "Mô tả", "value": "mô tả sản phẩm"},
  {"id": "search-tom-tat", "type": "search", "label": "Tóm tắt", "value": "tóm tắt văn bản"},
  {"id": "search-caption", "type": "search", "label": "Caption", "value": "caption"},
  {"id": "search-dich", "type": "search", "label": "Dịch", "value": "dịch"},
  {"id": "search-cam-xuc", "type": "search", "label": "Cảm xúc", "value": "cảm xúc"},
  {"id": "link-markets", "type": "link", "label": "Markets", "value": "/markets"}
]'::jsonb;
