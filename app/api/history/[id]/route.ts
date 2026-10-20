import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deleteGenerationHistoryItem } from "@/lib/generation-history";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  try {
    // SỬA (phản hồi thật user: lo ngại tích rác dung lượng Supabase) — giờ xoá CẢ file thật trong
    // Storage (video/ảnh tải lên), không chỉ xoá bản ghi DB như trước — xem lib/generation-history.ts.
    await deleteGenerationHistoryItem(userId, Number(id));
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
