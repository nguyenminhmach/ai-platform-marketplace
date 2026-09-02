import { isYoutubeConnected } from "@/lib/youtube";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const result = await isYoutubeConnected(userId);
  return Response.json(result);
}
