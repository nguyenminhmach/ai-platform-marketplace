// "Thay trang phục cho người mẫu" — 1 ảnh người mẫu + tối đa N ảnh trang phục tham chiếu, ghép qua
// Fal.ai, MỖI bộ đồ = 1 lần gọi riêng. Khác các app ảnh khác: giá tính theo SỐ LƯỢNG bộ đồ đưa vào
// (không cố định 1 mức), nên không dùng chung getMiniAppConfig()/runMiniApp().
//
// Hỗ trợ SONG SONG 2 model, admin bật/tắt từng cái qua model_config.models.{generic,fashn}.enabled:
// - "generic": Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit) — nhận câu lệnh mô tả
//   tự do, đa năng nhưng hay nhầm lẫn "lấy người nào làm gốc" khi ảnh trang phục tham chiếu là ảnh
//   người khác mặc sẵn (đã kiểm chứng qua test thật).
// - "fashn": FASHN Virtual Try-On v1.6 (fal-ai/fashn/tryon/v1.6) — API có cấu trúc (model_image +
//   garment_image, KHÔNG nhận prompt), rẻ hơn 50%, ổn định hơn nhờ garment_photo_type tự nhận diện
//   ảnh trang phục on-model/flat-lay. Nếu cả 2 đều bật, người dùng tự chọn; mặc định FASHN.
//
// Chạy BẤT ĐỒNG BỘ qua Fal.ai queue (không phải fal.run đồng bộ) — submit xong trả về ngay, không
// giữ 1 request chờ tới khi xong. Lý do: test thực tế 6 ảnh song song từng bị Vercel Hobby giết ở
// mốc 60s (maxDuration tối đa cho phép), mất credit không hoàn vì function bị kill cứng giữa chừng.
// Xem lib/outfit-swap-jobs.ts cho phần chốt kết quả (webhook/poll/cron), mô hình giống lib/video-jobs.ts.

import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";
import { finalizeJobIfDone } from "@/lib/outfit-swap-jobs";

const MINI_APP_ID = "thay-trang-phuc";
const MAX_GARMENTS = 10; // không còn giới hạn bởi thời gian chờ 1 request nữa (đã chuyển bất đồng bộ)
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export type OutfitSwapModelKey = "generic" | "fashn";

type ModelEntry = { model: string; provider_cost_vnd: number; enabled: boolean };
type ModelsConfig = Record<OutfitSwapModelKey, ModelEntry>;

const MODEL_LABELS: Record<OutfitSwapModelKey, string> = {
  generic: "AI đa năng (tuỳ chỉnh câu lệnh)",
  fashn: "AI chuyên thử đồ (nhanh, rẻ hơn)",
};

async function getModelsConfig(): Promise<ModelsConfig> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mini_apps")
    .select("model_config")
    .eq("id", MINI_APP_ID)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy app Thay trang phục");
  const config = data.model_config as { models: ModelsConfig };
  return config.models;
}

/** Danh sách model đang bật + giá credit mỗi ảnh — trang chi tiết gọi hàm này để build nút chọn + giá. */
export async function getEnabledOutfitSwapModels(): Promise<
  { key: OutfitSwapModelKey; label: string; pricePerImage: number; hasPrompt: boolean }[]
> {
  const modelsConfig = await getModelsConfig();
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();

  return (Object.keys(modelsConfig) as OutfitSwapModelKey[])
    .filter((key) => modelsConfig[key]?.enabled)
    .map((key) => ({
      key,
      label: MODEL_LABELS[key],
      pricePerImage: computeDynamicCreditCost(modelsConfig[key].provider_cost_vnd, marginPercent, vndPerCredit),
      hasPrompt: key === "generic",
    }));
}

function buildFalRequestBody(
  modelKey: OutfitSwapModelKey,
  modelImageDataUrl: string,
  garmentImageDataUrl: string,
  prompt: string
): Record<string, unknown> {
  if (modelKey === "fashn") {
    // category mặc định "auto" hay đoán sai khi ảnh người mẫu gốc mặc váy liền thân + trang phục
    // tham chiếu chỉ là áo -> FASHN tự "bịa" thêm quần/váy mới thay vì giữ nguyên phần dưới gốc.
    // Ép cứng "tops" vì mọi ảnh trang phục dùng cho app này từ trước tới giờ đều là áo.
    return { model_image: modelImageDataUrl, garment_image: garmentImageDataUrl, category: "tops" };
  }
  return { prompt, image_urls: [modelImageDataUrl, garmentImageDataUrl] };
}

export async function submitOutfitSwapJob(
  userId: string,
  modelImageDataUrl: string,
  garmentImageDataUrls: string[],
  modelChoice: OutfitSwapModelKey,
  prompt: string,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  if (garmentImageDataUrls.length === 0) throw new Error("Cần ít nhất 1 ảnh trang phục tham chiếu");
  if (garmentImageDataUrls.length > MAX_GARMENTS) throw new Error(`Tối đa ${MAX_GARMENTS} ảnh trang phục mỗi lượt`);

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const modelsConfig = await getModelsConfig();
  const modelEntry = modelsConfig[modelChoice];
  if (!modelEntry?.enabled) throw new Error("Model đã chọn hiện không khả dụng");
  if (modelChoice === "generic" && !prompt.trim()) throw new Error("Thiếu câu lệnh mô tả");

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const perImageCredit = computeDynamicCreditCost(modelEntry.provider_cost_vnd, marginPercent, vndPerCredit);
  const totalCredit = perImageCredit * garmentImageDataUrls.length;

  const deduction = await deductCredit(userId, totalCredit, MINI_APP_ID, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const supabase = getSupabaseAdmin();

  const { data: job, error: jobError } = await supabase
    .from("outfit_swap_jobs")
    .insert({
      user_id: userId,
      model_image_url: modelImageDataUrl,
      model_choice: modelChoice,
      prompt: modelChoice === "generic" ? prompt : "",
      total_credit: totalCredit,
      credit_tx_id: deduction.txId,
      status: "processing",
    })
    .select("id")
    .single();

  if (jobError || !job) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw new Error(jobError?.message ?? "Không tạo được job thay trang phục");
  }

  const { data: items, error: itemsError } = await supabase
    .from("outfit_swap_job_items")
    .insert(garmentImageDataUrls.map((garmentImageUrl) => ({ job_id: job.id, garment_image_url: garmentImageUrl })))
    .select("id, garment_image_url");

  if (itemsError || !items) {
    if (deduction.txId) await refundCredit(deduction.txId);
    await supabase.from("outfit_swap_jobs").update({ status: "failed", error_message: itemsError?.message }).eq("id", job.id);
    throw new Error(itemsError?.message ?? "Không tạo được item thay trang phục");
  }

  // Submit song song lên Fal.ai queue — mỗi item 1 request riêng, KHÔNG đợi Fal.ai xử lý xong
  // (khác fal.run đồng bộ trước đây), submit xong là trả jobId về ngay cho client.
  await Promise.all(
    items.map(async (item) => {
      try {
        const webhookUrl = `${SITE_URL}/api/outfit-swap/webhook?itemId=${item.id}`;
        const response = await fetch(`https://queue.fal.run/${modelEntry.model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
          method: "POST",
          headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildFalRequestBody(modelChoice, modelImageDataUrl, item.garment_image_url, prompt)),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "Unknown Fal.ai error");
          throw new Error(`Fal.ai lỗi: ${response.status} ${errText}`);
        }

        const data = await response.json();
        await supabase.from("outfit_swap_job_items").update({ fal_request_id: data.request_id }).eq("id", item.id);
      } catch (err) {
        await supabase
          .from("outfit_swap_job_items")
          .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
          .eq("id", item.id);
      }
    })
  );

  // Bắt trường hợp MỌI item đều lỗi ngay lúc submit — không có item nào "processing" để tự trigger
  // chốt job qua webhook/poll về sau, nên phải chủ động kiểm tra ngay tại đây.
  await finalizeJobIfDone(job.id);

  return { jobId: job.id, newBalance: deduction.newBalance };
}
