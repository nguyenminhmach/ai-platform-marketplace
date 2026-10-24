import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SỬA (phản hồi thật user: "tải ảnh đã tạo chậm" — lưới dự án) — đo thật: ảnh job Fal.ai trả về
  // thường 1376x768 PNG, 1.7-1.8MB/ảnh, hiển thị trong ô lưới nhỏ (aspect-square) -- tải thẳng <img> src
  // gốc là tải NGUYÊN FILE GỐC cho 1 ô vài trăm px, tốn băng thông/thời gian thật. Cho phép next/image
  // tối ưu (resize + nén WebP) ảnh từ 2 nguồn domain dùng trong app: CDN Fal.ai (fal.media, nhiều subdomain
  // như v3b.fal.media) và Supabase Storage (<project-ref>.supabase.co, domain đổi theo project nên dùng
  // wildcard thay vì ghi cứng).
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.fal.media" },
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
  // ffmpeg-static không nằm trong danh sách package Next.js tự externalize sẵn (khác với "sharp" —
  // đã có sẵn trong danh sách đó nên chưa từng gặp lỗi này). Thiếu dòng này, Turbopack tự bundle
  // ffmpeg-static vào chunk JS như package JS thường, làm outputFileTracingIncludes bên dưới không
  // ăn (binary thực tế không được copy theo, dù trace khai đúng đường dẫn) — đây mới là nguyên nhân
  // thật của lỗi "spawn .../ffmpeg-static/ffmpeg ENOENT" trên Vercel dù binary luôn có ở máy build.
  serverExternalPackages: ["ffmpeg-static"],
  // Route ghép nhạc nền dùng ffmpeg-static (binary không phải JS, Next.js tracing có thể bỏ sót) —
  // khai báo rõ để chắc chắn binary được đóng gói vào serverless function khi deploy Vercel.
  outputFileTracingIncludes: {
    "/api/video/add-music": ["./node_modules/ffmpeg-static/**/*"],
    "/api/dialogue-video/webhook": ["./node_modules/ffmpeg-static/**/*"],
    "/api/story-video/webhook": ["./node_modules/ffmpeg-static/**/*"],
    "/api/story-video/status": ["./node_modules/ffmpeg-static/**/*"],
  },
};

export default nextConfig;
