import { getSupabaseAdmin } from "@/lib/supabase";
import { MINI_APPS } from "@/lib/mock-mini-apps";

// Cho trang chủ biết: (1) app tĩnh nào admin đã ẩn (is_active=false) để lọc khỏi lưới hiển thị,
// (2) app admin tự thêm qua /admin (không có trong lib/mock-mini-apps.ts) để hiện thêm vào lưới.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const staticIds = new Set(MINI_APPS.map((app) => app.id));

  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, description, category, credit_cost, is_active, model_config")
    .is("developer_id", null)
    .eq("review_status", "approved");

  if (error) return Response.json({ inactiveIds: [], extraApps: [], demoImageUrls: {} });

  const inactiveIds: string[] = [];
  const extraApps: { id: string; name: string; description: string; category: string; creditCost: number }[] = [];
  const demoImageUrls: Record<string, string[]> = {};

  for (const row of data ?? []) {
    const urls = (row.model_config as { demo_image_urls?: string[] } | null)?.demo_image_urls;
    if (urls && urls.length > 0) demoImageUrls[row.id] = urls;

    if (staticIds.has(row.id)) {
      if (!row.is_active) inactiveIds.push(row.id);
    } else if (row.is_active) {
      extraApps.push({
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        creditCost: row.credit_cost,
      });
    }
  }

  return Response.json({ inactiveIds, extraApps, demoImageUrls });
}
