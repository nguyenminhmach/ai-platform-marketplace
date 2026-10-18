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

// SỬA (phản hồi thật user + tự tay đo được): tải ảnh base64 ~800KB lên /api/outfit-swap/upload (gọi
// TRỰC TIẾP, không qua trình duyệt, KHÔNG đăng nhập) bị treo đúng 30 giây rồi timeout — còn ảnh test
// vài chục byte thì phản hồi 1.5 giây. Đổi 1 biến số duy nhất (dung lượng body) là tái hiện được lỗi
// ngay, loại hẳn khả năng mạng/phiên đăng nhập/tiện ích mở rộng (đã loại từng cái một với user trước
// đó). Route handler tự nó phản hồi nhanh khi gọi thẳng — nên nghi ngờ đổ vào đúng middleware này: chạy
// TRƯỚC route handler, matcher cũ áp dụng cho CẢ /api/* nên mọi request upload base64 lớn đều phải qua
// đây trước, dù middleware không đọc body (chỉ đụng cookie) vẫn có thể bị Next.js buffer/forward body
// kém hiệu quả qua lớp middleware khi body lớn (hành vi runtime, không thấy được từ đọc code).
//
// Loại hẳn /api/* khỏi middleware — mỗi route /api/* đã tự gọi getAuthenticatedUserId() (đọc cookie +
// getUser() riêng) độc lập, không phụ thuộc vào việc middleware này có refresh token hộ trước hay
// không; trường hợp xấu nhất (token vừa hết hạn, chưa kịp middleware làm mới) là route trả 401 "Chưa
// đăng nhập" — lỗi NHÌN THẤY ĐƯỢC, khách tải lại trang là hết, tốt hơn nhiều so với treo im lặng 30
// giây cho MỌI lần tải ảnh. Middleware vẫn giữ nguyên cho các trang thường (page routes) — mục đích
// gốc (làm mới token để khách không bị "biến mất" job khi quay lại sau khi đóng tab lâu) vẫn áp dụng
// đúng ở đó, chỉ bỏ áp dụng cho /api/*.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
