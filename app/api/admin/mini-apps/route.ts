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
      | {
          provider_cost_vnd?: number;
          demo_image_urls?: string[];
          models?: Record<string, { enabled: boolean }>;
          output_type?: string;
          default_prompt?: string;
          default_prompt_visible?: boolean;
          prompt_helper_instructions?: string;
          character_prompt?: string;
          image_models?: { key: string; provider: string; label: string; model: string; provider_cost_vnd: number; multi_image: boolean; enabled: boolean }[];
          video_models?: { key: string; provider: string; label: string; model: string; provider_cost_vnd: number; enabled: boolean }[];
        }
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
      // Riêng "Thay trang phục": bật/tắt từng model AI (đa năng/FASHN/FASHN Max) — null nếu app không
      // có nhiều model HOẶC có models nhưng không phải 3 key này (vd tier "basic"/"premium" ở app
      // video khác) — tránh hiện nhầm 3 checkbox generic/fashn/fashn_max cho app không liên quan.
      outfitSwapModels:
        config?.models && ("generic" in config.models || "fashn" in config.models || "fashn_max" in config.models)
          ? {
              generic: !!config.models.generic?.enabled,
              fashn: !!config.models.fashn?.enabled,
              fashn_max: !!config.models.fashn_max?.enabled,
            }
          : null,
      // Tổng quát hơn outfitSwapModels ở trên — trả đúng key thật có trong model_config.models (vd
      // "basic"/"premium" ở app video nhiều tier), không hardcode tên cụ thể. null nếu app không có.
      modelTiers: config?.models
        ? Object.fromEntries(Object.entries(config.models).map(([key, entry]) => [key, !!entry.enabled]))
        : null,
      // Prompt mặc định tự điền cho khách ở app tạo video — chỉ áp dụng cho app output video
      isVideoApp: config?.output_type === "video",
      defaultPrompt: config?.default_prompt ?? "",
      // Công tắc ẩn/hiện riêng, độc lập với nội dung đã lưu — admin tắt mà không mất bản đã soạn.
      // Mặc định true để không đổi hành vi các app đã có sẵn default_prompt từ trước.
      defaultPromptVisible: config?.default_prompt_visible ?? true,
      // System prompt cho nút "AI viết giúp mô tả" — rỗng thì route generate-prompt tự dùng bản mặc định
      promptHelperInstructions: config?.prompt_helper_instructions ?? "",
      // Prompt tạo ảnh Character (sheet nhiều góc) — chỉ app "Video từ ý tưởng truyện" dùng, rỗng thì
      // lib/story-video.ts tự dùng bản mặc định 6 góc.
      characterPrompt: config?.character_prompt ?? "",
      // Catalog model ảnh/video nhiều nhà cung cấp — chỉ app "Video từ ý tưởng truyện" có, null cho
      // app khác để không hiện nhầm section catalog.
      storyImageModels: config?.image_models ?? null,
      storyVideoModels: config?.video_models ?? null,
    };
  });

  return Response.json({ apps });
}

export async function PATCH(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const {
    id,
    creditCost,
    isActive,
    demoImageUrls,
    outfitSwapModels,
    modelTiers,
    defaultPrompt,
    defaultPromptVisible,
    promptHelperInstructions,
    characterPrompt,
    storyImageModels,
    storyVideoModels,
  } = await req.json();
  // modelTiers là alias tổng quát của outfitSwapModels — cùng 1 cơ chế bật/tắt entry trong
  // model_config.models, chỉ khác tên gọi cho rõ nghĩa khi dùng ở app không phải "Thay trang phục"
  // (vd tier chất lượng video "basic"/"premium"). Không cho gửi cả 2 cùng lúc để tránh mơ hồ.
  const modelToggles = outfitSwapModels ?? modelTiers;
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "Thiếu id" }, { status: 400 });
  }
  if (
    creditCost === undefined &&
    isActive === undefined &&
    demoImageUrls === undefined &&
    modelToggles === undefined &&
    defaultPrompt === undefined &&
    defaultPromptVisible === undefined &&
    promptHelperInstructions === undefined &&
    characterPrompt === undefined &&
    storyImageModels === undefined &&
    storyVideoModels === undefined
  ) {
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

  // Các field dưới đây đều sống trong model_config — đọc 1 lần rồi gộp hết thay đổi vào cùng 1 object,
  // tránh trường hợp gửi nhiều field model_config trong cùng 1 request mà field sau ghi đè mất field trước.
  if (
    demoImageUrls !== undefined ||
    modelToggles !== undefined ||
    defaultPrompt !== undefined ||
    defaultPromptVisible !== undefined ||
    promptHelperInstructions !== undefined ||
    characterPrompt !== undefined ||
    storyImageModels !== undefined ||
    storyVideoModels !== undefined
  ) {
    const { data: current } = await supabase.from("mini_apps").select("model_config").eq("id", id).single();
    const currentConfig = (current?.model_config as Record<string, unknown>) ?? {};
    const nextConfig: Record<string, unknown> = { ...currentConfig };

    if (demoImageUrls !== undefined) {
      if (!Array.isArray(demoImageUrls) || !demoImageUrls.every((u) => typeof u === "string")) {
        return Response.json({ error: "demoImageUrls phải là mảng chuỗi" }, { status: 400 });
      }
      nextConfig.demo_image_urls = demoImageUrls;
    }
    if (modelToggles !== undefined) {
      if (typeof modelToggles !== "object" || modelToggles === null) {
        return Response.json({ error: "Dữ liệu bật/tắt model không hợp lệ" }, { status: 400 });
      }
      const existingModels = (currentConfig.models as Record<string, { enabled: boolean }> | undefined) ?? undefined;
      if (!existingModels) {
        return Response.json({ error: "App này không có nhiều model để bật/tắt" }, { status: 400 });
      }
      const nextModels = { ...existingModels };
      for (const key of Object.keys(modelToggles)) {
        if (nextModels[key] && typeof modelToggles[key] === "boolean") {
          nextModels[key] = { ...nextModels[key], enabled: modelToggles[key] };
        }
      }
      // Không cho tắt hết — người dùng sẽ không chạy được app này nữa
      if (!Object.values(nextModels).some((m) => m.enabled)) {
        return Response.json({ error: "Phải bật ít nhất 1 model" }, { status: 400 });
      }
      nextConfig.models = nextModels;
    }
    if (defaultPrompt !== undefined) {
      if (typeof defaultPrompt !== "string") {
        return Response.json({ error: "defaultPrompt phải là chuỗi" }, { status: 400 });
      }
      nextConfig.default_prompt = defaultPrompt;
    }
    if (defaultPromptVisible !== undefined) {
      if (typeof defaultPromptVisible !== "boolean") {
        return Response.json({ error: "defaultPromptVisible phải là true/false" }, { status: 400 });
      }
      nextConfig.default_prompt_visible = defaultPromptVisible;
    }
    if (promptHelperInstructions !== undefined) {
      if (typeof promptHelperInstructions !== "string") {
        return Response.json({ error: "promptHelperInstructions phải là chuỗi" }, { status: 400 });
      }
      nextConfig.prompt_helper_instructions = promptHelperInstructions;
    }
    if (characterPrompt !== undefined) {
      if (typeof characterPrompt !== "string") {
        return Response.json({ error: "characterPrompt phải là chuỗi" }, { status: 400 });
      }
      nextConfig.character_prompt = characterPrompt;
    }
    if (storyImageModels !== undefined) {
      if (
        !Array.isArray(storyImageModels) ||
        !storyImageModels.every(
          (m) =>
            m && typeof m.key === "string" && m.key && typeof m.provider === "string" && typeof m.label === "string" &&
            typeof m.model === "string" && m.model && typeof m.provider_cost_vnd === "number" && m.provider_cost_vnd > 0 &&
            typeof m.multi_image === "boolean" && typeof m.enabled === "boolean"
        )
      ) {
        return Response.json({ error: "Danh sách model ảnh không hợp lệ" }, { status: 400 });
      }
      if (!storyImageModels.some((m) => m.enabled)) {
        return Response.json({ error: "Phải bật ít nhất 1 model ảnh" }, { status: 400 });
      }
      nextConfig.image_models = storyImageModels;
    }
    if (storyVideoModels !== undefined) {
      if (
        !Array.isArray(storyVideoModels) ||
        !storyVideoModels.every(
          (m) =>
            m && typeof m.key === "string" && m.key && typeof m.provider === "string" && typeof m.label === "string" &&
            typeof m.model === "string" && m.model && typeof m.provider_cost_vnd === "number" && m.provider_cost_vnd > 0 &&
            typeof m.enabled === "boolean"
        )
      ) {
        return Response.json({ error: "Danh sách model video không hợp lệ" }, { status: 400 });
      }
      if (!storyVideoModels.some((m) => m.enabled)) {
        return Response.json({ error: "Phải bật ít nhất 1 model video" }, { status: 400 });
      }
      nextConfig.video_models = storyVideoModels;
    }

    update.model_config = nextConfig;
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
