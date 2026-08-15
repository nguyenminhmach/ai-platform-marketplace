import { exchangeCodeAndSaveTokens } from "@/lib/youtube";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

// Google gọi vào đây sau khi user đồng ý cấp quyền — state chính là userId đã gửi lúc /authorize.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state");
  const error = searchParams.get("error");

  const backTo = `${SITE_URL}/mini-app/tao-video-quang-cao`;

  if (error) {
    return Response.redirect(`${backTo}?youtube=denied`);
  }
  if (!code || !userId) {
    return Response.redirect(`${backTo}?youtube=error`);
  }

  try {
    await exchangeCodeAndSaveTokens(code, userId);
    return Response.redirect(`${backTo}?youtube=connected`);
  } catch (err) {
    console.error("[youtube-callback]", err);
    return Response.redirect(`${backTo}?youtube=error`);
  }
}
