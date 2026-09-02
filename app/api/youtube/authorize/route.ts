import { getYoutubeAuthUrl } from "@/lib/youtube";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Redirect user sang màn hình Google xin quyền đăng video. Gọi bằng cách điều hướng trình duyệt
// thẳng tới route này (không phải fetch), vì cần redirect cả trang.
//
// userId LUÔN lấy từ session đã xác thực (cookie), KHÔNG tin query param client tự gửi — trước đây ai
// biết userId người khác đều tự gọi route này (?userId=<uuid nạn nhân>), tự đăng nhập YouTube của
// MÌNH vào đó, khiến video nạn nhân "đăng lên YouTube" sau này chạy thẳng vào kênh kẻ tấn công. Vì
// state (dùng ở callback) giờ luôn = userId đã xác thực, không cần thêm nonce CSRF riêng.
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  try {
    const url = getYoutubeAuthUrl(userId);
    return Response.redirect(url);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
