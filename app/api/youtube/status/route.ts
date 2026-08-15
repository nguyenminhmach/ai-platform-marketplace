import { isYoutubeConnected } from "@/lib/youtube";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  const result = await isYoutubeConnected(userId);
  return Response.json(result);
}
