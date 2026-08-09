import { createClient } from "@supabase/supabase-js";

// Dùng anon key — an toàn để chạy trong trình duyệt (chỉ dùng cho đăng nhập/đăng ký)
// Fallback placeholder tránh crash lúc build/prerender khi env var chưa được set (vd. build đầu tiên
// trên Vercel trước khi thêm env var qua Dashboard) — giá trị thật luôn có mặt lúc chạy trên trình duyệt.
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key"
);
