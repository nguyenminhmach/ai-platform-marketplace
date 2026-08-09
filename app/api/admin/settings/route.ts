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

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { signupBonusCredits, promoBannerEnabled } = await req.json();

  if (typeof signupBonusCredits !== "number" || signupBonusCredits < 0) {
    return Response.json({ error: "signupBonusCredits phải là số không âm" }, { status: 400 });
  }
  if (typeof promoBannerEnabled !== "boolean") {
    return Response.json({ error: "promoBannerEnabled phải là true/false" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("site_settings")
    .update({
      signup_bonus_credits: signupBonusCredits,
      promo_banner_enabled: promoBannerEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}
