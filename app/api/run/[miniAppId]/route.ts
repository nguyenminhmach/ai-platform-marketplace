import { randomUUID } from "crypto";
import { runMiniApp } from "@/lib/ai-router";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ miniAppId: string }> }
) {
  const { miniAppId } = await params;
  const { input, imageDataUrl } = await req.json();

  // userId LUÔN lấy từ session đã xác thực (cookie), KHÔNG tin client gửi trong body — trước đây ai
  // biết userId người khác đều gọi được route này trừ credit của họ.
  const userId = await getAuthenticatedUserId();
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
