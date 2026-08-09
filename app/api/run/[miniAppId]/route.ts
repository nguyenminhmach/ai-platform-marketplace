import { randomUUID } from "crypto";
import { runMiniApp } from "@/lib/ai-router";
import { InsufficientCreditError } from "@/lib/credit-system";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ miniAppId: string }> }
) {
  const { miniAppId } = await params;
  const { input, userId, imageDataUrl } = await req.json();

  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  const hasText = typeof input === "string" && input.trim() !== "";
  const hasImage = typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image/");
  if (!hasText && !hasImage) {
    return Response.json({ error: "Thiếu input" }, { status: 400 });
  }

  try {
    const result = await runMiniApp(miniAppId, hasText ? input : "", userId, randomUUID(), hasImage ? imageDataUrl : undefined);
    return Response.json({ success: true, output: result.output, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json(
        { error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" },
        { status: 402 }
      );
    }
    console.error(err);
    return Response.json({ error: "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
