import { verifyAdminPassword, createAdminToken, adminCookieOptions, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

export async function POST(req: Request) {
  const { password } = await req.json();

  if (!password || typeof password !== "string" || !verifyAdminPassword(password)) {
    return Response.json({ error: "Sai mật khẩu" }, { status: 401 });
  }

  const token = createAdminToken();
  const cookie = `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Path=${adminCookieOptions.path}; Max-Age=${adminCookieOptions.maxAge}; SameSite=${adminCookieOptions.sameSite}${adminCookieOptions.secure ? "; Secure" : ""}`;

  return Response.json({ success: true }, { headers: { "Set-Cookie": cookie } });
}
