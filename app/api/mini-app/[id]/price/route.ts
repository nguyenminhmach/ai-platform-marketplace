import { getSupabaseAdmin } from "@/lib/supabase";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("mini_apps")
    .select("credit_cost, model_config")
    .eq("id", id)
    .single();

  if (error || !data) {
    return Response.json({ error: "Không tìm thấy Mini App" }, { status: 404 });
  }

  // Prompt mặc định (nếu admin đã soạn) — tự điền vào ô mô tả cho app video-gen, khách vẫn sửa được.
  const defaultPrompt: string | null = data.model_config?.default_prompt || null;

  const providerCostVnd = data.model_config?.provider_cost_vnd;
  if (!providerCostVnd) {
    return Response.json({ creditCost: data.credit_cost, dynamic: false, defaultPrompt });
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const creditCost = computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);
  return Response.json({ creditCost, dynamic: true, defaultPrompt });
}
