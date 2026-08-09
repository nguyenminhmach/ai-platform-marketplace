import { createClient } from "@supabase/supabase-js";

// Dùng service_role key — chỉ được gọi từ code phía server (API routes), KHÔNG bao giờ đưa xuống client
export function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Chưa cấu hình Supabase — điền NEXT_PUBLIC_SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY vào .env.local"
    );
  }

  return createClient(url, serviceRoleKey);
}
