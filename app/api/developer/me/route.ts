import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("developers")
    .select("id, display_name, status, revenue_share_pct, created_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ developer: null });

  return Response.json({
    developer: {
      id: data.id,
      displayName: data.display_name,
      status: data.status,
      revenueSharePct: data.revenue_share_pct,
      createdAt: data.created_at,
    },
  });
}
