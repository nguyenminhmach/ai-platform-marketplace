import { getSupabaseAdmin } from "@/lib/supabase";
import {
  generateStoryChapters,
  generateStoryScriptsByChapter,
  planStoryVideoScenes,
  planStoryVideoScenesMulti,
  validateStoryChapters,
  validateScriptSceneResult,
  validateScriptSceneResultMulti,
  MAX_JOB_SCENES,
  type ScriptSceneResult,
  type ScriptSceneResultMulti,
  type VideoModelEntry,
} from "@/lib/story-video";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";

// Video DÀI nhiều chương (vd đám cưới vài phút) — kịch bản 2 cấp CHƯƠNG -> CẢNH, xem
// generateStoryChapters/generateStoryScriptsByChapter trong lib/story-video.ts. 2 chế độ:
//  - mode "outline": chia ý tưởng thành các chương (chỉ tiêu đề + tóm tắt, 1 lượt gọi Agent, rẻ). Khách
//    được xem/sửa chương trước khi tạo cảnh.
//  - mode "scripts": tạo cảnh cho từng chương (song song). "regenerateIndexes" (tuỳ chọn) chỉ tạo lại đúng
//    các chương đó — chương còn lại dùng lại "actions"/"actionsMulti" client gửi kèm (đã validate lại, không
//    gọi Agent, không tốn thêm). Xong nối theo thứ tự chương rồi chạy planStoryVideoScenes()/Multi() (code
//    thuần) để nhóm cảnh + tính giá thật — cùng hàm submit sẽ chạy lại phía server, nên giá hiện ở đây luôn
//    khớp giá thật.
export const maxDuration = 60;

type ChapterInput = { title?: unknown; summary?: unknown; actions?: unknown; actionsMulti?: unknown };

export async function POST(req: Request) {
  const {
    mode,
    storyDescription,
    miniAppId,
    videoModelKey,
    modelChatKey,
    characterLabels,
    characterLabel,
    chapters: rawChapters,
    regenerateIndexes,
  } = await req.json();

  if (typeof storyDescription !== "string" || !storyDescription.trim()) {
    return Response.json({ error: "Thiếu storyDescription" }, { status: 400 });
  }
  if (typeof miniAppId !== "string" || !miniAppId) {
    return Response.json({ error: "Thiếu miniAppId" }, { status: 400 });
  }
  if (mode !== "outline" && mode !== "scripts") {
    return Response.json({ error: "mode phải là outline hoặc scripts" }, { status: 400 });
  }
  const isMulti = Array.isArray(characterLabels) && characterLabels.length >= 2;
  if (isMulti && !characterLabels.every((l: unknown) => typeof l === "string" && l.trim())) {
    return Response.json({ error: "characterLabels không hợp lệ" }, { status: 400 });
  }
  const story = storyDescription.trim();
  const chatKey = typeof modelChatKey === "string" ? modelChatKey : undefined;

  try {
    if (mode === "outline") {
      const chapters = await generateStoryChapters(story, chatKey, miniAppId, isMulti ? characterLabels : undefined);
      return Response.json({ chapters });
    }

    // mode "scripts"
    const chapters = validateStoryChapters(
      Array.isArray(rawChapters) ? rawChapters.map((c: ChapterInput) => ({ title: c?.title, summary: c?.summary })) : rawChapters
    );
    const regenerate = new Set<number>(
      Array.isArray(regenerateIndexes)
        ? regenerateIndexes.filter((i: unknown): i is number => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < chapters.length)
        : []
    );
    // Chương nào chưa có sẵn actions (hoặc bị yêu cầu tạo lại) mới gọi Agent.
    const provided = (rawChapters as ChapterInput[]).map((c) => (isMulti ? c?.actionsMulti : c?.actions));
    const toGenerate = chapters.map((_, i) => i).filter((i) => regenerate.has(i) || !Array.isArray(provided[i]) || provided[i] === undefined);

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("mini_apps").select("model_config").eq("id", miniAppId).single();
    if (error || !data) return Response.json({ error: "Không tìm thấy Mini App" }, { status: 404 });
    const config = data.model_config as { video_models?: VideoModelEntry[] } | null;
    const videoModels = (config?.video_models ?? []).filter((m) => m.enabled);
    const videoEntry = videoModels.find((m) => m.key === videoModelKey) ?? videoModels[0];
    if (!videoEntry) return Response.json({ error: "Không có model video nào đang bật" }, { status: 400 });

    const generated = toGenerate.length
      ? await generateStoryScriptsByChapter({
          storyDescription: story,
          chapters,
          indexes: toGenerate,
          modelChatKey: chatKey,
          miniAppId,
          characterLabel: typeof characterLabel === "string" ? characterLabel : undefined,
          characterLabels: isMulti ? characterLabels : undefined,
        })
      : [];
    const generatedByIndex = new Map(generated.map((g) => [g.index, g]));

    // Ghép từng chương theo thứ tự: chương vừa tạo lấy kết quả Agent, chương giữ lại validate lại từ client
    // (không tin field nào ngoài các field mô tả) và gắn lại "chapter" đúng chỉ số hiện tại.
    const perChapter: { title: string; summary: string; actions?: unknown[]; error?: string }[] = [];
    const flat: unknown[] = [];
    for (let i = 0; i < chapters.length; i++) {
      const base = { title: chapters[i].title, summary: chapters[i].summary };
      const g = generatedByIndex.get(i);
      if (g) {
        if (g.error) {
          perChapter.push({ ...base, error: g.error });
          continue;
        }
        const acts = (isMulti ? g.actionsMulti : g.actions) as unknown[];
        perChapter.push({ ...base, actions: acts });
        flat.push(...acts);
        continue;
      }
      try {
        const kept = isMulti
          ? validateScriptSceneResultMulti(provided[i], story, characterLabels)
          : validateScriptSceneResult(provided[i], story);
        const tagged = kept.map((a) => ({ ...a, chapter: i }));
        perChapter.push({ ...base, actions: tagged });
        flat.push(...tagged);
      } catch (err) {
        perChapter.push({ ...base, error: err instanceof Error ? err.message : "Kịch bản chương không hợp lệ" });
      }
    }

    const failedChapters = perChapter.filter((c) => c.error).length;
    if (failedChapters > 0) {
      // Còn chương lỗi -> chưa nối/tính giá được cả video. Trả về từng chương (kèm error riêng) để khách bấm
      // tạo lại đúng chương lỗi, các chương đã xong được giữ nguyên (client gửi lại actions lần sau).
      return Response.json({ chapters: perChapter, complete: false });
    }
    if (flat.length > MAX_JOB_SCENES) {
      return Response.json(
        {
          error: `Tổng ${flat.length} cảnh vượt giới hạn ${MAX_JOB_SCENES} cảnh/video — hãy rút gọn ý tưởng hoặc bớt chương`,
          chapters: perChapter,
          complete: false,
        },
        { status: 400 }
      );
    }

    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    const plan = isMulti
      ? planStoryVideoScenesMulti(flat as ScriptSceneResultMulti[], videoEntry)
      : planStoryVideoScenes(flat as ScriptSceneResult[], videoEntry);
    const videoCreditCost = computeDynamicCreditCost(plan.totalVideoProviderCostVnd, marginPercent, vndPerCredit);
    return Response.json({
      complete: true,
      chapters: perChapter,
      actions: flat,
      scenes: plan.scenes,
      totalNaturalSeconds: plan.totalNaturalSeconds,
      totalVideoProviderCostVnd: plan.totalVideoProviderCostVnd,
      videoCreditCost,
      videoModel: { key: videoEntry.key, label: videoEntry.label, duration_price_vnd: videoEntry.duration_price_vnd },
    });
  } catch (err) {
    console.error("[plan-chapters] Lỗi:", err);
    return Response.json({ error: err instanceof Error ? err.message : "Có lỗi xảy ra" }, { status: 500 });
  }
}
