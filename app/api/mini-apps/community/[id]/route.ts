import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, description, category, credit_cost, developers(display_name)")
    .eq("id", id)
    .eq("is_active", true)
    .eq("review_status", "approved")
    .not("developer_id", "is", null)
    .single();

  if (error || !data) {
    return Response.json({ app: null });
  }

  const dev = data.developers as unknown as { display_name: string } | { display_name: string }[] | null;
  const developerName = Array.isArray(dev) ? dev[0]?.display_name : dev?.display_name;

  return Response.json({
    app: {
      id: data.id,
      name: data.name,
      description: data.description,
      category: data.category,
      creditCost: data.credit_cost,
      developerName: developerName ?? "Ẩn danh",
    },
  });
}
