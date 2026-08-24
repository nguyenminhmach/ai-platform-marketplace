import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
