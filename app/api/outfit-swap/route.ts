import { randomUUID } from "crypto";
import { submitOutfitSwapJob, getEnabledOutfitSwapModels, type OutfitSwapModelKey, type GarmentCategory } from "@/lib/outfit-swap";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function GET() {
  const models = await getEnabledOutfitSwapModels();
  return Response.json({ models });
}

// Submit job bất đồng bộ — trả về ngay jobId, KHÔNG đợi Fal.ai xử lý xong (xem lib/outfit-swap.ts).
// Frontend tự poll /api/outfit-swap/status để lấy kết quả.
export async function POST(req: Request) {
  const { modelImageDataUrl, garmentImageDataUrls, garmentCategories, modelChoice, prompt } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof modelImageDataUrl !== "string" || !modelImageDataUrl) {
    return Response.json({ error: "Thiếu ảnh người mẫu" }, { status: 400 });
  }
  if (!Array.isArray(garmentImageDataUrls) || garmentImageDataUrls.length === 0) {
    return Response.json({ error: "Cần ít nhất 1 ảnh trang phục tham chiếu" }, { status: 400 });
  }
  if (
    !Array.isArray(garmentCategories) ||
    garmentCategories.length !== garmentImageDataUrls.length ||
    !garmentCategories.every((c: unknown) => c === "tops" || c === "one-pieces")
  ) {
    return Response.json({ error: "Thiếu loại trang phục (Áo/Cả bộ)" }, { status: 400 });
  }
  if (modelChoice !== "generic" && modelChoice !== "fashn" && modelChoice !== "fashn_max") {
    return Response.json({ error: "Thiếu lựa chọn model" }, { status: 400 });
  }

  try {
    const result = await submitOutfitSwapJob(
      userId,
      modelImageDataUrl,
      garmentImageDataUrls,
      garmentCategories as GarmentCategory[],
      modelChoice as OutfitSwapModelKey,
      typeof prompt === "string" ? prompt : "",
      randomUUID()
    );
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
