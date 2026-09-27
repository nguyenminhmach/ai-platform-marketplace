import { ADMIN_COOKIE_NAME, revokeAdminSession } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

export async function POST(req: Request) {
  // Xoá session khỏi Supabase trước — nếu chỉ xoá cookie phía trình duyệt (như trước đây), token
  // cũ vẫn còn hợp lệ vô thời hạn với ai giữ được nó (log, network capture, máy dùng chung).
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  await revokeAdminSession(token);

  const cookie = `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
  return Response.json({ success: true }, { headers: { "Set-Cookie": cookie } });
}
