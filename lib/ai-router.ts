import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings, getUsdToVndRate } from "@/lib/pricing";

// Tier chất lượng cho app video có nhiều mức (hiện chỉ "Tạo video quảng cáo ngắn") — "basic" giá cố
// định 1 mức, "premium" giá khác nhau theo duration (Kling v2.1 Pro tính theo giây thật).
type VideoTierEntry = {
  model: string;
  enabled: boolean;
  provider_cost_vnd?: number; // dùng cho tier giá cố định (basic)
  provider_cost_vnd_5s?: number; // dùng cho tier tính theo duration (premium)
  provider_cost_vnd_10s?: number;
};

type MiniAppRow = {
  id: string;
  name: string;
  credit_cost: number;
  developer_id: string | null;
  model_config: {
    model: string;
    max_tokens?: number;
    output_type?: "text" | "image";
    provider_cost_vnd?: number;
    integration_mode?: "dify";
    endpoint_url?: string;
    api_key?: string;
    system_prompt?: string;
    // "motion-control": app "Nhảy theo video mẫu" — Kling nhận ảnh nhân vật + video mẫu chuyển
    // động (không phải prompt chữ), body Fal.ai khác hẳn image-to-video thường.
    input_mode?: "motion-control";
    models?: { basic?: VideoTierEntry; premium?: VideoTierEntry };
  };
};

type RunResult = {
  output: string;
  newBalance: number;
};

// Prompt hệ thống cho từng Mini App — Tập 2 mục 3: system prompt là "luật chơi" cố định
const SYSTEM_PROMPTS: Record<string, string> = {
  "viet-mo-ta-san-pham":
    "Bạn là chuyên gia viết mô tả sản phẩm bán hàng tiếng Việt. Nhìn kỹ ảnh sản phẩm được cung cấp, viết mô tả ngắn gọn (2-3 câu), hấp dẫn, dựa đúng trên những gì thấy trong ảnh. Không bịa thêm chi tiết không có trong ảnh.",
  "tom-tat-van-ban":
    "Bạn là chuyên gia tóm tắt văn bản tiếng Việt. Tóm tắt văn bản người dùng cung cấp thành 2-4 câu, giữ đúng ý chính, không bịa thêm thông tin.",
  "viet-caption":
    "Bạn là chuyên gia viết caption mạng xã hội tiếng Việt. Viết caption ngắn, thu hút, kèm 2-4 hashtag phù hợp, dựa trên chủ đề người dùng cung cấp.",
  "dich-da-ngon-ngu":
    "Bạn là chuyên gia dịch thuật. Dịch tự nhiên, đúng ngữ cảnh, không dịch máy cứng nhắc. Chỉ trả về bản dịch, không giải thích thêm.",
  "phan-tich-cam-xuc":
    "Bạn là chuyên gia phân tích cảm xúc bình luận khách hàng tiếng Việt. Phân loại tỷ lệ tích cực/tiêu cực và tóm tắt insight chính trong 2-3 câu.",
};

async function getMiniAppConfig(miniAppId: string): Promise<MiniAppRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mini_apps")
    .select("id, name, credit_cost, developer_id, model_config")
    .eq("id", miniAppId)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy Mini App");
  const row = data as MiniAppRow;

  // Ảnh/video có provider_cost_vnd trong model_config -> tính giá động theo
  // chi phí thật x (1 + biên lợi nhuận%), thay cho credit_cost cố định trong bảng.
  if (row.model_config.provider_cost_vnd) {
    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    row.credit_cost = computeDynamicCreditCost(row.model_config.provider_cost_vnd, marginPercent, vndPerCredit);
  }

  return row;
}

const VIDEO_TIER_LABELS: Record<"basic" | "premium", string> = {
  basic: "Cơ bản",
  premium: "Cao cấp",
};

// Danh sách tier chất lượng đang bật + giá credit cho từng lựa chọn — trang chi tiết app video gọi
// hàm này để build nút chọn tier (giống hệt pattern getEnabledOutfitSwapModels() bên outfit-swap).
// App không có model_config.models (Video trước/sau, Nhảy theo video mẫu...) trả về mảng rỗng.
export async function getVideoQualityTiers(miniAppId: string): Promise<
  {
    key: "basic" | "premium";
    label: string;
    creditCost?: number; // tier giá cố định
    creditCostByDuration?: { "5": number; "10": number }; // tier tính theo duration
  }[]
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mini_apps")
    .select("model_config")
    .eq("id", miniAppId)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy Mini App");
  const models = (data.model_config as MiniAppRow["model_config"]).models;
  if (!models) return [];

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const result: Awaited<ReturnType<typeof getVideoQualityTiers>> = [];

  if (models.basic?.enabled && models.basic.provider_cost_vnd) {
    result.push({
      key: "basic",
      label: VIDEO_TIER_LABELS.basic,
      creditCost: computeDynamicCreditCost(models.basic.provider_cost_vnd, marginPercent, vndPerCredit),
    });
  }
  if (models.premium?.enabled && models.premium.provider_cost_vnd_5s && models.premium.provider_cost_vnd_10s) {
    result.push({
      key: "premium",
      label: VIDEO_TIER_LABELS.premium,
      creditCostByDuration: {
        "5": computeDynamicCreditCost(models.premium.provider_cost_vnd_5s, marginPercent, vndPerCredit),
        "10": computeDynamicCreditCost(models.premium.provider_cost_vnd_10s, marginPercent, vndPerCredit),
      },
    });
  }

  return result;
}

// usage.include=true là extension riêng của OpenRouter — trả kèm chi phí USD thật họ đã tính,
// khỏi phải tự áng chừng theo bảng giá từng model (chính xác hơn, tự cập nhật khi họ đổi giá).
async function callOpenRouter(
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userInput: string,
  imageDataUrl?: string
): Promise<{ output: string; costUsd: number; tokensUsed: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình OPENROUTER_API_KEY trong .env.local");

  const userContent = imageDataUrl
    ? [
        { type: "text", text: userInput || "Hãy viết mô tả bán hàng cho sản phẩm trong ảnh này." },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : userInput;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
      usage: { include: true },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter lỗi: ${response.status}`);
  }

  const data = await response.json();
  return {
    output: data.choices[0].message.content as string,
    costUsd: data.usage?.cost ?? 0,
    tokensUsed: data.usage?.total_tokens ?? 0,
  };
}

// Gọi Fal.ai (mặc định Flux Kontext, admin tạo app ảnh mới cũng dùng chung model này) để sinh ảnh —
// nhận prompt + ảnh tham chiếu tuỳ chọn, giữ đúng sản phẩm thật khi tạo bối cảnh mới.
async function generateImageFal(
  prompt: string,
  referenceImageDataUrl?: string,
  model = "fal-ai/flux-pro/kontext"
): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const body: Record<string, unknown> = { prompt };
  if (referenceImageDataUrl) {
    body.image_url = referenceImageDataUrl;
  }

  const response = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown Fal.ai error");
    throw new Error(`Fal.ai lỗi: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) throw new Error("Fal.ai không trả về ảnh");
  return imageUrl as string;
}

// Integration Contract (Tập 8 mục 2.2) — chuẩn request/response bắt buộc mọi Mini App bên thứ 3 phải theo
type DeveloperMiniAppResponse = {
  success: boolean;
  output?: { text?: string };
  error?: { code: string; message: string };
  actual_cost_usd?: number;
};

// Gọi endpoint Workflow Dify của nhà phát triển bên thứ 3 (Hình thức A, Tập 8 mục 2.3).
// Timeout cứng 30 giây (Tập 8 mục 3.2) — endpoint dev treo không được làm treo cả hệ thống.
async function callDeveloperEndpoint(
  endpointUrl: string,
  apiKey: string,
  requestId: string,
  userInput: string,
  imageDataUrl?: string
): Promise<{ output: string; actualCostUsd: number }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: requestId,
        inputs: { text: userInput, image_data_url: imageDataUrl },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Mini App bên thứ 3 lỗi: ${response.status}`);
    }

    const data = (await response.json()) as DeveloperMiniAppResponse;
    if (!data.success) {
      throw new Error(data.error?.message ?? "Mini App bên thứ 3 trả về lỗi");
    }

    // Validate output đúng schema trước khi hiển thị cho user (Tập 8 mục 3.2) — chặn output sai định dạng
    if (typeof data.output?.text !== "string") {
      throw new Error("Mini App bên thứ 3 trả output sai định dạng (thiếu output.text)");
    }

    return { output: data.output.text, actualCostUsd: data.actual_cost_usd ?? 0 };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Mini App bên thứ 3 không phản hồi trong 30 giây");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Lưu link ảnh/video vừa tạo thành công vào gallery "Lịch sử kết quả" của user — trước đây link chỉ
// trả về cho trình duyệt lúc đó rồi mất, không xem lại được.
export async function recordGenerationHistory(
  userId: string,
  miniAppId: string,
  outputType: "image" | "video",
  outputUrl: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("generation_history").insert({
    user_id: userId,
    mini_app_id: miniAppId,
    output_type: outputType,
    output_url: outputUrl,
  });
}

// Ghi chi phí AI thật (USD OpenRouter báo về) cho từng lượt chạy app văn bản — trước đây không lưu ở
// đâu cả nên chỉ áng chừng được, giờ có usage_logs để tra cứu chính xác + làm nền cho đối chiếu sau này.
async function recordUsageLog(
  userId: string,
  miniAppId: string,
  creditTransactionId: number | null,
  actualCostUsd: number,
  tokensUsed: number
): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("usage_logs").insert({
    user_id: userId,
    mini_app_id: miniAppId,
    credit_transaction_id: creditTransactionId,
    actual_cost_usd: actualCostUsd,
    tokens_used: tokensUsed,
    status: "success",
  });
}

// Ghi nhận hoa hồng cho dev sau 1 lượt chạy thành công (Tập 8 mục 6.1) — sổ cái riêng, không sửa/xoá dòng
async function recordDeveloperEarning(miniApp: MiniAppRow, actualCostUsd: number): Promise<void> {
  if (!miniApp.developer_id) return;

  const supabase = getSupabaseAdmin();
  const { data: dev } = await supabase
    .from("developers")
    .select("id, revenue_share_pct")
    .eq("id", miniApp.developer_id)
    .single();
  if (!dev) return;

  const [{ vndPerCredit }, usdToVndRate] = await Promise.all([getMediaPricingSettings(), getUsdToVndRate()]);

  const revenueVnd = miniApp.credit_cost * vndPerCredit;
  const aiCostVnd = actualCostUsd * usdToVndRate;
  const profitAfterAiCost = Math.max(0, revenueVnd - aiCostVnd);
  const amountVnd = Math.round(profitAfterAiCost * (dev.revenue_share_pct / 100));

  if (amountVnd <= 0) return;

  await supabase.from("developer_earnings").insert({
    developer_id: dev.id,
    mini_app_id: miniApp.id,
    amount_vnd: amountVnd,
    status: "pending",
  });
}

// Nộp job tạo video (bất đồng bộ) — khác hẳn runMiniApp: không chờ kết quả, chỉ gửi yêu cầu lên Fal.ai
// kèm webhook, lưu 1 dòng video_jobs để theo dõi, trả về ngay jobId cho client polling.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export async function submitVideoJob(
  miniAppId: string,
  userId: string,
  prompt: string,
  idempotencyKey: string,
  startFrameDataUrl?: string,
  endFrameDataUrl?: string,
  modelChoice?: "basic" | "premium",
  duration?: "5" | "10"
): Promise<{ jobId: number; newBalance: number }> {
  const miniApp = await getMiniAppConfig(miniAppId);
  const supabase = getSupabaseAdmin();

  // App có nhiều tier chất lượng (model_config.models, hiện chỉ "Tạo video quảng cáo ngắn") — model +
  // giá phụ thuộc tier đã chọn, ghi đè giá tính sẵn ở getMiniAppConfig() (dựa theo provider_cost_vnd
  // đơn, không biết tier). App không có tier (Video trước/sau, Nhảy theo video mẫu...) bỏ qua nhánh này.
  let modelToCall = miniApp.model_config.model;
  let resolvedTier: "basic" | "premium" | null = null;
  if (miniApp.model_config.models) {
    const tierKey: "basic" | "premium" =
      modelChoice && miniApp.model_config.models[modelChoice]?.enabled ? modelChoice : "basic";
    const tier = miniApp.model_config.models[tierKey];
    if (!tier) throw new Error("Không tìm thấy tier chất lượng video hợp lệ");
    resolvedTier = tierKey;
    modelToCall = tier.model;

    const providerCostVnd =
      tierKey === "premium"
        ? duration === "10"
          ? tier.provider_cost_vnd_10s
          : tier.provider_cost_vnd_5s
        : tier.provider_cost_vnd;
    if (!providerCostVnd) throw new Error("Thiếu cấu hình giá cho tier chất lượng video này");

    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    miniApp.credit_cost = computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);
  }

  const deduction = await deductCredit(userId, miniApp.credit_cost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const { data: job, error: insertError } = await supabase
    .from("video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "pending",
      input_prompt: prompt,
      start_frame_url: startFrameDataUrl ?? null,
      end_frame_url: endFrameDataUrl ?? null,
      credit_tx_id: deduction.txId,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được video job");
  }

  try {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

    const model = modelToCall; // vd "fal-ai/kling-video/v1.6/standard/image-to-video"
    const webhookUrl = `${SITE_URL}/api/video/webhook?jobId=${job.id}`;

    let body: Record<string, unknown>;
    if (miniApp.model_config.input_mode === "motion-control") {
      // "Nhảy theo video mẫu": startFrameDataUrl = ảnh nhân vật, endFrameDataUrl (tái dùng slot có
      // sẵn) = video mẫu chuyển động — Kling Motion Control không dùng prompt chữ.
      body = {
        image_url: startFrameDataUrl,
        video_url: endFrameDataUrl,
        character_orientation: "video",
      };
    } else {
      body = { prompt };
      if (startFrameDataUrl) body.image_url = startFrameDataUrl;
      if (endFrameDataUrl) body.tail_image_url = endFrameDataUrl;
      // Tier "premium" (Kling v2.1 Pro) tính phí theo duration thật, cần gửi rõ "5"/"10" — tier
      // "basic" (v1.6) không nhận tham số này, độ dài video cố định ~5s.
      if (resolvedTier === "premium") body.duration = duration === "10" ? "10" : "5";
    }

    const response = await fetch(`https://queue.fal.run/${model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown Fal.ai error");
      throw new Error(`Fal.ai lỗi: ${response.status} ${errText}`);
    }

    const data = await response.json();
    await supabase
      .from("video_jobs")
      .update({ status: "processing", fal_request_id: data.request_id })
      .eq("id", job.id);
  } catch (err) {
    await supabase
      .from("video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { jobId: job.id, newBalance: deduction.newBalance };
}

// AI Router — Tập 4 mục 4: điểm trung tâm duy nhất chạy Mini App, mọi nơi khác chỉ gọi hàm này
export async function runMiniApp(
  miniAppId: string,
  userInput: string,
  userId: string,
  idempotencyKey: string,
  imageDataUrl?: string
): Promise<RunResult> {
  const miniApp = await getMiniAppConfig(miniAppId);

  const deduction = await deductCredit(userId, miniApp.credit_cost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    let output: string;

    if (miniApp.model_config.integration_mode === "dify") {
      // Mini App do nhà phát triển bên thứ 3 tạo — gọi sang endpoint Dify của họ (Tập 8 mục 2)
      if (!miniApp.model_config.endpoint_url || !miniApp.model_config.api_key) {
        throw new Error("Mini App bên thứ 3 thiếu cấu hình endpoint");
      }
      const result = await callDeveloperEndpoint(
        miniApp.model_config.endpoint_url,
        miniApp.model_config.api_key,
        idempotencyKey,
        userInput,
        imageDataUrl
      );
      output = result.output;
      await recordDeveloperEarning(miniApp, result.actualCostUsd);
    } else if (miniApp.model_config.output_type === "image") {
      output = await generateImageFal(userInput, imageDataUrl, miniApp.model_config.model);
      await recordGenerationHistory(userId, miniAppId, "image", output);
    } else {
      // App admin tự tạo qua /admin đặt system_prompt riêng trong model_config; 5 app gốc dùng bảng cứng ở trên
      const systemPrompt = miniApp.model_config.system_prompt ?? SYSTEM_PROMPTS[miniAppId] ?? "Bạn là trợ lý AI hữu ích.";
      const result = await callOpenRouter(
        miniApp.model_config.model,
        miniApp.model_config.max_tokens ?? 500,
        systemPrompt,
        userInput,
        imageDataUrl
      );
      output = result.output;
      await recordUsageLog(userId, miniAppId, deduction.txId, result.costUsd, result.tokensUsed);
    }

    return { output, newBalance: deduction.newBalance };
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }
}
