import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, description, category, credit_cost, developers(display_name)")
    .eq("is_active", true)
    .eq("review_status", "approved")
    .not("developer_id", "is", null)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const apps = (data ?? []).map((row) => {
    const dev = row.developers as unknown as { display_name: string } | { display_name: string }[] | null;
    const developerName = Array.isArray(dev) ? dev[0]?.display_name : dev?.display_name;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      creditCost: row.credit_cost,
      developerName: developerName ?? "Ẩn danh",
    };
  });

  return Response.json({ apps });
}
