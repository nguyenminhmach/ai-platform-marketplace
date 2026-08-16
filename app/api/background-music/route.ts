import { getSupabaseAdmin } from "@/lib/supabase";

// Danh sách nhạc nền cho user chọn khi ghép vào video kết quả — public, không cần đăng nhập.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("background_music")
    .select("id, name, file_url")
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ tracks: data });
}
