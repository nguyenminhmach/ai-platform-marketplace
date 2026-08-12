import { getSupabaseAdmin } from "@/lib/supabase";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId } = await req.json();
  if (!userId) return Response.json({ error: "Thiếu userId" }, { status: 400 });

  const supabase = getSupabaseAdmin();

  // Chỉ xoá được dòng thuộc đúng chủ tài khoản — chặn xoá hộ người khác
  const { error } = await supabase.from("generation_history").delete().eq("id", id).eq("user_id", userId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true });
}
