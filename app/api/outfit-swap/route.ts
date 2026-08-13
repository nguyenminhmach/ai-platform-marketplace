import { randomUUID } from "crypto";
import { runOutfitSwap, getOutfitSwapPricePerImage, DEFAULT_OUTFIT_SWAP_PROMPT } from "@/lib/outfit-swap";
import { InsufficientCreditError } from "@/lib/credit-system";

// Tối đa 10 ảnh chạy song song, mỗi ảnh có thể mất 5-15s — dài hơn giới hạn mặc định 10s của Vercel Hobby.
export const maxDuration = 60;

export async function GET() {
  const pricePerImage = await getOutfitSwapPricePerImage();
  return Response.json({ pricePerImage, defaultPrompt: DEFAULT_OUTFIT_SWAP_PROMPT });
}

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
    const result = await runOutfitSwap(userId, modelImageDataUrl, garmentImageDataUrls, prompt, randomUUID());
    return Response.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
