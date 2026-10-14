import { getAuthenticatedUserId } from "@/lib/auth-server";
import { createPromptUpload, deletePromptUpload, listPromptUploads } from "@/lib/prompt-uploads";

// GET: liệt kê ảnh đã tải lên qua nút "+" ở tab "Tải lên" (ReferencePickerModal) — lưu thành thư
// viện riêng của user, mở modal lần sau vẫn thấy.
// POST: ghi lại 1 ảnh vừa upload xong qua /api/outfit-swap/upload (chỉ lưu URL, không upload lại).
// DELETE: khách bấm "Xoá" trên 1 ảnh trong thư viện — xoá cả bản ghi DB và file gốc trong Storage.
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  try {
    const uploads = await listPromptUploads(userId);
    return Response.json({ uploads });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const body = await req.json();
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return Response.json({ error: "Thiếu url" }, { status: 400 });

  try {
    const upload = await createPromptUpload(userId, url);
    return Response.json({ upload });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const body = await req.json();
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return Response.json({ error: "Thiếu url" }, { status: 400 });

  try {
    await deletePromptUpload(userId, url);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 400 });
  }
}
