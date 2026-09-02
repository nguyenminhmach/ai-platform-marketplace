import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const miniAppId = searchParams.get("miniAppId");

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("generation_history")
    .select("id, mini_app_id, output_type, output_url, created_at, mini_apps(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (miniAppId) query = query.eq("mini_app_id", miniAppId);
  const { data, error } = await query;

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const items = (data ?? []).map((row) => {
    const app = row.mini_apps as unknown as { name: string } | { name: string }[] | null;
    const appName = Array.isArray(app) ? app[0]?.name : app?.name;
    return {
      id: row.id,
      miniAppId: row.mini_app_id,
      miniAppName: appName ?? row.mini_app_id,
      outputType: row.output_type,
      outputUrl: row.output_url,
      createdAt: row.created_at,
    };
  });

  return Response.json({ items });
}
