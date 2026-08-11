import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[^\x00-\x7F]/g, "") // bỏ dấu tiếng Việt (mọi ký tự ngoài ASCII sau khi tách dấu)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  // Chỉ liệt kê app đã duyệt (approved) — app dev đang chờ duyệt đã có mục "Duyệt nhà phát triển" riêng
  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, credit_cost, model_config, is_active, developer_id")
    .eq("review_status", "approved")
    .order("id");

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const apps = (data ?? []).map((app) => ({
    id: app.id,
    name: app.name,
    creditCost: app.credit_cost,
    isActive: app.is_active,
    ownApp: !app.developer_id,
    // dynamic = true nếu app này đã dùng công thức margin% (ảnh/video) — giá cố định bên dưới sẽ bị ghi đè, không sửa được qua đây
    dynamic: !!(app.model_config as { provider_cost_vnd?: number } | null)?.provider_cost_vnd,
  }));

  return Response.json({ apps });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id, creditCost, isActive } = await req.json();
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "Thiếu id" }, { status: 400 });
  }
  if (creditCost === undefined && isActive === undefined) {
    return Response.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (creditCost !== undefined) {
    if (typeof creditCost !== "number" || creditCost <= 0 || !Number.isInteger(creditCost)) {
      return Response.json({ error: "creditCost phải là số nguyên dương" }, { status: 400 });
    }
    update.credit_cost = creditCost;
  }
  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      return Response.json({ error: "isActive phải là true/false" }, { status: 400 });
    }
    update.is_active = isActive;
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("mini_apps").update(update).eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}

// Admin tự tạo Mini App dạng văn bản mới (nhập text -> AI trả lời bằng text, gọi OpenRouter) —
// tự chủ không cần chờ code. App dạng ảnh/video vẫn cần code riêng do UI upload + hạ tầng job khác hẳn.
export async function POST(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { name, description, category, creditCost, model, systemPrompt } = await req.json();

  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "Thiếu tên Mini App" }, { status: 400 });
  }
  if (typeof description !== "string" || !description.trim()) {
    return Response.json({ error: "Thiếu mô tả" }, { status: 400 });
  }
  if (!["anh", "van-ban", "video", "am-thanh"].includes(category)) {
    return Response.json({ error: "Danh mục không hợp lệ" }, { status: 400 });
  }
  if (typeof creditCost !== "number" || creditCost <= 0 || !Number.isInteger(creditCost)) {
    return Response.json({ error: "Giá phải là số nguyên dương" }, { status: 400 });
  }
  if (typeof model !== "string" || !model.trim()) {
    return Response.json({ error: "Thiếu model" }, { status: 400 });
  }
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    return Response.json({ error: "Thiếu hướng dẫn cho AI (system prompt)" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  const baseSlug = slugify(name) || "mini-app";
  let id = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: exists } = await supabase.from("mini_apps").select("id").eq("id", id).maybeSingle();
    if (!exists) break;
    suffix += 1;
    id = `${baseSlug}-${suffix}`;
  }

  const { error } = await supabase.from("mini_apps").insert({
    id,
    name: name.trim(),
    description: description.trim(),
    category,
    credit_cost: creditCost,
    developer_id: null,
    review_status: "approved",
    is_active: true,
    model_config: {
      model: model.trim(),
      max_tokens: 500,
      system_prompt: systemPrompt.trim(),
    },
  });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, id });
}
