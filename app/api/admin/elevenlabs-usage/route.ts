import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// Gọi thẳng ElevenLabs API bằng ELEVENLABS_API_KEY của server để xem còn bao nhiêu ký tự trong gói —
// admin không cần tự vào dashboard ElevenLabs, cũng không cần dán API key ra bất kỳ đâu ngoài .env.
export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Chưa cấu hình ELEVENLABS_API_KEY trên server" }, { status: 500 });
  }

  const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown ElevenLabs error");
    return Response.json({ error: `ElevenLabs lỗi: ${res.status} ${errText}` }, { status: 502 });
  }

  const data = await res.json();
  return Response.json({
    tier: data.tier,
    characterCount: data.character_count,
    characterLimit: data.character_limit,
    remaining: data.character_limit - data.character_count,
    nextResetUnix: data.next_character_count_reset_unix,
    status: data.status,
  });
}
