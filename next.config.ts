import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
