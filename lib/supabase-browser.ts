import { createBrowserClient } from "@supabase/ssr";

// Dùng anon key — an toàn để chạy trong trình duyệt (chỉ dùng cho đăng nhập/đăng ký). Trước đây dùng
// createClient() trơn từ @supabase/supabase-js — session lưu ở localStorage, server KHÔNG BAO GIỜ nhận
// được cookie xác thực nào dù cùng origin, khiến toàn bộ API route phải "tin" userId client tự gửi lên
// mà không xác thực được. Đổi sang createBrowserClient() (lưu session qua cookie) để server có thể tự
// xác thực đúng người gọi qua lib/auth-server.ts — không đổi API .auth.getSession()/.auth.signOut()/...
// nên lib/auth-context.tsx không cần sửa gì. Đánh đổi: user đang đăng nhập (session cũ ở localStorage)
// sẽ bị đăng xuất 1 lần khi bản này lên production, cần đăng nhập lại.
// Fallback placeholder tránh crash lúc build/prerender khi env var chưa được set (vd. build đầu tiên
// trên Vercel trước khi thêm env var qua Dashboard) — giá trị thật luôn có mặt lúc chạy trên trình duyệt.
export const supabaseBrowser = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key"
);
