import { randomUUID } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import { verifyAdminToken, ADMIN_COOKIE_NAME } from "@/lib/admin-auth";

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
}

// Quản lý thư viện nhạc nền (admin upload sẵn) — user chọn 1 bài trong danh sách này để ghép vào
// video AI tạo ra, không phải AI tự sinh nhạc hay user tự upload file lạ.
export async function GET(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("background_music").select("*").order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ tracks: data });
}

export async function POST(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { name, dataUrl } = await req.json();
  if (typeof name !== "string" || !name.trim()) {
    return Response.json({ error: "Thiếu tên bài nhạc" }, { status: 400 });
  }
  const match = typeof dataUrl === "string" ? dataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/) : null;
  if (!match) {
    return Response.json({ error: "File nhạc không hợp lệ (cần mp3/wav/m4a)" }, { status: 400 });
  }
  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength > 10 * 1024 * 1024) {
    return Response.json({ error: "File nhạc tối đa 10MB" }, { status: 400 });
  }

  const ext = mimeType.split("/")[1] || "mp3";
  const filePath = `${randomUUID()}.${ext}`;

  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from("background-music")
    .upload(filePath, buffer, { contentType: mimeType, upsert: true });
  if (uploadError) return Response.json({ error: uploadError.message }, { status: 500 });

  const { data: publicUrlData } = supabase.storage.from("background-music").getPublicUrl(filePath);

  const { data: track, error: insertError } = await supabase
    .from("background_music")
    .insert({ name: name.trim(), file_url: publicUrlData.publicUrl })
    .select()
    .single();
  if (insertError) return Response.json({ error: insertError.message }, { status: 500 });

  return Response.json({ track });
}

export async function DELETE(req: Request) {
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  if (!verifyAdminToken(token)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "Thiếu id" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("background_music").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}
