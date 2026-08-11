import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings, getUsdToVndRate } from "@/lib/pricing";

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

async function callOpenRouter(
  model: string,
  maxTokens: number,
  systemPrompt: string,
  userInput: string,
  imageDataUrl?: string
) {
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
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter lỗi: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content as string;
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
  endFrameDataUrl?: string
): Promise<{ jobId: number; newBalance: number }> {
  const miniApp = await getMiniAppConfig(miniAppId);
  const supabase = getSupabaseAdmin();

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

    const model = miniApp.model_config.model; // vd "fal-ai/kling-video/v1.6/standard/image-to-video"
    const webhookUrl = `${SITE_URL}/api/video/webhook?jobId=${job.id}`;
    const body: Record<string, unknown> = { prompt };
    if (startFrameDataUrl) body.image_url = startFrameDataUrl;
    if (endFrameDataUrl) body.tail_image_url = endFrameDataUrl;

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
    } else {
      // App admin tự tạo qua /admin đặt system_prompt riêng trong model_config; 5 app gốc dùng bảng cứng ở trên
      const systemPrompt = miniApp.model_config.system_prompt ?? SYSTEM_PROMPTS[miniAppId] ?? "Bạn là trợ lý AI hữu ích.";
      output = await callOpenRouter(
        miniApp.model_config.model,
        miniApp.model_config.max_tokens ?? 500,
        systemPrompt,
        userInput,
        imageDataUrl
      );
    }

    return { output, newBalance: deduction.newBalance };
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }
}
