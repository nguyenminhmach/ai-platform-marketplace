import { randomUUID } from "crypto";
import { submitOutfitSwapJob, getOutfitSwapPricePerImage, DEFAULT_OUTFIT_SWAP_PROMPT } from "@/lib/outfit-swap";
import { InsufficientCreditError } from "@/lib/credit-system";

export async function GET() {
  const pricePerImage = await getOutfitSwapPricePerImage();
  return Response.json({ pricePerImage, defaultPrompt: DEFAULT_OUTFIT_SWAP_PROMPT });
}

// Submit job bất đồng bộ — trả về ngay jobId, KHÔNG đợi Fal.ai xử lý xong (xem lib/outfit-swap.ts).
// Frontend tự poll /api/outfit-swap/status để lấy kết quả.
export async function POST(req: Request) {
  const { userId, modelImageDataUrl, garmentImageDataUrls, prompt } = await req.json();

  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof modelImageDataUrl !== "string" || !modelImageDataUrl) {
    return Response.json({ error: "Thiếu ảnh người mẫu" }, { status: 400 });
  }
  if (!Array.isArray(garmentImageDataUrls) || garmentImageDataUrls.length === 0) {
    return Response.json({ error: "Cần ít nhất 1 ảnh trang phục tham chiếu" }, { status: 400 });
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return Response.json({ error: "Thiếu câu lệnh mô tả" }, { status: 400 });
  }

  try {
    const result = await submitOutfitSwapJob(userId, modelImageDataUrl, garmentImageDataUrls, prompt, randomUUID());
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
