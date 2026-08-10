import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("site_settings")
    .select(
      "signup_bonus_credits, promo_banner_enabled, subscription_enabled, subscription_price_vnd, subscription_duration_days, media_margin_percent, vnd_per_credit"
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
      mediaMarginPercent: 50,
      vndPerCredit: 490,
    });
  }

  return Response.json({
    signupBonusCredits: data.signup_bonus_credits,
    promoBannerEnabled: data.promo_banner_enabled,
    subscriptionEnabled: data.subscription_enabled,
    subscriptionPriceVnd: data.subscription_price_vnd,
    subscriptionDurationDays: data.subscription_duration_days,
    mediaMarginPercent: data.media_margin_percent,
    vndPerCredit: data.vnd_per_credit,
  });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const {
    signupBonusCredits,
    promoBannerEnabled,
    subscriptionEnabled,
    subscriptionPriceVnd,
    subscriptionDurationDays,
    mediaMarginPercent,
    vndPerCredit,
  } = await req.json();

  if (typeof signupBonusCredits !== "number" || signupBonusCredits < 0) {
    return Response.json({ error: "signupBonusCredits phải là số không âm" }, { status: 400 });
  }
  if (typeof promoBannerEnabled !== "boolean") {
    return Response.json({ error: "promoBannerEnabled phải là true/false" }, { status: 400 });
  }
  if (typeof subscriptionEnabled !== "boolean") {
    return Response.json({ error: "subscriptionEnabled phải là true/false" }, { status: 400 });
  }
  if (typeof subscriptionPriceVnd !== "number" || subscriptionPriceVnd < 0) {
    return Response.json({ error: "subscriptionPriceVnd phải là số không âm" }, { status: 400 });
  }
  if (typeof subscriptionDurationDays !== "number" || subscriptionDurationDays <= 0) {
    return Response.json({ error: "subscriptionDurationDays phải là số dương" }, { status: 400 });
  }
  if (typeof mediaMarginPercent !== "number" || mediaMarginPercent < 0) {
    return Response.json({ error: "mediaMarginPercent phải là số không âm" }, { status: 400 });
  }
  if (typeof vndPerCredit !== "number" || vndPerCredit <= 0) {
    return Response.json({ error: "vndPerCredit phải là số dương" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("site_settings")
    .update({
      signup_bonus_credits: signupBonusCredits,
      promo_banner_enabled: promoBannerEnabled,
      subscription_enabled: subscriptionEnabled,
      subscription_price_vnd: subscriptionPriceVnd,
      subscription_duration_days: subscriptionDurationDays,
      media_margin_percent: mediaMarginPercent,
      vnd_per_credit: vndPerCredit,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}
