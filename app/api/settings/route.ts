import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("site_settings")
    .select("signup_bonus_credits, promo_banner_enabled")
    .eq("id", 1)
    .single();

  if (error || !data) {
    return Response.json({ signupBonusCredits: 20, promoBannerEnabled: true });
  }

  return Response.json({
    signupBonusCredits: data.signup_bonus_credits,
    promoBannerEnabled: data.promo_banner_enabled,
  });
}
