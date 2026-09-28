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

// Tỷ giá quy đổi USD -> VND — dùng khi tính hoa hồng nhà phát triển từ actual_cost_usd họ tự báo cáo (Tập 8 mục 3.3)
export async function getUsdToVndRate(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("site_settings").select("usd_to_vnd_rate").eq("id", 1).single();
  return data?.usd_to_vnd_rate ?? 26000;
}

// Thời lượng hoà mờ (giây) khi nối các CHƯƠNG trong Video nhiều chương — admin chỉnh trong /admin, xem
// stitchChapterVideos (lib/story-video.ts). Trước đây hard-code 0.4s, giờ đọc từ site_settings.
export async function getChapterCrossfadeSeconds(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("site_settings").select("chapter_crossfade_seconds").eq("id", 1).single();
  return data?.chapter_crossfade_seconds ?? 0.4;
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
