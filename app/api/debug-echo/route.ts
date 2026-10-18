// Route CHẨN ĐOÁN TẠM THỜI — đo xem Vercel/Next.js nhận request body lớn có chậm hay không, tách biệt
// khỏi mọi logic thật (không auth, không Supabase, không parse JSON phức tạp) — xem thêm ghi chú lỗi
// "tải ảnh bị treo 30s với body lớn" đã trao đổi với user. XOÁ FILE NÀY sau khi chẩn đoán xong.
export async function POST(req: Request) {
  const start = Date.now();
  const text = await req.text();
  const elapsed = Date.now() - start;
  return Response.json({ bytesReceived: text.length, elapsedMs: elapsed });
}
