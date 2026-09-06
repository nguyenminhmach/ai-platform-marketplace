import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Đổi tên từ "proxy.ts" (bản gốc lúc làm "auth hardening") sang "middleware.ts" — ĐÃ VERIFY THẬT bằng
// build: đặt tên "proxy.ts" (export "proxy", theo đúng cảnh báo deprecated của Next.js 16) bị Next.js
// ÂM THẦM BỎ QUA hoàn toàn trong bản cài ở đây (.next/server/middleware-manifest.json rỗng, không có
// route nào chạy qua nó dù build "thành công" không báo lỗi gì) — chỉ tên cũ "middleware.ts" (export
// "middleware") mới thực sự được Next.js nhận và đưa vào manifest. Hệ quả: tính năng làm mới session
// bên dưới CHƯA TỪNG chạy thật trên production từ lúc viết ("Giai đoạn A") tới giờ — đây chính là
// nguyên nhân job "biến mất" khi khách đóng tab đủ lâu rồi mở lại: access token Supabase hết hạn (~1
// giờ) chỉ được browser client tự làm mới NGẦM sau khi đã set "user" từ session cũ trong bộ nhớ cache —
// API route (getAuthenticatedUserId) vẫn nhận đúng cookie access token CŨ (đã hết hạn) nếu request bắn
// đi trước khi kịp làm mới, trả về "chưa đăng nhập" dù khách nhìn thấy vẫn đang đăng nhập trên giao
// diện. Middleware này chạy TRƯỚC mọi route (kể cả /api/*), tự gọi getUser() để ép làm mới token nếu
// cần rồi ghi đè cookie mới vào cả request lẫn response — đảm bảo route handler phía sau luôn nhận đúng
// token còn hạn.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // Gọi getUser() (không phải getSession()) — bắt buộc phải hỏi lại Supabase Auth server, đây là bước
  // thật sự kích hoạt làm mới access token khi đã hết hạn (getSession() chỉ đọc cookie hiện có, không
  // tự làm mới). Không cần dùng kết quả trả về ở đây — route handler phía sau (getAuthenticatedUserId)
  // sẽ tự gọi lại getUser() của riêng nó với cookie đã được làm mới.
  await supabase.auth.getUser();

  return response;
}

// Chạy trên MỌI route (kể cả /api/*) trừ file tĩnh — route admin (/admin/*) không bị ảnh hưởng vì chỉ
// dùng cookie mật khẩu riêng (lib/admin-auth.ts), proxy này chỉ đụng tới cookie Supabase.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
