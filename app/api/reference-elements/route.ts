import { getAuthenticatedUserId } from "@/lib/auth-server";
import { createReferenceElement, listReferenceElements, REFERENCE_ELEMENT_TYPES, type ReferenceElementType } from "@/lib/reference-elements";

// GET: liệt kê kho tham chiếu của user, lọc tuỳ chọn theo ?type=character|location|prop.
// POST: thêm 1 phần tử mới (Yếu tố mới) — ảnh phải upload trước qua /api/reference-elements/upload.
export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const typeParam = searchParams.get("type");
  const type = typeParam && (REFERENCE_ELEMENT_TYPES as readonly string[]).includes(typeParam) ? (typeParam as ReferenceElementType) : undefined;

  try {
    const elements = await listReferenceElements(userId, type);
    return Response.json({ elements });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const body = await req.json();
  const { type, name, elementId, description, imageUrls } = body ?? {};
  if (!type || !name || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return Response.json({ error: "Thiếu type/name/imageUrls" }, { status: 400 });
  }

  try {
    const element = await createReferenceElement(userId, {
      type,
      name,
      elementId: typeof elementId === "string" ? elementId : undefined,
      description: typeof description === "string" ? description : undefined,
      imageUrls,
    });
    return Response.json({ element });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 400 });
  }
}
