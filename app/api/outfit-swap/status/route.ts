import { resolveOutfitSwapJob } from "@/lib/outfit-swap-jobs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return Response.json({ error: "Thiếu jobId" }, { status: 400 });
  }

  const result = await resolveOutfitSwapJob(Number(jobId));
  if (result.status === "not_found") {
    return Response.json({ error: "Không tìm thấy job" }, { status: 404 });
  }

  return Response.json(result);
}
