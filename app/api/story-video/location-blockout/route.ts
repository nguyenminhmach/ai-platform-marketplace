import { generateLocationBlockout } from "@/lib/story-video";
import { getAuthenticatedUserId } from "@/lib/auth-server";
import { getLocationBlockout, saveLocationBlockout } from "@/lib/location-blockouts";

// SỬA (phản hồi thật user: "trên app không thấy" — dữ liệu CÓ trong DB, nhưng app chỉ lấy lại khi khách
// chủ động bấm nút "Dựng khối 3D" lần nữa, không tự hiện khi mở lại ảnh) — thêm GET chỉ kiểm tra cache,
// KHÔNG BAO GIỜ gọi AI (khác hẳn POST bên dưới) — gọi tự động mỗi khi mở khung chọn vị trí cho 1 ảnh,
// để khối 3D đã tạo trước đó tự hiện lại ngay, không cần khách nhớ bấm nút. An toàn về chi phí: ảnh chưa
// từng tạo khối 3D thì GET này trả về rỗng, không tốn tiền AI gì cả — chỉ ảnh ĐÃ tạo rồi mới có gì để
// trả về.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const imageUrl = searchParams.get("imageUrl");

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!imageUrl) return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });

  try {
    const cached = await getLocationBlockout(userId, imageUrl);
    return Response.json(cached ?? { depthImageUrl: null, groundMaskUrl: null, isNaturalTerrain: true, horizonY: 0.5 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}

// Khách bấm nút "🧱 Dựng khối 3D" ở khung "Chọn vị trí đứng" (xem VideoTuYTuongClient.tsx) — chủ động
// kích hoạt, KHÔNG tự gọi lúc gắn ảnh (đã bàn kỹ với user: gọi quá sớm dễ tốn tiền cho ảnh khách chỉ
// gắn thử, chưa chắc dùng). Chỉ cần đăng nhập, không gắn với 1 job cụ thể nào — ảnh bối cảnh ở đây
// sống trong kho tham chiếu chung, dùng lại được nhiều lần (xem lib/reference-elements.ts).
// SỬA (phản hồi thật user: "khi tạo hình xong restart máy thì hình đã tạo bị mất") — trước đây kết quả
// chỉ sống trong React state (RAM trình duyệt), tải lại trang là mất, bấm lại nút này gọi lại AI từ đầu
// (tốn thêm tiền). Giờ kiểm tra DB (lib/location-blockouts.ts) TRƯỚC — có rồi thì trả về ngay, KHÔNG gọi
// lại AI; chưa có thì mới gọi generateLocationBlockout rồi lưu xuống DB cho lần sau.
export async function POST(req: Request) {
  const { imageUrl } = await req.json();

  const userId = await getAuthenticatedUserId();
  if (!userId) return Response.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (typeof imageUrl !== "string" || !imageUrl) {
    return Response.json({ error: "Thiếu imageUrl" }, { status: 400 });
  }

  try {
    const cached = await getLocationBlockout(userId, imageUrl).catch(() => null);
    if (cached) return Response.json(cached);

    const result = await generateLocationBlockout(imageUrl);
    await saveLocationBlockout(userId, { imageUrl, ...result }).catch(() => {
      // Lưu DB lỗi (bảng chưa tồn tại, mất kết nối...) không chặn trả kết quả cho khách — chỉ mất tác
      // dụng cache cho lần sau, khách vẫn thấy khối 3D bình thường ở lần này.
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
