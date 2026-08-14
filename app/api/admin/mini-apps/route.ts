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

  const apps = (data ?? []).map((app) => {
    const config = app.model_config as
      | { provider_cost_vnd?: number; demo_image_urls?: string[]; models?: Record<string, { enabled: boolean }> }
      | null;
    return {
      id: app.id,
      name: app.name,
      creditCost: app.credit_cost,
      isActive: app.is_active,
      ownApp: !app.developer_id,
      // dynamic = true nếu app này đã dùng công thức margin% (ảnh/video, kể cả app nhiều model như
      // "Thay trang phục") — giá cố định bên dưới sẽ bị ghi đè, không sửa được qua đây
      dynamic: !!config?.provider_cost_vnd || !!config?.models,
      // Ảnh minh hoạ hiện trên card trang chủ thay cho icon — admin tự đổi được, không cần sửa code
      demoImageUrls: config?.demo_image_urls ?? [],
      // Riêng "Thay trang phục": bật/tắt từng model AI (đa năng/FASHN) — null nếu app không có nhiều model
      outfitSwapModels: config?.models
        ? { generic: !!config.models.generic?.enabled, fashn: !!config.models.fashn?.enabled }
        : null,
    };
  });

  return Response.json({ apps });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id, creditCost, isActive, demoImageUrls, outfitSwapModels } = await req.json();
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "Thiếu id" }, { status: 400 });
  }
  if (creditCost === undefined && isActive === undefined && demoImageUrls === undefined && outfitSwapModels === undefined) {
    return Response.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
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
  if (demoImageUrls !== undefined) {
    if (!Array.isArray(demoImageUrls) || !demoImageUrls.every((u) => typeof u === "string")) {
      return Response.json({ error: "demoImageUrls phải là mảng chuỗi" }, { status: 400 });
    }
    // Gộp vào model_config hiện có thay vì ghi đè — model_config còn chứa model/output_type/provider_cost_vnd...
    const { data: current } = await supabase.from("mini_apps").select("model_config").eq("id", id).single();
    update.model_config = { ...((current?.model_config as object) ?? {}), demo_image_urls: demoImageUrls };
  }
  if (outfitSwapModels !== undefined) {
    if (typeof outfitSwapModels !== "object" || outfitSwapModels === null) {
      return Response.json({ error: "outfitSwapModels không hợp lệ" }, { status: 400 });
    }
    const { data: current } = await supabase.from("mini_apps").select("model_config").eq("id", id).single();
    const currentConfig = (current?.model_config as { models?: Record<string, { enabled: boolean }> }) ?? {};
    if (!currentConfig.models) {
      return Response.json({ error: "App này không có nhiều model để bật/tắt" }, { status: 400 });
    }
    const nextModels = { ...currentConfig.models };
    for (const key of Object.keys(outfitSwapModels)) {
      if (nextModels[key] && typeof outfitSwapModels[key] === "boolean") {
        nextModels[key] = { ...nextModels[key], enabled: outfitSwapModels[key] };
      }
    }
    // Không cho tắt hết cả 2 — người dùng sẽ không chạy được app này nữa
    if (!Object.values(nextModels).some((m) => m.enabled)) {
      return Response.json({ error: "Phải bật ít nhất 1 model" }, { status: 400 });
    }
    update.model_config = { ...currentConfig, models: nextModels };
  }

  const { error } = await supabase.from("mini_apps").update(update).eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}

// Model Fal.ai duy nhất đã kiểm chứng chạy được cho mỗi loại — admin không tự nhập chuỗi model để
// tránh gõ sai làm gãy tích hợp (Tập 8 mục 3.2 cùng tinh thần "chỉ cho phép cấu hình an toàn").
const IMAGE_MODEL = "fal-ai/flux-pro/kontext";
const VIDEO_MODEL = "fal-ai/kling-video/v1.6/standard/image-to-video";

// Admin tự tạo Mini App mới ngay từ /admin — hỗ trợ cả 3 dạng:
// - "text": gọi OpenRouter với system prompt admin viết
// - "image": gọi Fal.ai Flux Kontext (giống hệt luồng "Tạo ảnh quảng cáo sản phẩm" có sẵn)
// - "video": nộp job bất đồng bộ qua Fal.ai Kling (giống hệt luồng "Tạo video quảng cáo ngắn" có sẵn,
//   submitVideoJob() vốn đã tổng quát theo miniAppId nên không cần sửa gì ở lib/ai-router.ts cho video)
export async function POST(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { type, name, description, creditCost } = body;

  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "Thiếu tên Mini App" }, { status: 400 });
  }
  if (typeof description !== "string" || !description.trim()) {
    return Response.json({ error: "Thiếu mô tả" }, { status: 400 });
  }
  if (typeof creditCost !== "number" || creditCost <= 0 || !Number.isInteger(creditCost)) {
    return Response.json({ error: "Giá phải là số nguyên dương" }, { status: 400 });
  }

  let category: string;
  let modelConfig: Record<string, unknown>;

  if (type === "image") {
    category = "anh";
    modelConfig = { model: IMAGE_MODEL, output_type: "image" };
  } else if (type === "video") {
    category = "video";
    modelConfig = { model: VIDEO_MODEL, output_type: "video" };
  } else {
    const { category: textCategory, model, systemPrompt } = body;
    if (!["anh", "van-ban", "video", "am-thanh"].includes(textCategory)) {
      return Response.json({ error: "Danh mục không hợp lệ" }, { status: 400 });
    }
    if (typeof model !== "string" || !model.trim()) {
      return Response.json({ error: "Thiếu model" }, { status: 400 });
    }
    if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
      return Response.json({ error: "Thiếu hướng dẫn cho AI (system prompt)" }, { status: 400 });
    }
    category = textCategory;
    modelConfig = { model: model.trim(), max_tokens: 500, system_prompt: systemPrompt.trim(), output_type: "text" };
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
    model_config: modelConfig,
  });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, id });
}
