// Proxy tải file (ảnh/video) từ CDN ngoài (fal.media, FASHN...) về máy user.
// Thẻ <a download> không hoạt động với URL cross-origin — trình duyệt chỉ mở tab xem thay vì tải.
// Route này fetch hộ rồi trả về kèm Content-Disposition: attachment để ép tải đúng cách.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  const filename = searchParams.get("filename") || "tai-xuong";

  if (!url || (!url.startsWith("https://") && !url.startsWith("http://"))) {
    return Response.json({ error: "URL không hợp lệ" }, { status: 400 });
  }

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: "Không tải được file từ nguồn" }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";

  return new Response(upstream.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
