import { saveStoryCharacter, listStoryCharacters, deleteStoryCharacter } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";

// Thư viện Character tái sử dụng — GET liệt kê Character khách đã lưu (chọn lại thay vì tải ảnh + tốn
// credit tạo Character mới), POST lưu 1 Character sheet vừa duyệt ưng ý vào thư viện, DELETE xoá bớt.
export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  try {
    const characters = await listStoryCharacters(userId);
    return Response.json({ characters });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { imageUrl, label, jobId } = await req.json();
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof imageUrl !== "string" || !imageUrl) return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });

  try {
    const id = await saveStoryCharacter(
      userId,
      imageUrl,
      typeof label === "string" ? label : undefined,
      typeof jobId === "number" ? jobId : undefined
    );
    return Response.json({ success: true, id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get("id"));
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!id) return Response.json({ error: "Thiếu id" }, { status: 400 });

  try {
    await deleteStoryCharacter(userId, id);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
