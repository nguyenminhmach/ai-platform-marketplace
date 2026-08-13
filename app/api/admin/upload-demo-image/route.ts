import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// Nhận ảnh dạng data URL từ /admin, upload lên bucket "demo-images", trả về public URL để lưu vào
// mini_apps.model_config.demo_image_urls qua PATCH /api/admin/mini-apps — tránh nhét base64 nặng vào JSON.
export async function POST(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { appId, dataUrl } = await req.json();
  if (typeof appId !== "string" || !appId) {
    return Response.json({ error: "Thiếu appId" }, { status: 400 });
  }
  const match = typeof dataUrl === "string" ? dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
  if (!match) {
    return Response.json({ error: "Ảnh không hợp lệ" }, { status: 400 });
  }
  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength > 4 * 1024 * 1024) {
    return Response.json({ error: "Ảnh tối đa 4MB" }, { status: 400 });
  }

  const ext = mimeType.split("/")[1] || "jpg";
  const filePath = `${appId}/${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from("demo-images")
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) return Response.json({ error: uploadError.message }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("demo-images").getPublicUrl(filePath);
  return Response.json({ url: publicUrlData.publicUrl });
}
