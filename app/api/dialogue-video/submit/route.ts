import { randomUUID } from "crypto";
import { submitDialogueVideoJob, MIN_CHARACTERS, MAX_CHARACTERS } from "@/lib/dialogue-video";
import { InsufficientCreditError } from "@/lib/credit-system";
import { getAuthenticatedUserId } from "@/lib/auth-server";

const LINE_MAX_LENGTH = 400;

export async function POST(req: Request) {
  const { miniAppId, characters } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof miniAppId !== "string" || !miniAppId) return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  if (!Array.isArray(characters) || characters.length < MIN_CHARACTERS || characters.length > MAX_CHARACTERS) {
    return Response.json({ error: `Cần từ ${MIN_CHARACTERS} đến ${MAX_CHARACTERS} nhân vật` }, { status: 400 });
  }
  for (const c of characters) {
    if (typeof c?.imageUrl !== "string" || !c.imageUrl) {
      return Response.json({ error: "Thiếu ảnh cho 1 nhân vật" }, { status: 400 });
    }
    if (typeof c?.line !== "string" || !c.line.trim()) {
      return Response.json({ error: "Thiếu lời thoại cho 1 nhân vật" }, { status: 400 });
    }
    if (c.line.length > LINE_MAX_LENGTH) {
      return Response.json({ error: `Lời thoại tối đa ${LINE_MAX_LENGTH} ký tự mỗi người` }, { status: 400 });
    }
  }

  try {
    const result = await submitDialogueVideoJob(
      userId,
      miniAppId,
      characters.map((c: { imageUrl: string; line: string }) => ({ imageUrl: c.imageUrl, line: c.line.trim() })),
      randomUUID()
    );
    return Response.json({ success: true, jobId: result.jobId, newBalance: result.newBalance });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return Response.json({ error: "Không đủ credit", code: "INSUFFICIENT_CREDIT" }, { status: 402 });
    }
    console.error(err);
    return Response.json({ error: "Có lỗi xảy ra, credit đã được hoàn (nếu đã trừ)" }, { status: 500 });
  }
}
