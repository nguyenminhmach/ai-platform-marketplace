// "Thay trang phục cho người mẫu" — 1 ảnh người mẫu + tối đa N ảnh trang phục tham chiếu, ghép qua
// AI, MỖI bộ đồ = 1 lần gọi riêng. Khác các app ảnh khác: giá tính theo SỐ LƯỢNG bộ đồ đưa vào
// (không cố định 1 mức), nên không dùng chung getMiniAppConfig()/runMiniApp().
//
// Hỗ trợ SONG SONG 3 model, admin bật/tắt từng cái qua model_config.models.{generic,fashn,fashn_max}.enabled:
// - "generic": Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit, qua Fal.ai) — nhận câu
//   lệnh mô tả tự do, đa năng nhưng hay nhầm lẫn "lấy người nào làm gốc" khi ảnh trang phục tham
//   chiếu là ảnh người khác mặc sẵn (đã kiểm chứng qua test thật).
// - "fashn": FASHN Virtual Try-On v1.6 (fal-ai/fashn/tryon/v1.6, qua Fal.ai) — API có cấu trúc
//   (model_image + garment_image, KHÔNG nhận prompt tự do), rẻ hơn, ổn định hơn cho phần lớn trường hợp.
// - "fashn_max": FASHN Try-On Max — chất lượng/fidelity cao hơn v1.6, NHƯNG chạy qua API RIÊNG của
//   chính FASHN (api.fashn.ai), không qua Fal.ai, cần FASHN_API_KEY riêng. Có prompt (chỉ để chỉnh
//   nhỏ như "bỏ khăn", không phải prompt tự do toàn phần).
// Nếu nhiều hơn 1 model bật, người dùng tự chọn; mặc định ưu tiên FASHN nếu có bật.
//
// Chạy BẤT ĐỒNG BỘ — submit xong trả về ngay, không giữ 1 request chờ tới khi xong. Lý do: test thực
// tế 6 ảnh song song từng bị Vercel Hobby giết ở mốc 60s (maxDuration tối đa cho phép), mất credit
// không hoàn vì function bị kill cứng giữa chừng. Model qua Fal.ai dùng queue.fal.run + webhook;
// "fashn_max" qua api.fashn.ai KHÔNG có webhook, chỉ poll (xem lib/outfit-swap-jobs.ts).

import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, InsufficientCreditError } from "@/lib/credit-system";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";
import { finalizeJobIfDone } from "@/lib/outfit-swap-jobs";

const MINI_APP_ID = "thay-trang-phuc";
const MAX_GARMENTS = 10; // không còn giới hạn bởi thời gian chờ 1 request nữa (đã chuyển bất đồng bộ)
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export type OutfitSwapModelKey = "generic" | "fashn" | "fashn_max";

type ModelEntry = { model: string; provider_cost_vnd: number; enabled: boolean };
type ModelsConfig = Partial<Record<OutfitSwapModelKey, ModelEntry>>;

const MODEL_LABELS: Record<OutfitSwapModelKey, string> = {
  generic: "AI đa năng (tuỳ chỉnh câu lệnh)",
  fashn: "AI chuyên thử đồ (nhanh, rẻ hơn)",
  fashn_max: "AI chuyên thử đồ (chất lượng cao)",
};

const PREFERRED_DEFAULT_ORDER: OutfitSwapModelKey[] = ["fashn", "fashn_max", "generic"];

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

  return PREFERRED_DEFAULT_ORDER.filter((key) => modelsConfig[key]?.enabled).map((key) => ({
    key,
    label: MODEL_LABELS[key],
    pricePerImage: computeDynamicCreditCost(modelsConfig[key]!.provider_cost_vnd, marginPercent, vndPerCredit),
    hasPrompt: key !== "fashn",
  }));
}

function buildFalRequestBody(
  modelKey: "generic" | "fashn",
  modelImageDataUrl: string,
  garmentImageDataUrl: string,
  prompt: string
): Record<string, unknown> {
  if (modelKey === "fashn") {
    // ĐÃ THỬ ép cứng category: "tops" cho mọi ảnh — SAI, vì không phải ảnh trang phục nào cũng là
    // áo rời (có ảnh là váy liền thân), ép sai loại khiến FASHN phải tự bịa thêm quần cho đủ bộ.
    // Bỏ ép, để "auto" tự nhận diện đúng loại từng ảnh (áo/quần/váy liền thân).
    //
    // segmentation_free mặc định true (không phân vùng rõ ràng) — tài liệu FASHN ghi rõ: nếu trang
    // phục gốc không được loại bỏ đúng cách, đặt false để bật lại chế độ phân vùng chính xác hơn.
    return {
      model_image: modelImageDataUrl,
      garment_image: garmentImageDataUrl,
      segmentation_free: false,
    };
  }
  return { prompt, image_urls: [modelImageDataUrl, garmentImageDataUrl] };
}

/** Submit 1 item lên FASHN Try-On Max (api.fashn.ai riêng, không qua Fal.ai) — trả về prediction id. */
async function submitFashnMaxItem(modelImageUrl: string, garmentImageUrl: string, prompt: string): Promise<string> {
  const apiKey = process.env.FASHN_API_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FASHN_API_KEY trong .env.local");

  const inputs: Record<string, unknown> = { product_image: garmentImageUrl, model_image: modelImageUrl, num_images: 1 };
  if (prompt.trim()) inputs.prompt = prompt.trim();

  const response = await fetch("https://api.fashn.ai/v1/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: "tryon-max", inputs }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown FASHN error");
    throw new Error(`FASHN lỗi: ${response.status} ${errText}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`FASHN lỗi: ${data.error}`);
  return data.id as string;
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

  const modelsConfig = await getModelsConfig();
  const modelEntry = modelsConfig[modelChoice];
  if (!modelEntry?.enabled) throw new Error("Model đã chọn hiện không khả dụng");
  if (modelChoice === "generic" && !prompt.trim()) throw new Error("Thiếu câu lệnh mô tả");

  const falApiKey = process.env.FAL_KEY;
  if (modelChoice !== "fashn_max" && !falApiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

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
      prompt: modelChoice !== "fashn" ? prompt : "",
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
    .insert(
      garmentImageDataUrls.map((garmentImageUrl) => ({
        job_id: job.id,
        garment_image_url: garmentImageUrl,
        provider: modelChoice === "fashn_max" ? "fashn_direct" : "fal",
      }))
    )
    .select("id, garment_image_url");

  if (itemsError || !items) {
    if (deduction.txId) await refundCredit(deduction.txId);
    await supabase.from("outfit_swap_jobs").update({ status: "failed", error_message: itemsError?.message }).eq("id", job.id);
    throw new Error(itemsError?.message ?? "Không tạo được item thay trang phục");
  }

  // Submit song song — mỗi item 1 request riêng, KHÔNG đợi xử lý xong, submit xong trả jobId ngay.
  await Promise.all(
    items.map(async (item) => {
      try {
        if (modelChoice === "fashn_max") {
          // api.fashn.ai không có webhook — chỉ lưu prediction id, việc chốt kết quả dựa hoàn toàn
          // vào poll từ frontend (/api/outfit-swap/status) + cron sweep dự phòng.
          const predictionId = await submitFashnMaxItem(modelImageDataUrl, item.garment_image_url, prompt);
          await supabase.from("outfit_swap_job_items").update({ fal_request_id: predictionId }).eq("id", item.id);
          return;
        }

        const webhookUrl = `${SITE_URL}/api/outfit-swap/webhook?itemId=${item.id}`;
        const response = await fetch(`https://queue.fal.run/${modelEntry.model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
          method: "POST",
          headers: { Authorization: `Key ${falApiKey}`, "Content-Type": "application/json" },
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
