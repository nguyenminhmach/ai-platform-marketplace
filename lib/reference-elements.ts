import { getSupabaseAdmin } from "@/lib/supabase";

// Kho tham chiếu chung (reference pool) — thay thế dần cho hệ thống ô cố định (Nhân vật 1-4/Bối
// cảnh/Vật phẩm). Mỗi "element" thuộc về 1 user (dùng lại được qua nhiều dự án, không scope theo job),
// có 1 element_id duy nhất (@tên) dùng để @mention trong mô tả cảnh — xem mục 13 kế hoạch đã lưu
// (D:\quy tắc camera\Ke hoach Camera va Anh sang - Mannequin Preview.docx). KHÔNG đụng tới
// character_sheet_url/location_reference_url/item_reference_urls cũ — 2 hệ thống chạy song song cho
// tới khi hệ thống mới được nối vào Agent + luồng tạo ảnh (giai đoạn sau, chưa làm ở bước này).

export const REFERENCE_ELEMENT_TYPES = ["character", "location", "prop"] as const;
export type ReferenceElementType = (typeof REFERENCE_ELEMENT_TYPES)[number];

export type ReferenceElement = {
  id: number;
  user_id: string;
  type: ReferenceElementType;
  name: string;
  element_id: string;
  description: string | null;
  image_urls: string[];
  created_at: string;
};

// @tên chỉ cho phép chữ thường/số/gạch dưới, không dấu, không khoảng trắng — để match an toàn bằng
// regex đơn giản trong scene_description sau này (xem kế hoạch mục 13.3), không cần NLP.
const ELEMENT_ID_PATTERN = /^[a-z0-9_]+$/;

function slugifyElementId(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function listReferenceElements(userId: string, type?: ReferenceElementType): Promise<ReferenceElement[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("reference_elements").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  if (type) query = query.eq("type", type);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ReferenceElement[];
}

export async function createReferenceElement(
  userId: string,
  input: { type: ReferenceElementType; name: string; elementId?: string; description?: string; imageUrls: string[] }
): Promise<ReferenceElement> {
  if (!REFERENCE_ELEMENT_TYPES.includes(input.type)) throw new Error("Loại tham chiếu không hợp lệ");
  if (!input.name?.trim()) throw new Error("Thiếu tên");
  if (!input.imageUrls?.length) throw new Error("Thiếu ảnh tham chiếu");

  const rawElementId = input.elementId?.trim() || input.name;
  const elementId = slugifyElementId(rawElementId);
  if (!elementId || !ELEMENT_ID_PATTERN.test(elementId)) {
    throw new Error("ID phần tử không hợp lệ (chỉ chữ thường/số/gạch dưới)");
  }

  const supabase = getSupabaseAdmin();
  // unique index (user_id, element_id) ở DB tự chặn trùng — bắt lỗi 23505 trả thông báo dễ hiểu hơn.
  const { data, error } = await supabase
    .from("reference_elements")
    .insert({
      user_id: userId,
      type: input.type,
      name: input.name.trim(),
      element_id: elementId,
      description: input.description?.trim() || null,
      image_urls: input.imageUrls,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error(`ID phần tử "@${elementId}" đã tồn tại, hãy chọn tên khác`);
    throw new Error(error.message);
  }
  return data as ReferenceElement;
}

export async function deleteReferenceElement(userId: string, id: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("reference_elements").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function updateReferenceElement(
  userId: string,
  id: number,
  patch: Partial<{ name: string; description: string | null; imageUrls: string[] }>
): Promise<ReferenceElement> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.imageUrls !== undefined) update.image_urls = patch.imageUrls;
  const { data, error } = await supabase
    .from("reference_elements")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as ReferenceElement;
}

// Quét @tên trong 1 đoạn mô tả cảnh, trả về đúng các element khớp — dùng ở bước sau (nối vào Agent +
// luồng tạo ảnh), chưa gọi ở đâu tại bước này. Giữ ở đây để sẵn khi cần, test độc lập được ngay.
export function extractMentionedElementIds(sceneDescription: string): string[] {
  const matches = sceneDescription.match(/@([a-z0-9_]+)/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

export function filterElementsByMentions(elements: ReferenceElement[], mentionedIds: string[]): ReferenceElement[] {
  const set = new Set(mentionedIds);
  return elements.filter((el) => set.has(el.element_id));
}
