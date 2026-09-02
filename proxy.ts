import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refresh session Supabase (access token) trên MỌI request — Server Component/Route Handler không tự
// ghi lại cookie mới được, cần proxy này làm việc đó. Không có proxy này thì sau khi access token hết
// hạn (mặc định ~1h), getAuthenticatedUserId() (lib/auth-server.ts) sẽ liên tục trả null dù user vẫn
// đang "đăng nhập" trên UI, vì refresh token không bao giờ được dùng để lấy access token mới.
// Next.js 16 đổi tên quy ước file này từ middleware.ts -> proxy.ts (export function cũng đổi tên theo,
// hành vi/config giữ nguyên) — xem https://nextjs.org/docs/messages/middleware-to-proxy.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // Gọi getUser() (không phải getSession()) — bắt buộc để trigger refresh token thật sự qua Supabase
  // Auth server khi access token sắp/đã hết hạn, đồng thời tự ghi lại cookie mới qua setAll() ở trên.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
