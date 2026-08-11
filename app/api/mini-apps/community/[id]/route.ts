import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  // Không lọc developer_id — route này còn dùng chung cho app admin tự thêm qua /admin (developer_id null),
  // khác với /api/mini-apps/community (danh sách trang Markets) chỉ liệt kê app của nhà phát triển thứ 3.
  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, description, category, credit_cost, model_config, developers(display_name)")
    .eq("id", id)
    .eq("is_active", true)
    .eq("review_status", "approved")
    .single();

  if (error || !data) {
    return Response.json({ app: null });
  }

  const dev = data.developers as unknown as { display_name: string } | { display_name: string }[] | null;
  const developerName = Array.isArray(dev) ? dev[0]?.display_name : dev?.display_name;
  const outputType = (data.model_config as { output_type?: string } | null)?.output_type ?? "text";

  return Response.json({
    app: {
      id: data.id,
      name: data.name,
      description: data.description,
      category: data.category,
      creditCost: data.credit_cost,
      developerName: developerName ?? null,
      outputType,
    },
  });
}
