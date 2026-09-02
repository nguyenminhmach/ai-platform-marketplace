import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Upload 1 ảnh input (người mẫu hoặc trang phục tham chiếu) lên Supabase Storage TRƯỚC khi submit
// job — tránh gửi base64 nặng gộp chung trong request chạy AI, vốn hay bị Vercel chặn 413 khi có
// nhiều ảnh (xem lib/outfit-swap.ts). Không cần đăng nhập admin, đây là route người dùng thường gọi.
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
  // Giới hạn 3MB (không phải 4MB) vì base64 encode làm phình ~33% — 1 ảnh 4MB raw thành ~5.3MB base64,
  // đủ để tự nó vượt giới hạn ~4.5MB/request của Vercel dù chỉ upload riêng 1 ảnh.
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength > 3 * 1024 * 1024) {
    return Response.json({ error: "Ảnh tối đa 3MB" }, { status: 400 });
  }

  const ext = mimeType.split("/")[1] || "jpg";
  const filePath = `${userId}/${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from("outfit-swap-uploads")
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) return Response.json({ error: uploadError.message }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("outfit-swap-uploads").getPublicUrl(filePath);
  return Response.json({ url: publicUrlData.publicUrl });
}
