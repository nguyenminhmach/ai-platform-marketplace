import { randomBytes, timingSafeEqual } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";

export const ADMIN_COOKIE_NAME = "admin_session";
const ADMIN_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 ngày

function getAdminPassword(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    // Không còn fallback "123456" — thiếu biến môi trường thì chặn hẳn thay vì âm thầm
    // chạy với mật khẩu mặc định ai cũng đoán được (lỗ hổng cũ, xem project_ai_platform_auth_hardening).
    throw new Error(
      "ADMIN_PASSWORD chưa được set — điền vào .env.local (local) hoặc Vercel Project Settings (production)."
    );
  }
  return password;
}

export function verifyAdminPassword(password: string): boolean {
  const expected = getAdminPassword();
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Trước đây token = sha256(password + salt cố định) — MỌI phiên đăng nhập ra cùng 1 token,
// nên "đăng xuất" chỉ xoá cookie phía trình duyệt chứ không vô hiệu hoá được token đó (ai giữ
// được token cũ vẫn dùng lại được vô thời hạn). Giờ mỗi lần đăng nhập sinh 1 token ngẫu nhiên
// (không suy ra được từ mật khẩu), lưu server-side trong Supabase — đăng xuất = xoá row, token
// cũ ngay lập tức vô giá trị dù ai đó có giữ lại.
export async function createAdminSession(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_MAX_AGE_MS).toISOString();

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("admin_sessions").insert({ token, expires_at: expiresAt });
  if (error) throw new Error(`Không tạo được admin session: ${error.message}`);

  return token;
}

export async function verifyAdminToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_sessions")
    .select("expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return false;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    // Hết hạn — dọn luôn row này, không chờ cron riêng (bảng nhỏ, tần suất đăng nhập admin thấp).
    await supabase.from("admin_sessions").delete().eq("token", token);
    return false;
  }
  return true;
}

// Gọi khi logout — xoá session khỏi Supabase để token cũ không thể dùng lại được nữa.
export async function revokeAdminSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const supabase = getSupabaseAdmin();
  await supabase.from("admin_sessions").delete().eq("token", token);
}

export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: ADMIN_SESSION_MAX_AGE_MS / 1000,
};
