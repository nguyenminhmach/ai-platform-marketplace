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
    .from("mini_apps")
    .select("id, name, credit_cost, model_config")
    .eq("is_active", true)
    .order("id");

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const apps = (data ?? []).map((app) => ({
    id: app.id,
    name: app.name,
    creditCost: app.credit_cost,
    // dynamic = true nếu app này đã dùng công thức margin% (ảnh/video) — giá cố định bên dưới sẽ bị ghi đè, không sửa được qua đây
    dynamic: !!(app.model_config as { provider_cost_vnd?: number } | null)?.provider_cost_vnd,
  }));

  return Response.json({ apps });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id, creditCost } = await req.json();
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "Thiếu id" }, { status: 400 });
  }
  if (typeof creditCost !== "number" || creditCost <= 0 || !Number.isInteger(creditCost)) {
    return Response.json({ error: "creditCost phải là số nguyên dương" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("mini_apps").update({ credit_cost: creditCost }).eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}
