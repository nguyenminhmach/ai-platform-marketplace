import { getAuthenticatedUserId } from "@/lib/auth-server";
import { deleteReferenceElement, updateReferenceElement } from "@/lib/reference-elements";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const elementId = Number(id);
  if (!Number.isFinite(elementId)) return Response.json({ error: "ID không hợp lệ" }, { status: 400 });

  const body = await req.json();
  const { name, description, imageUrls } = body ?? {};

  try {
    const element = await updateReferenceElement(userId, elementId, {
      name: typeof name === "string" ? name : undefined,
      description: description === null || typeof description === "string" ? description : undefined,
      imageUrls: Array.isArray(imageUrls) ? imageUrls : undefined,
    });
    return Response.json({ element });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { id } = await params;
  const elementId = Number(id);
  if (!Number.isFinite(elementId)) return Response.json({ error: "ID không hợp lệ" }, { status: 400 });

  try {
    await deleteReferenceElement(userId, elementId);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
