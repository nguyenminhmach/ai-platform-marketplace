import { supabaseBrowser } from "@/lib/supabase-browser";

// SỬA (bug thật đo được bằng curl -v): đường truyền từ máy khách tới IP Vercel bị nghẽn nặng khi gửi
// body lớn — route trống chỉ làm `await req.text()` cũng treo y như route upload thật, loại hẳn khả
// năng do code/app logic/Supabase. Ảnh base64 ~800KB từng mất 30s+ không xong dù route tới IP khác
// (httpbin.org) nhận cùng dung lượng trong ~5s. Fix: không gửi bytes ảnh qua Vercel nữa — xin 1 "signed
// upload URL" từ route nhỏ (vài trăm byte, luôn nhanh), rồi trình duyệt tải thẳng lên Supabase Storage
// bằng URL đó, bỏ qua hẳn chặng nghẽn.
function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string; ext: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("Ảnh không hợp lệ");
  const [, mimeType, base64Data] = match;
  const ext = mimeType.split("/")[1] || "jpg";
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mimeType }), mimeType, ext };
}

export async function uploadImageDirect(dataUrl: string, requestUrlEndpoint: string, bucket: string): Promise<string> {
  const { blob, mimeType, ext } = dataUrlToBlob(dataUrl);
  if (blob.size > 3 * 1024 * 1024) throw new Error("Ảnh tối đa 3MB");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(requestUrlEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ext }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Không xin được link tải ảnh (quá 15 giây) — thử lại");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Không xin được link tải ảnh");
  const { token, path, publicUrl } = data as { token: string; path: string; publicUrl: string };

  const { error: uploadError } = await supabaseBrowser.storage.from(bucket).uploadToSignedUrl(path, token, blob, { contentType: mimeType });
  if (uploadError) throw new Error(uploadError.message || "Tải ảnh lên Supabase thất bại");

  return publicUrl;
}
