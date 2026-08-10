import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("site_settings")
    .select(
      "signup_bonus_credits, promo_banner_enabled, subscription_enabled, subscription_price_vnd, subscription_duration_days"
    )
    .eq("id", 1)
    .single();

  if (error || !data) {
    return Response.json({
      signupBonusCredits: 20,
      promoBannerEnabled: true,
      subscriptionEnabled: false,
      subscriptionPriceVnd: 499000,
      subscriptionDurationDays: 30,
    });
  }

  return Response.json({
    signupBonusCredits: data.signup_bonus_credits,
    promoBannerEnabled: data.promo_banner_enabled,
    subscriptionEnabled: data.subscription_enabled,
    subscriptionPriceVnd: data.subscription_price_vnd,
    subscriptionDurationDays: data.subscription_duration_days,
  });
}
