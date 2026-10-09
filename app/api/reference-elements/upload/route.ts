import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Upload 1 ảnh cho kho tham chiếu (Nhân vật/Địa điểm/Đạo cụ) lên Supabase Storage TRƯỚC khi gọi
// createReferenceElement — mirror đúng outfit-swap/upload/route.ts (cùng lý do: tránh gửi base64 nặng
// gộp chung request, dễ bị Vercel chặn 413).
export async function POST(req: Request) {
  const { dataUrl } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  const match = typeof dataUrl === "string" ? dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
  if (!match) {
    return Response.json({ error: "Ảnh không hợp lệ" }, { status: 400 });
  }
  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength > 3 * 1024 * 1024) {
    return Response.json({ error: "Ảnh tối đa 3MB" }, { status: 400 });
  }

  const ext = mimeType.split("/")[1] || "jpg";
  const filePath = `${userId}/${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from("reference-element-uploads")
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) return Response.json({ error: uploadError.message }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("reference-element-uploads").getPublicUrl(filePath);
  return Response.json({ url: publicUrlData.publicUrl });
}
