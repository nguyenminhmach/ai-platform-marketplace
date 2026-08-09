import { createHash, timingSafeEqual } from "crypto";

export const ADMIN_COOKIE_NAME = "admin_session";
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 ngày

function getAdminPassword(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn("[admin-auth] ADMIN_PASSWORD chưa được set trong .env.local — dùng mặc định 123456, KHÔNG an toàn cho production");
    return "123456";
  }
  return password;
}

function expectedToken(): string {
  return createHash("sha256").update(`${getAdminPassword()}:ai-marketplace-admin`).digest("hex");
}

export function verifyAdminPassword(password: string): boolean {
  const expected = getAdminPassword();
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdminToken(): string {
  return expectedToken();
}

export function verifyAdminToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = expectedToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: ADMIN_COOKIE_MAX_AGE,
};
