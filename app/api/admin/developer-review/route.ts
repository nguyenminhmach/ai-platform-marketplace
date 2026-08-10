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

  const [{ data: pendingDevs, error: devError }, { data: pendingApps, error: appError }] = await Promise.all([
    supabase
      .from("developers")
      .select("id, display_name, status, created_at")
      .eq("status", "pending")
      .order("created_at"),
    supabase
      .from("mini_apps")
      .select("id, name, description, category, credit_cost, review_status, developer_id, created_at")
      .eq("review_status", "pending_review")
      .order("created_at"),
  ]);

  if (devError) return Response.json({ error: devError.message }, { status: 500 });
  if (appError) return Response.json({ error: appError.message }, { status: 500 });

  return Response.json({ pendingDevs: pendingDevs ?? [], pendingApps: pendingApps ?? [] });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { type, id, action } = await req.json();

  if (type !== "developer" && type !== "mini_app") {
    return Response.json({ error: "type phải là developer hoặc mini_app" }, { status: 400 });
  }
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: "action phải là approve hoặc reject" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  if (type === "developer") {
    const { error } = await supabase
      .from("developers")
      .update({ status: action === "approve" ? "approved" : "suspended" })
      .eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from("mini_apps")
      .update({
        review_status: action === "approve" ? "approved" : "rejected",
        is_active: action === "approve",
      })
      .eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
