// GET /api/video/sweep — Vercel Cron gọi 1 lần/ngày, dọn các video_jobs bị bỏ quên hẳn
// (user tắt tab, webhook lẫn poll đều không tới) — hoàn credit nếu quá 2 giờ vẫn chưa xong.

import { sweepAbandonedJobs } from "@/lib/video-jobs";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const swept = await sweepAbandonedJobs();
  return Response.json({ success: true, checked: swept });
}
