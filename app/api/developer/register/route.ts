import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function POST(req: Request) {
  const { displayName } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof displayName !== "string" || !displayName.trim()) {
    return Response.json({ error: "Thiếu tên hiển thị" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  const { data: existing } = await supabase
    .from("developers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) {
    return Response.json({ error: "Tài khoản này đã đăng ký làm nhà phát triển rồi" }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("developers")
    .insert({ user_id: userId, display_name: displayName.trim() })
    .select("id, status")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, id: data.id, status: data.status });
}
