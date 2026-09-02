import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Xác thực người gọi thật sự đứng sau request (qua cookie session Supabase) — dùng trong MỌI route
// đọc/ghi dữ liệu gắn với 1 user cụ thể, THAY VÌ tin userId client tự gửi lên qua query/body (cách cũ
// cho phép giả mạo userId của người khác, xem plan "Xác thực session thật cho toàn bộ API"). Trả về
// null nếu chưa đăng nhập/session hết hạn — route gọi hàm này tự quyết định trả 401 khi null.
export async function getAuthenticatedUserId(): Promise<string | null> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        // Route Handler không cần ghi lại cookie — middleware.ts đã lo phần refresh token trước khi
        // request tới đây.
        setAll() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}
