import { getSupabaseAdmin } from "@/lib/supabase";

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
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { data: dev } = await supabase.from("developers").select("id").eq("user_id", userId).maybeSingle();
  if (!dev) return Response.json({ apps: [] });

  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, description, category, credit_cost, review_status, created_at")
    .eq("developer_id", dev.id)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ apps: data ?? [] });
}

export async function POST(req: Request) {
  const { userId, name, description, category, creditCost, endpointUrl, apiKey } = await req.json();

  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });
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
    return Response.json({ error: "Giá đề xuất phải là số nguyên dương" }, { status: 400 });
  }
  if (typeof endpointUrl !== "string" || !/^https:\/\//.test(endpointUrl)) {
    return Response.json({ error: "Endpoint phải là URL https hợp lệ (Workflow Dify)" }, { status: 400 });
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return Response.json({ error: "Thiếu API key" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  const { data: dev } = await supabase
    .from("developers")
    .select("id, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (!dev) return Response.json({ error: "Chưa đăng ký làm nhà phát triển" }, { status: 403 });
  if (dev.status !== "approved") {
    return Response.json({ error: "Tài khoản nhà phát triển chưa được duyệt" }, { status: 403 });
  }

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
    developer_id: dev.id,
    review_status: "pending_review",
    is_active: false, // ẩn khỏi danh mục công khai cho tới khi admin duyệt xong
    model_config: {
      integration_mode: "dify",
      endpoint_url: endpointUrl.trim(),
      api_key: apiKey.trim(),
    },
  });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, id });
}
