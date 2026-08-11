import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

type Chip = { id: string; type: "category" | "search" | "link"; label: string; value: string };

function isValidChips(chips: unknown): chips is Chip[] {
  if (!Array.isArray(chips)) return false;
  return chips.every(
    (c) =>
      c &&
      typeof c.id === "string" &&
      (c.type === "category" || c.type === "search" || c.type === "link") &&
      typeof c.label === "string" &&
      c.label.trim() !== "" &&
      typeof c.value === "string" &&
      c.value.trim() !== ""
  );
}

export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("site_settings").select("homepage_chips").eq("id", 1).single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ chips: data?.homepage_chips ?? [] });
}

export async function PUT(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { chips } = await req.json();
  if (!isValidChips(chips)) {
    return Response.json({ error: "Danh sách chip không hợp lệ" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("site_settings")
    .update({ homepage_chips: chips, updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}
