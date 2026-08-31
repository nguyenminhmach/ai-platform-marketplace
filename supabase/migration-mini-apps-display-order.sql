-- Migration: thêm cột display_order cho mini_apps — cho admin tự sắp xếp thứ tự hiện trên trang chủ
-- (số nhỏ hơn hiện trước) thay vì cố định theo thứ tự khai báo trong lib/mock-mini-apps.ts. Backfill
-- đúng thứ tự HIỆN TẠI của 12 app tĩnh (cách nhau 10 để admin còn chỗ chèn app mới vào giữa), app khác
-- (app admin tự thêm/app dev) giữ mặc định 9999 để vẫn hiện sau như hành vi cũ, không đổi gì cho tới
-- khi admin chủ động sửa số thứ tự.
-- Cách dùng: Supabase Dashboard -> SQL Editor -> dán -> Run.

alter table mini_apps add column if not exists display_order integer not null default 9999;

update mini_apps set display_order = 10 where id = 'viet-mo-ta-san-pham';
update mini_apps set display_order = 20 where id = 'tom-tat-van-ban';
update mini_apps set display_order = 30 where id = 'viet-caption';
update mini_apps set display_order = 40 where id = 'dich-da-ngon-ngu';
update mini_apps set display_order = 50 where id = 'tao-anh-quang-cao';
update mini_apps set display_order = 60 where id = 'tao-video-quang-cao';
update mini_apps set display_order = 70 where id = 'video-truoc-sau';
update mini_apps set display_order = 80 where id = 'nhay-theo-video-mau';
update mini_apps set display_order = 90 where id = 'video-doi-thoai-nhan-vat';
update mini_apps set display_order = 100 where id = 'video-tu-y-tuong';
update mini_apps set display_order = 110 where id = 'thay-trang-phuc';
update mini_apps set display_order = 120 where id = 'phan-tich-cam-xuc';
