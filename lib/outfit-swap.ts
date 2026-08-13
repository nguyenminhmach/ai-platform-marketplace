// "Thay trang phục cho người mẫu" — 1 ảnh người mẫu + tối đa 10 ảnh trang phục tham chiếu, ghép qua
// Fal.ai Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit), MỖI bộ đồ = 1 lần gọi riêng
// (model chỉ nhận tối đa 2 ảnh/lần), chạy song song rồi gộp kết quả. Khác các app ảnh khác: giá tính
// theo SỐ LƯỢNG bộ đồ đưa vào (không cố định 1 mức), nên không dùng chung getMiniAppConfig()/runMiniApp().

import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";
import { recordGenerationHistory } from "@/lib/ai-router";

const MINI_APP_ID = "thay-trang-phuc";
const MAX_GARMENTS = 10;

export const DEFAULT_OUTFIT_SWAP_PROMPT =
  "Giữ nguyên khuôn mặt, dáng người, tư thế, biểu cảm, góc chụp, ánh sáng và bối cảnh của ảnh người mẫu. Chỉ thay trang phục của người mẫu bằng đúng bộ trang phục trong ảnh tham chiếu — giữ đúng kiểu dáng, màu sắc, hoạ tiết và chất liệu của trang phục đó.";

async function getModelAndProviderCost(): Promise<{ model: string; providerCostVnd: number }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mini_apps")
    .select("model_config")
    .eq("id", MINI_APP_ID)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy app Thay trang phục");
  const config = data.model_config as { model: string; provider_cost_vnd: number };
  return { model: config.model, providerCostVnd: config.provider_cost_vnd };
}

/** Giá credit cho 1 bộ đồ — trang chủ/trang chi tiết gọi hàm này để hiện giá trước khi chạy. */
export async function getOutfitSwapPricePerImage(): Promise<number> {
  const { providerCostVnd } = await getModelAndProviderCost();
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  return computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);
}

async function callNanoBananaEdit(modelImageDataUrl: string, garmentImageDataUrl: string, prompt: string): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const response = await fetch("https://fal.run/fal-ai/gemini-3-pro-image-preview/edit", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_urls: [modelImageDataUrl, garmentImageDataUrl],
    }),
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

export async function runOutfitSwap(
  userId: string,
  modelImageDataUrl: string,
  garmentImageDataUrls: string[],
  prompt: string,
  idempotencyKey: string
): Promise<{ outputs: string[]; newBalance: number; creditCost: number }> {
  if (garmentImageDataUrls.length === 0) throw new Error("Cần ít nhất 1 ảnh trang phục tham chiếu");
  if (garmentImageDataUrls.length > MAX_GARMENTS) throw new Error(`Tối đa ${MAX_GARMENTS} ảnh trang phục mỗi lượt`);

  const perImageCredit = await getOutfitSwapPricePerImage();
  const totalCredit = perImageCredit * garmentImageDataUrls.length;

  const deduction = await deductCredit(userId, totalCredit, MINI_APP_ID, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const outputs = await Promise.all(
      garmentImageDataUrls.map((garmentUrl) => callNanoBananaEdit(modelImageDataUrl, garmentUrl, prompt))
    );

    await Promise.all(outputs.map((url) => recordGenerationHistory(userId, MINI_APP_ID, "image", url)));

    return { outputs, newBalance: deduction.newBalance, creditCost: totalCredit };
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }
}
