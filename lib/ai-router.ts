import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";

type MiniAppRow = {
  id: string;
  name: string;
  credit_cost: number;
  model_config: { model: string; max_tokens?: number; output_type?: "text" | "image" };
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
    .select("id, name, credit_cost, model_config")
    .eq("id", miniAppId)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy Mini App");
  return data as MiniAppRow;
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

// Gọi Fal.ai (Flux Kontext) để sinh ảnh — nhận prompt + ảnh tham chiếu tuỳ chọn,
// giữ đúng sản phẩm thật khi tạo bối cảnh mới (khác callOpenRouter: ảnh vào -> chữ ra).
async function generateImageFal(prompt: string, referenceImageDataUrl?: string): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const body: Record<string, unknown> = { prompt };
  if (referenceImageDataUrl) {
    body.image_url = referenceImageDataUrl;
  }

  const response = await fetch("https://fal.run/fal-ai/flux-pro/kontext", {
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

    if (miniApp.model_config.output_type === "image") {
      output = await generateImageFal(userInput, imageDataUrl);
    } else {
      const systemPrompt = SYSTEM_PROMPTS[miniAppId] ?? "Bạn là trợ lý AI hữu ích.";
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
