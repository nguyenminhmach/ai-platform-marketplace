import { getYoutubeAuthUrl } from "@/lib/youtube";

// Redirect user sang màn hình Google xin quyền đăng video. Gọi bằng cách điều hướng trình duyệt
// thẳng tới route này (không phải fetch), vì cần redirect cả trang.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  try {
    const url = getYoutubeAuthUrl(userId);
    return Response.redirect(url);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
