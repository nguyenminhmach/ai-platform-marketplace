import { getSupabaseAdmin } from "@/lib/supabase";

export type MediaPricingSettings = { marginPercent: number; vndPerCredit: number };

export async function getMediaPricingSettings(): Promise<MediaPricingSettings> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("site_settings")
    .select("media_margin_percent, vnd_per_credit")
    .eq("id", 1)
    .single();

  return {
    marginPercent: data?.media_margin_percent ?? 50,
    vndPerCredit: data?.vnd_per_credit ?? 490,
  };
}

// credit_cost = giá vốn thật (VND) x (1 + biên lợi nhuận%) / giá quy đổi 1 credit ra VND, làm tròn lên
export function computeDynamicCreditCost(
  providerCostVnd: number,
  marginPercent: number,
  vndPerCredit: number
): number {
  const sellPriceVnd = providerCostVnd * (1 + marginPercent / 100);
  return Math.max(1, Math.ceil(sellPriceVnd / vndPerCredit));
}
