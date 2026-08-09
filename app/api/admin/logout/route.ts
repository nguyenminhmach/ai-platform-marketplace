import { ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

export async function POST() {
  const cookie = `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
  return Response.json({ success: true }, { headers: { "Set-Cookie": cookie } });
}
