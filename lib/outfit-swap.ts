// "Thay trang phục cho người mẫu" — 1 ảnh người mẫu + tối đa N ảnh trang phục tham chiếu, ghép qua
// Fal.ai Nano Banana Pro Edit (fal-ai/gemini-3-pro-image-preview/edit), MỖI bộ đồ = 1 lần gọi riêng
// (model chỉ nhận tối đa 2 ảnh/lần). Khác các app ảnh khác: giá tính theo SỐ LƯỢNG bộ đồ đưa vào
// (không cố định 1 mức), nên không dùng chung getMiniAppConfig()/runMiniApp().
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
const MODEL = "fal-ai/gemini-3-pro-image-preview/edit";
const MAX_GARMENTS = 10; // không còn giới hạn bởi thời gian chờ 1 request nữa (đã chuyển bất đồng bộ)
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export const DEFAULT_OUTFIT_SWAP_PROMPT =
  "Giữ nguyên khuôn mặt, dáng người, tư thế, biểu cảm, góc chụp, ánh sáng và bối cảnh của ảnh người mẫu. Giữ nguyên mọi phụ kiện và đồ vật người mẫu đang cầm/đeo (điện thoại, túi xách, trang sức...) — không thay đổi hình dạng, màu sắc hay vị trí của chúng. Chỉ thay trang phục của người mẫu bằng đúng bộ trang phục trong ảnh tham chiếu — giữ đúng kiểu dáng, màu sắc, hoạ tiết và chất liệu của trang phục đó.";

async function getProviderCostVnd(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mini_apps")
    .select("model_config")
    .eq("id", MINI_APP_ID)
    .eq("is_active", true)
    .single();

  if (error || !data) throw new Error("Không tìm thấy app Thay trang phục");
  const config = data.model_config as { provider_cost_vnd: number };
  return config.provider_cost_vnd;
}

/** Giá credit cho 1 bộ đồ — trang chủ/trang chi tiết gọi hàm này để hiện giá trước khi chạy. */
export async function getOutfitSwapPricePerImage(): Promise<number> {
  const providerCostVnd = await getProviderCostVnd();
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  return computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);
}

export async function submitOutfitSwapJob(
  userId: string,
  modelImageDataUrl: string,
  garmentImageDataUrls: string[],
  prompt: string,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  if (garmentImageDataUrls.length === 0) throw new Error("Cần ít nhất 1 ảnh trang phục tham chiếu");
  if (garmentImageDataUrls.length > MAX_GARMENTS) throw new Error(`Tối đa ${MAX_GARMENTS} ảnh trang phục mỗi lượt`);

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const perImageCredit = await getOutfitSwapPricePerImage();
  const totalCredit = perImageCredit * garmentImageDataUrls.length;

  const deduction = await deductCredit(userId, totalCredit, MINI_APP_ID, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const supabase = getSupabaseAdmin();

  const { data: job, error: jobError } = await supabase
    .from("outfit_swap_jobs")
    .insert({
      user_id: userId,
      model_image_url: modelImageDataUrl,
      prompt,
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
        const response = await fetch(`https://queue.fal.run/${MODEL}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
          method: "POST",
          headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, image_urls: [modelImageDataUrl, item.garment_image_url] }),
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
