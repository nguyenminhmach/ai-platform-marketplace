"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth-context";
import { MannequinPreviewCard } from "@/components/MannequinPreviewCard";

// Trang riêng cho "Video từ ý tưởng" (story-video) — tách ra khỏi app/mini-app/[id]/page.tsx (file
// dùng chung cho mọi mini-app, đã quá lớn) để dễ chỉnh sửa/đọc hơn. Hành vi giữ NGUYÊN y hệt bản gốc
// (cùng API /api/story-video/*, cùng state, cùng JSX) — chỉ bỏ phần dùng chung cho 11 mini-app khác
// (video-gen, outfit-swap, dialogue-video, v.v.) không liên quan tới story-video.
const MINI_APP_ID = "video-tu-y-tuong";

export default function VideoTuYTuongPage() {
  const app = MINI_APPS.find((item) => item.id === MINI_APP_ID);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  // "Lịch sử" riêng của đúng app đang xem — lọc theo miniAppId, không lẫn kết quả app khác (khác với
  // trang /wallet vốn gộp chung lịch sử mọi app cho khách xem tổng quan toàn tài khoản).
  type HistoryItem = { id: number; outputType: string; outputUrl: string; createdAt: string };
  const [appHistory, setAppHistory] = useState<HistoryItem[]>([]);
  function loadAppHistory() {
    if (!user || !app) return;
    fetch(`/api/history?userId=${user.id}&miniAppId=${app.id}`)
      .then((res) => res.json())
      .then((data) => setAppHistory(data.items ?? []))
      .catch(() => {});
  }
  useEffect(loadAppHistory, [user, app?.id]);
  async function handleDeleteAppHistory(id: number) {
    if (!user) return;
    setAppHistory((items) => items.filter((item) => item.id !== id));
    await fetch(`/api/history/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    }).catch(() => {});
  }

  // Chia sẻ kết quả + đánh giá nhanh (👍/👎) — chỉ là tương tác phía client, không lưu server.
  const [shareCopied, setShareCopied] = useState(false);

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  // "Video từ ý tưởng truyện": 1-3 ảnh nhân vật + mô tả truyện (dùng chung state `input`) + số phân
  // cảnh (2-8) + chọn model ảnh/video từ catalog nhiều nhà cung cấp — AI tự chia cảnh, không cho
  // khách tự viết từng cảnh.
  const STORY_MIN_SCENES = 1;
  const STORY_MAX_SCENES = 8;
  // Đúng cận trên MAX_STORY_CHARACTERS trong lib/story-video.ts (client component không import được
  // file server đó — sharp/child_process — nên khai lại hằng số ở đây).
  const STORY_MAX_CHARACTERS = 4;
  const [numScenes, setNumScenes] = useState(3);
  // "3 cảnh" là giá trị khởi tạo kỹ thuật (để price effect/submit luôn có số hợp lệ), KHÔNG phải lựa
  // chọn thật — chỉ hiện nút nào đó "sáng" sau khi AI đã gợi ý xong hoặc khách tự bấm chọn, tránh
  // khách tưởng nhầm "3 cảnh" là quyết định có sẵn.
  const [sceneCountChosen, setSceneCountChosen] = useState(false);
  // Bước "Tạo kịch bản" — thay thế ô chọn "số cảnh" + gợi ý AI cũ cho ĐÚNG luồng mặc định (1 nhân vật,
  // AI tự vẽ ảnh, không own-images). Agent tự liệt kê hành động + giây riêng từng cái, code nhóm thành
  // cảnh (mặc định 1 hành động = 1 cảnh) — xem lib/story-video.ts: generateStoryScript/planStoryVideoScenes.
  // Field chung cho cả 2 luồng (1 nhân vật / nhiều nhân vật) — "camera_view" chỉ có ở luồng 1 nhân vật,
  // "characters" chỉ có ở luồng nhiều nhân vật (ai xuất hiện trong cảnh); panel xem trước chỉ đọc field
  // chung (description/duration_key) nên dùng chung 1 type, không cần tách 2 state riêng.
  type StoryScriptAction = {
    description: string;
    location: string;
    end_pose: string;
    duration_seconds: number;
    camera_view?: string;
    // Agent (bước "Tạo kịch bản") đã tính sẵn 3 field này y hệt bước chia cảnh chính (xem
    // SceneSplitResult trong lib/story-video.ts) — trước đây type ở đây chưa khai báo nên dữ liệu bị bỏ
    // phí, giờ dùng để hiện preview 3D NGAY sau khi tạo kịch bản, không cần chờ submit job.
    shot_size?: string;
    camera_angle?: string;
    camera_movement?: string;
    light_direction?: string;
    camera_body?: string;
    lens?: string;
    aperture?: string;
    outfit_override?: string;
    face_view?: string;
    dialogue?: string | { speaker: number; line: string } | null;
    characters?: number[];
  };
  type StoryScriptScene = StoryScriptAction & { duration_key: string | null; provider_cost_vnd: number };
  // Video NHIỀU CHƯƠNG — mỗi chương là 1 lượt chạy đầy đủ của form (job riêng) ra 1 video ngắn; cuối cùng
  // "Kết thúc" ghép video các chương (xem lib/story-video-projects.ts). Chỉ giữ 1 form duy nhất: xong chương N
  // thì "chốt" gọn (mã job + video + ý tưởng) rồi reset form sang chương N+1 — luồng vốn tuần tự.
  type StoryProjectChapter = { chapterIndex: number; jobId: number; outputUrl: string; title: string };
  const STORY_MAX_CHAPTERS = 10; // đúng MAX_PROJECT_CHAPTERS ở lib/story-video-projects.ts
  const [storyMultiChapter, setStoryMultiChapter] = useState(false);
  const [storyProjectId, setStoryProjectId] = useState<number | null>(null);
  const [storyProjectChapters, setStoryProjectChapters] = useState<StoryProjectChapter[]>([]);
  const [storyActiveChapter, setStoryActiveChapter] = useState(0);
  const [storyLockedAspectRatio, setStoryLockedAspectRatio] = useState<string | null>(null);
  const [storyProjectFinalizing, setStoryProjectFinalizing] = useState(false);
  const [storyProjectFinalUrl, setStoryProjectFinalUrl] = useState<string | null>(null);
  // Kiểu chuyển cảnh (cắt cứng/hoà mờ) khách chọn riêng cho TỪNG điểm nối giữa 2 chương liên tiếp —
  // storyChapterTransitions[i] ứng với điểm nối Chương (i+1) → Chương (i+2). Không chọn gì thì mặc định
  // "cut" (giữ đúng hành vi cũ, xem finalize route). Reset khi bắt đầu dự án mới (handleNewProject).
  const [storyChapterTransitions, setStoryChapterTransitions] = useState<("cut" | "crossfade")[]>([]);
  const [storyProjectError, setStoryProjectError] = useState<string | null>(null);
  const [storyViewChapter, setStoryViewChapter] = useState<number | null>(null);
  const storyFormTopRef = useRef<HTMLDivElement | null>(null);
  const storyProjectFinalRef = useRef<HTMLDivElement | null>(null);
  const [storyScriptActions, setStoryScriptActions] = useState<StoryScriptAction[] | null>(null);
  const [storyScriptScenes, setStoryScriptScenes] = useState<StoryScriptScene[] | null>(null);
  const [storyScriptTotalSeconds, setStoryScriptTotalSeconds] = useState<number | null>(null);
  const [storyScriptVideoCreditCost, setStoryScriptVideoCreditCost] = useState<number | null>(null);
  const [storyScriptLoading, setStoryScriptLoading] = useState(false);
  const [storyScriptError, setStoryScriptError] = useState<string | null>(null);
  // Thanh trượt điều chỉnh tốc độ từng hành động — admin bật qua /admin (model_config.enable_speed_slider,
  // mặc định TẮT), đọc cờ này 1 lần lúc tải model. Khi bật: sau "Tạo kịch bản", hiện danh sách HÀNH ĐỘNG
  // GỐC (storyScriptActions, chưa gộp) kèm thanh trượt riêng từng cái thay vì hiện thẳng storyScriptScenes
  // (đã gộp) — khách chỉnh xong bấm "Hoàn thành" mới gọi lại plan-script để gộp/chốt giá lại.
  const [storyEnableSpeedSlider, setStoryEnableSpeedSlider] = useState(false);
  const [storySpeedDrafts, setStorySpeedDrafts] = useState<Record<number, number>>({});
  const [storySpeedFinalized, setStorySpeedFinalized] = useState(false);
  const [storySpeedLoading, setStorySpeedLoading] = useState(false);
  const [storyCharacterImages, setStoryCharacterImages] = useState<string[]>([]);
  // Nhân vật #2, #3, #4 (nếu có) — nhân vật #1 vẫn dùng nguyên storyCharacterImages/
  // storySelectedSavedCharacterId ở trên, không đổi gì, để giữ đúng luồng 1-nhân-vật hiện có khi khách
  // không thêm ai — chỉ khi mảng này có phần tử mới coi là job nhiều nhân vật.
  const [storyExtraCharacters, setStoryExtraCharacters] = useState<
    { images: string[]; reuseId: number | null; label: string; itemImages: string[]; inputMode: "photo" | "text"; appearanceDescription: string }[]
  >([]);
  // Tên nhân vật #1 — chỉ cần điền khi có thêm nhân vật khác (job nhiều người), để Agent chia cảnh
  // khớp đúng tên trong Ý tưởng truyện (vd truyện viết "Lan ôm Mai" thì cần đúng tên "Lan" ở đây,
  // không phải để mặc định "Nhân vật 1" — Agent sẽ không biết "Lan" là ai nếu tên không khớp).
  const [storyPrimaryCharacterLabel, setStoryPrimaryCharacterLabel] = useState("");
  // Chế độ "Mô tả bằng chữ" — khách không có ảnh thật, để AI tự vẽ hẳn nhân vật từ mô tả này thay vì
  // tải ảnh. CHỈ áp dụng khi đúng 1 nhân vật (storyExtraCharacters rỗng) — xem
  // buildCharacterSheetTextPrompt() ở lib/story-video.ts.
  const [storyCharacterInputMode, setStoryCharacterInputMode] = useState<"photo" | "text">("photo");
  const [storyCharacterAppearanceDescription, setStoryCharacterAppearanceDescription] = useState("");
  // Ảnh THẬT của 1 địa điểm (sân vườn, nhà, cửa hàng...) — tuỳ chọn, dùng chung cho cả job, để ảnh
  // phân cảnh AI vẽ diễn ra đúng tại khung cảnh thật đó thay vì AI tự bịa bối cảnh.
  const [storyLocationReference, setStoryLocationReference] = useState<string | null>(null);
  // Vị trí đứng chính xác trong ảnh Bối cảnh (mask trắng/đen do khách khoanh vùng) — tuỳ chọn, chỉ có
  // tác dụng khi model ảnh đang chọn là GPT Image 2 Edit (model duy nhất hỗ trợ mask_url thật sự, xem
  // buildImageRequestBody trong lib/story-video.ts). storyLocationMaskRect là vùng khách đang
  // chọn/đã chọn (toạ độ chuẩn hoá 0..1 theo ảnh gốc); storyLocationReferenceMaskUrl là ảnh mask
  // đen/trắng đã sinh ra từ vùng đó (data URL trước khi upload, URL thật sau khi khôi phục job cũ).
  const [storyLocationReferenceMaskUrl, setStoryLocationReferenceMaskUrl] = useState<string | null>(null);
  const [storyLocationMaskRect, setStoryLocationMaskRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [storyLocationMaskEditorOpen, setStoryLocationMaskEditorOpen] = useState(false);
  const [storyLocationImageNaturalSize, setStoryLocationImageNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const storyLocationMaskDragStartRef = useRef<{ x: number; y: number } | null>(null);
  // NHIỀU nhân vật, NHIỀU vị trí trong CÙNG 1 ảnh Bối cảnh — mỗi phần tử gán 1 vùng cho đúng 1 nhân
  // vật (characterPosition khớp story_video_job_characters.position). storyLocationReferenceMaskUrl
  // vẫn là ẢNH MASK DUY NHẤT (gộp mọi vùng trắng lại) — mảng này chỉ để biết vùng nào của ai, dùng
  // sinh mask tổng hợp + gửi lên server viết chỉ dẫn văn bản (xem lib/story-video.ts:
  // describeMaskZonePosition). Chỉ có ý nghĩa khi có từ 2 nhân vật trở lên (storyExtraCharacters.length>0).
  const [storyLocationMaskAssignments, setStoryLocationMaskAssignments] = useState<
    { characterPosition: number; rect: { x: number; y: number; w: number; h: number } }[]
  >([]);
  const [storyLocationMaskActiveCharacter, setStoryLocationMaskActiveCharacter] = useState<number>(0);
  const STORY_MASK_ZONE_COLORS = ["#10b981", "#0ea5e9", "#f59e0b", "#d946ef"]; // emerald/sky/amber/fuchsia, theo đúng thứ tự position 0..3
  // Ngưỡng tối thiểu (theo % kích thước ảnh) để 1 vùng khoanh được coi là "đã chọn" — chặn trường hợp
  // khách bấm nhầm 1 điểm (gần như 0x0) rồi tưởng đã chọn xong. SỬA (phản hồi thật của khách): ngưỡng
  // cũ 0.02 (2%) không có dòng giải thích nào khi bị chặn — khách kéo vùng hơi nhỏ (vd nhân vật đứng xa,
  // vùng nhỏ hợp lý) thấy nút "Lưu vị trí" mờ đi mà không hiểu vì sao. Hạ ngưỡng xuống 0.008 (0.8%) cho
  // đỡ ngặt, ĐỒNG THỜI hiện rõ dòng cảnh báo ngay dưới nút khi vùng chưa đủ lớn (xem bên dưới).
  const STORY_MASK_MIN_FRACTION = 0.008;
  // Ảnh THẬT của tối đa MAX_ITEM_REFERENCES vật phẩm riêng của nhân vật #1 (đôi giày, túi xách, đồng
  // hồ...) — tuỳ chọn, mỗi nhân vật (kể cả nhân vật #2+ trong storyExtraCharacters) có ô riêng, không
  // dùng chung cho cả job như địa điểm — xem chú thích itemReferenceUrls trong lib/story-video.ts.
  const STORY_MAX_ITEM_REFERENCES = 3;
  const [storyPrimaryItemReferences, setStoryPrimaryItemReferences] = useState<string[]>([]);
  // Khách chủ động chọn bỏ qua bước tạo Character (AI vẽ sheet nhiều góc) — dùng thẳng ảnh đầu tiên đã
  // tải làm tham chiếu duy nhất, tiết kiệm ~18 credit nhưng các cảnh cần góc khác (quay lưng, nghiêng)
  // dễ kém đồng nhất hơn vì chỉ có đúng 1 góc ảnh để AI tham chiếu, không phải sheet đủ 6 góc.
  const [storySkipCharacterCreation, setStorySkipCharacterCreation] = useState(false);
  type StoryModel = {
    key: string;
    provider: string;
    label: string;
    provider_cost_vnd: number;
    multi_image?: boolean;
    aspect_ratios?: string[];
    resolution_price_vnd?: Record<string, number>;
    duration_price_vnd?: Record<string, number>;
    // Fal model id thật (vd "fal-ai/gpt-image-2/edit") — dùng để lọc đúng model hỗ trợ mask_url khi
    // khách đã khoanh vùng đặt nhân vật (xem storyLocationReferenceMaskUrl).
    model?: string;
  };
  const [storyImageModels, setStoryImageModels] = useState<StoryModel[]>([]);
  const [storyVideoModels, setStoryVideoModels] = useState<StoryModel[]>([]);
  const [storyImageModelKey, setStoryImageModelKey] = useState<string | null>(null);
  const [storyVideoModelKey, setStoryVideoModelKey] = useState<string | null>(null);
  // Khách đã có sẵn ảnh cho từng phân cảnh (thay vì để AI tạo) — tải thẳng vào đây, bỏ qua hoàn toàn
  // bước Character + AI tạo ảnh phân cảnh. Agent chỉ đọc ảnh + gợi ý (tuỳ chọn) + Ý tưởng truyện để tự
  // viết prompt chuyển động khi tạo video, không tốn credit ảnh. Tải kiểu động (bấm "+ Tải ảnh" thêm
  // dần từng ảnh, giống hệt "Ảnh nhân vật") — số phân cảnh = số ảnh đã tải, tối đa STORY_MAX_SCENES.
  const [storyUseOwnSceneImages, setStoryUseOwnSceneImages] = useState(false);
  const [storySceneImages, setStorySceneImages] = useState<string[]>([]);
  const [storySceneHints, setStorySceneHints] = useState<string[]>([]);
  // "Cấu hình media" — tỉ lệ khung hình (luôn có), độ phân giải/thời lượng chỉ hiện khi model đang
  // chọn có bảng giá riêng cho trục đó (không hiện dropdown giả cho model không hỗ trợ).
  const [storyAspectRatio, setStoryAspectRatio] = useState("9:16");
  const [storyResolutionKey, setStoryResolutionKey] = useState<string | null>(null);
  const [storyDurationKey, setStoryDurationKey] = useState<string | null>(null);
  // Chuyển động liên tục giữa các cảnh (Kling O1 FLFV) — chỉ có ý nghĩa khi model video đang chọn hỗ
  // trợ ảnh đầu/cuối (key "kling-o1-flfv"), ẩn checkbox khi chọn model khác. Bật thì mỗi cảnh có thêm
  // 1 ảnh cuối, nối chuỗi ảnh cuối cảnh trước = ảnh đầu cảnh sau — "Tạo lại" từng cảnh dùng route riêng
  // /api/story-video/regenerate-continuous-scene (theo "position", không phải sceneId thẳng).
  const [storyContinuousMotion, setStoryContinuousMotion] = useState(false);
  // Frame-chaining ("dẫn trạng thái qua khung hình thật") — cơ chế nối cảnh KHÁC hẳn continuous motion:
  // dùng khung hình THẬT trích từ video vừa render (không phải ảnh AI tự đoán trước), nên chạy được với
  // MỌI model video thường (không cần loại FLFV riêng). Loại trừ lẫn nhau với continuous motion — v1
  // chỉ hỗ trợ luồng 1 nhân vật, chạy TUẦN TỰ từng cảnh nên chậm hơn nhiều so với luồng song song mặc định.
  const [storyFrameChainMode, setStoryFrameChainMode] = useState(false);
  // Bước "Tạo kịch bản" (xem lib/story-video.ts: planStoryVideoScenes/planStoryVideoScenesMulti) — hỗ
  // trợ CẢ luồng 1 nhân vật lẫn nhiều nhân vật (generateStoryScript/generateStoryScriptMulti), dùng
  // được cả khi bật frame-chain (chỉ luồng 1 nhân vật có checkbox này). KHÔNG hỗ trợ own-images (không
  // cần), chuyển động liên tục (cần thêm field end_description riêng mà bước kịch bản chưa tạo ra).
  const storyUsesScriptFlow = !storyUseOwnSceneImages && !storyContinuousMotion;
  // "Model chat" — LLM thực thi bước chia cảnh (tách biệt với "Agent" = persona/hướng dẫn) — đúng 2
  // lựa chọn admin đang dùng cho app tự tạo dạng text (xem MODEL_OPTIONS trong app/admin/page.tsx).
  const STORY_MODEL_CHAT_OPTIONS = [
    { value: "google/gemini-3-flash-preview", label: "Gemini Flash" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet" },
    { value: "openai/gpt-5.1", label: "GPT-5.1" },
  ];
  const [storyModelChatKey, setStoryModelChatKey] = useState(STORY_MODEL_CHAT_OPTIONS[0].value);
  // Thể loại — chỉ là 1 khoá tra bảng (xem GENRE_STYLE_GUIDES trong lib/story-video.ts), nối thêm 1
  // đoạn hướng dẫn phong cách cố định vào system prompt Agent chia cảnh, không phải AI tự "hiểu" thể
  // loại. "default" = không chọn gì, không nối thêm.
  // emoji/gradient chỉ dùng làm ảnh thẻ MẶC ĐỊNH khi admin chưa tải ảnh thật cho thể loại đó (xem
  // storyGenreThumbnails) — /admin có ô tải ảnh thẻ riêng cho từng thể loại.
  const STORY_GENRE_OPTIONS = [
    { value: "default", label: "Mặc định", emoji: "🎬", gradient: "from-zinc-500 to-zinc-700" },
    { value: "romance", label: "Tình cảm", emoji: "❤️", gradient: "from-rose-500 to-pink-700" },
    { value: "comedy", label: "Hài hước", emoji: "😂", gradient: "from-amber-400 to-orange-600" },
    { value: "horror", label: "Kinh dị", emoji: "👻", gradient: "from-purple-900 to-black" },
    { value: "scifi", label: "Khoa học viễn tưởng", emoji: "🚀", gradient: "from-cyan-500 to-blue-800" },
    { value: "slice_of_life", label: "Đời thường", emoji: "🍃", gradient: "from-emerald-500 to-teal-700" },
    { value: "mystery", label: "Bí ẩn", emoji: "🕵️", gradient: "from-indigo-700 to-slate-900" },
  ];
  const [storyGenreKey, setStoryGenreKey] = useState(STORY_GENRE_OPTIONS[0].value);
  const [storyGenreThumbnails, setStoryGenreThumbnails] = useState<Record<string, string>>({});
  const [storyImageCost, setStoryImageCost] = useState<number | null>(null);
  const [storyVideoCost, setStoryVideoCost] = useState<number | null>(null);
  const [storyCharacterCost, setStoryCharacterCost] = useState<number | null>(null);
  // Bước "Tạo Character" — ảnh sheet nhiều góc dùng làm tham chiếu chung cho mọi phân cảnh (thay vì
  // ảnh gốc lộn xộn). Job dừng ở "character_ready" chờ khách duyệt trước khi tốn credit chia cảnh.
  const [storyCharacterSheetUrl, setStoryCharacterSheetUrl] = useState<string | null>(null);
  const [storyCharacterSource, setStoryCharacterSource] = useState<string | null>(null);
  const [storyRegeneratingCharacter, setStoryRegeneratingCharacter] = useState(false);
  // Job nhiều nhân vật — mảng N Character (song song với storyCharacterSheetUrl vốn chỉ dùng cho job 1
  // nhân vật). null/rỗng = job này không phải nhiều nhân vật.
  const [storyJobCharacters, setStoryJobCharacters] = useState<
    { position: number; label: string | null; sheetUrl: string | null; ready: boolean }[] | null
  >(null);
  const [storyRegeneratingJobCharacterPosition, setStoryRegeneratingJobCharacterPosition] = useState<number | null>(null);
  const [storyContinuingScenes, setStoryContinuingScenes] = useState(false);
  // Preview bố cục MIỄN PHÍ (luồng 1 nhân vật) — job dừng ở status "scenes_ready" sau khi chia cảnh
  // xong, TRƯỚC khi tốn credit tạo ảnh thật. scenePreviews có mô tả + lựa chọn camera Agent vừa chọn
  // cho từng cảnh (chưa có ảnh); characterAngleUrls dùng để ghép ảnh phác thảo (không gọi AI, không
  // tốn credit) — xem renderScenePreviewComposite().
  const [storyScenePreviews, setStoryScenePreviews] = useState<
    | {
        id: number;
        position: number;
        sceneDescription: string | null;
        cameraView: string | null;
        shotSize: string | null;
        cameraAngle: string | null;
        cameraMovement: string | null;
        lightDirection: string | null;
        cameraBody: string | null;
        lens: string | null;
        aperture: string | null;
        location: string | null;
      }[]
    | null
  >(null);
  // Modal chọn ánh sáng/máy quay kiểu Higgsfield Cinema Studio (bấm 1 chip gọn -> mở modal giữa màn
  // hình chứa lưới preset) — 1 state DÙNG CHUNG cho mọi thẻ cảnh (cả 2 khối script-stage/scenes_ready),
  // thay vì mở modal riêng từng thẻ, để tránh nhiều modal chồng nhau khi có nhiều cảnh.
  const [activePresetModal, setActivePresetModal] = useState<{
    stage: "script" | "preview";
    key: number; // script: index trong storyScriptScenes; preview: scene.id
    type: "light" | "gear";
  } | null>(null);
  const [storyCharacterAngleUrlsForPreview, setStoryCharacterAngleUrlsForPreview] = useState<Record<string, string> | null>(null);
  const [storyContinuingImages, setStoryContinuingImages] = useState(false);
  const [storySavingCharacter, setStorySavingCharacter] = useState(false);
  const [storySavedCharacterMsg, setStorySavedCharacterMsg] = useState<string | null>(null);
  // Thư viện Character đã lưu — chọn 1 cái thay vì tải ảnh mới, bỏ qua hẳn bước tạo Character (chắc
  // chắn 100% vì chính hệ thống đã tạo ra trước đó, không cần AI phân loại lại).
  type SavedCharacter = { id: number; imageUrl: string; label: string | null };
  const [storySavedCharacters, setStorySavedCharacters] = useState<SavedCharacter[]>([]);
  const [storySelectedSavedCharacterId, setStorySelectedSavedCharacterId] = useState<number | null>(null);
  // "Kiểm tra ảnh" — cho khách tự xem trước AI sẽ nhận ảnh đầu tiên là sheet nhiều góc (bỏ qua tạo mới)
  // hay ảnh thường (sẽ tốn credit tạo Character), không cần chạy hết cả job mới biết.
  const [storyCheckingImage, setStoryCheckingImage] = useState(false);
  const [storyImageCheckResult, setStoryImageCheckResult] = useState<"sheet" | "photo" | null>(null);
  // "Tự động tạo video luôn" (gộp 1 lượt, giống Genful bấm mũi tên ▾) — mặc định TẮT: chỉ chạy chia
  // cảnh + tạo ảnh trước, dừng lại cho khách xem, ưng mới bấm "Tạo video" (đỡ tốn credit video oan
  // nếu ảnh ra không đúng ý).
  const [storyAutoVideo, setStoryAutoVideo] = useState(false);
  // "AI gợi ý số cảnh" — đếm hộ số hành động/thay đổi tư thế lớn trong truyện, tự chọn nút số cảnh
  // tương ứng (khách vẫn tự bấm đổi lại được). Tránh bắt khách tự đếm hành động trong truyện.
  const [suggestingScenes, setSuggestingScenes] = useState(false);
  const [sceneSuggestError, setSceneSuggestError] = useState<string | null>(null);
  // Chỉ gọi API, KHÔNG đụng state — trả thẳng số cảnh (hoặc null nếu lỗi) để nơi gọi dùng NGAY trong
  // cùng 1 lượt submit, tránh race condition: setNumScenes() là bất đồng bộ (chờ re-render mới thấy),
  // nếu handleRunStoryVideo chỉ đọc biến numScenes hiện tại thì có thể đọc trúng giá trị CŨ nếu khách
  // bấm "Tạo ảnh phân cảnh" ngay sau khi rời ô nhập, trước khi lượt gợi ý (chạy nền, mất vài giây) kịp
  // xong.
  async function fetchSuggestedSceneCount(): Promise<number | null> {
    try {
      const res = await fetch("/api/story-video/suggest-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyDescription: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSceneSuggestError(data.error ?? "Không gợi ý được");
        return null;
      }
      return data.numScenes as number;
    } catch {
      setSceneSuggestError("Không kết nối được tới server");
      return null;
    }
  }
  async function handleSuggestSceneCount() {
    if (!input.trim()) {
      setSceneSuggestError("Nhập truyện trước đã");
      return;
    }
    setSuggestingScenes(true);
    setSceneSuggestError(null);
    try {
      const n = await fetchSuggestedSceneCount();
      if (n !== null) {
        setNumScenes(n);
        setSceneCountChosen(true);
      }
    } finally {
      setSuggestingScenes(false);
    }
  }
  // Bước "Tạo kịch bản" — CHỈ dùng cho luồng mặc định (1 nhân vật, AI tự vẽ ảnh, không own-images).
  async function handleCreateScript() {
    if (!input.trim()) {
      setStoryScriptError("Nhập truyện trước đã");
      return;
    }
    if (!storyVideoModelKey) {
      setStoryScriptError("Chưa chọn model video");
      return;
    }
    setStoryScriptLoading(true);
    setStoryScriptError(null);
    try {
      // Nhiều nhân vật -> gửi kèm tên từng người (fallback "Nhân vật N" nếu bỏ trống, khớp đúng cách
      // backend tự đặt tên khi tạo Character) để route chuyển sang generateStoryScriptMulti.
      const hasMultipleCharacters = storyExtraCharacters.length > 0;
      const characterLabels = hasMultipleCharacters
        ? [storyPrimaryCharacterLabel.trim() || "Nhân vật 1", ...storyExtraCharacters.map((c, i) => c.label.trim() || `Nhân vật ${i + 2}`)]
        : undefined;
      const res = await fetch("/api/story-video/plan-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyDescription: input.trim(),
          miniAppId: app!.id,
          videoModelKey: storyVideoModelKey,
          modelChatKey: storyModelChatKey,
          characterLabels,
          characterLabel: hasMultipleCharacters ? undefined : storyPrimaryCharacterLabel.trim() || "Nhân vật 1",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryScriptError(data.error ?? "Không tạo được kịch bản");
        return;
      }
      setStoryScriptActions(data.actions);
      setStoryScriptScenes(data.scenes);
      setStoryScriptTotalSeconds(data.totalNaturalSeconds ?? null);
      setStoryScriptVideoCreditCost(data.videoCreditCost ?? null);
      setNumScenes(data.scenes.length);
      setSceneCountChosen(true);
      setStorySpeedDrafts({});
      // Còn thanh trượt chờ chỉnh (nếu tính năng đang bật) — chưa coi là xong ngay, khách phải bấm
      // "Hoàn thành" mới hiện đúng danh sách cảnh/giá cuối (xem khối render bên dưới).
      setStorySpeedFinalized(false);
    } catch {
      setStoryScriptError("Không kết nối được tới server");
    } finally {
      setStoryScriptLoading(false);
    }
  }
  // Bước "Hoàn thành chỉnh tốc độ" (chỉ chạy khi storyEnableSpeedSlider bật) — gửi lại ĐÚNG mảng hành
  // động Agent đã liệt kê (storyScriptActions), chỉ thay duration_seconds theo thanh trượt khách vừa
  // kéo, KHÔNG gọi lại Agent (route tự nhận diện qua field actions/actionsMulti, xem plan-script/route.ts).
  async function handleFinalizeSpeed() {
    if (!storyScriptActions) return;
    setStorySpeedLoading(true);
    setStoryScriptError(null);
    try {
      const hasMultipleCharacters = storyExtraCharacters.length > 0;
      const adjustedActions = storyScriptActions.map((a, i) => ({
        ...a,
        duration_seconds: storySpeedDrafts[i] ?? a.duration_seconds,
      }));
      const characterLabels = hasMultipleCharacters
        ? [storyPrimaryCharacterLabel.trim() || "Nhân vật 1", ...storyExtraCharacters.map((c, i) => c.label.trim() || `Nhân vật ${i + 2}`)]
        : undefined;
      const res = await fetch("/api/story-video/plan-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyDescription: input.trim(),
          miniAppId: app!.id,
          videoModelKey: storyVideoModelKey,
          modelChatKey: storyModelChatKey,
          characterLabels,
          actions: hasMultipleCharacters ? undefined : adjustedActions,
          actionsMulti: hasMultipleCharacters ? adjustedActions : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryScriptError(data.error ?? "Không tính lại được cảnh/giá");
        return;
      }
      setStoryScriptActions(data.actions);
      setStoryScriptScenes(data.scenes);
      setStoryScriptTotalSeconds(data.totalNaturalSeconds ?? null);
      setStoryScriptVideoCreditCost(data.videoCreditCost ?? null);
      setNumScenes(data.scenes.length);
      setStorySpeedFinalized(true);
    } catch {
      setStoryScriptError("Không kết nối được tới server");
    } finally {
      setStorySpeedLoading(false);
    }
  }
  // Kịch bản đã tạo gắn với ĐÚNG nội dung truyện + model video lúc bấm — đổi 1 trong 2 thứ đó sau khi
  // đã có kịch bản thì huỷ bản cũ, bắt bấm "Tạo kịch bản" lại, đảm bảo giá hiện luôn khớp thực tế dùng.
  useEffect(() => {
    if (storyScriptActions) {
      setStoryScriptActions(null);
      setStoryScriptScenes(null);
      setStoryScriptTotalSeconds(null);
      setStoryScriptVideoCreditCost(null);
      setStorySpeedDrafts({});
      setStorySpeedFinalized(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, storyVideoModelKey]);
  const [storyRunning, setStoryRunning] = useState(false);
  const [storyContinuing, setStoryContinuing] = useState(false);
  const [storyFinalizingPartial, setStoryFinalizingPartial] = useState(false);
  const [storyCancelling, setStoryCancelling] = useState(false);
  // 2 nút "Tạo ảnh phân cảnh" / "Viết mô tả chuyển động để tạo video" độc lập nhau, nhưng vẫn dùng
  // chung storyRunning để khoá nhau tránh chạy đè job (storyJobId/storyScenes dùng chung 1 chỗ) — cờ
  // này chỉ để nhãn nút hiện đúng "Đang xử lý..." trên nút khách vừa bấm, không hiện nhầm sang nút kia.
  const [storyActiveButton, setStoryActiveButton] = useState<"images" | "video" | null>(null);
  const [storyStatusText, setStoryStatusText] = useState<string | null>(null);
  const [storyStatus, setStoryStatus] = useState<string | null>(null);
  const [storyJobId, setStoryJobId] = useState<number | null>(null);
  const [storyScenes, setStoryScenes] = useState<
    | {
        id: number;
        position: number;
        imageUrl: string | null;
        endImageUrl?: string | null;
        videoUrl: string | null;
        hasDialogue?: boolean;
        motionPrompt?: string;
        identityRetryCount?: number;
      }[]
    | null
  >(null);
  const [storyRegeneratingSceneId, setStoryRegeneratingSceneId] = useState<number | null>(null);
  // Chế độ chuyển động liên tục — "Tạo lại" theo VỊ TRÍ hiển thị trên UI (không phải sceneId trực
  // tiếp), xem regenerateContinuousMotionSceneImage() trong lib/story-video.ts để hiểu vì sao.
  const [storyRegeneratingContinuousPosition, setStoryRegeneratingContinuousPosition] = useState<number | null>(null);
  // 2 nút "Kiểm tra" thủ công (thiếu chi thể / lệch ảnh đầu-cuối) — key theo sceneId, giá trị null =
  // đang chạy, undefined = chưa kiểm tra lần nào, {ok,issue} = kết quả lần gần nhất.
  const [storyAnatomyChecking, setStoryAnatomyChecking] = useState<Record<number, boolean>>({});
  const [storyAnatomyResults, setStoryAnatomyResults] = useState<Record<number, { ok: boolean; issue?: string }>>({});
  const [storyContinuityChecking, setStoryContinuityChecking] = useState<Record<number, boolean>>({});
  const [storyContinuityResults, setStoryContinuityResults] = useState<Record<number, { ok: boolean; issue?: string }>>({});
  const [storyRegeneratingVideoSceneId, setStoryRegeneratingVideoSceneId] = useState<number | null>(null);
  // Sửa câu mô tả chuyển động trước khi tạo lại video 1 cảnh — dùng khi lỗi lặp lại y hệt (vd bị model
  // chặn nội dung), gửi lại đúng câu cũ dễ ra lỗi y hệt, cần chỗ để khách đổi cách diễn đạt.
  const [storyEditingPromptSceneId, setStoryEditingPromptSceneId] = useState<number | null>(null);
  const [storyEditedPrompt, setStoryEditedPrompt] = useState("");
  const [storyResult, setStoryResult] = useState<string | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const storyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storyCharacterPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenesPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenePreviewSectionRef = useRef<HTMLDivElement | null>(null);
  const storyResultRef = useRef<HTMLDivElement | null>(null);
  // Khối "Ảnh nhân vật" (điểm neo cuộn về lại khi đóng xem trước) + khối "Xem trước ảnh" dùng chung
  // đúng vị trí/kiểu hiển thị với khối kết quả Character thật (storyCharacterPreviewRef phía dưới) —
  // bấm ảnh nhỏ nào cũng phóng to ở ĐÚNG chỗ đó (không phải phóng to tại chỗ trong khung nhỏ), nên bấm
  // mới cần cuộn hẳn xuống khu vực khác, bấm đóng lại cuộn ngược lên khung "Ảnh nhân vật".
  const storyCharacterCardRef = useRef<HTMLDivElement | null>(null);
  const [storyQuickZoomUrl, setStoryQuickZoomUrl] = useState<string | null>(null);
  const storyQuickZoomRef = useRef<HTMLDivElement | null>(null);

  // Tự động cuộn xuống khi Character/ảnh phân cảnh xong hoặc video hoàn tất — khách không phải cuộn
  // tay để xem kết quả.
  useEffect(() => {
    if (storyStatus === "character_ready") {
      storyCharacterPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "scenes_ready") {
      storyScenePreviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "images_ready") {
      storyScenesPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyStatus]);

  // Tỉ lệ chiều cao khung hình mà từng shot_size chiếm — dùng để ghép ảnh phác thảo bố cục MIỄN PHÍ
  // (không gọi AI, không tốn credit) từ ảnh Character đã có sẵn. Neo đáy khung hình, giống cách máy
  // ảnh thật lấy khung: cận cảnh chiếm gần hết khung, toàn cảnh chỉ chiếm 1 góc nhỏ.
  const SCENE_PREVIEW_SHOT_SCALE: Record<string, number> = {
    close_up: 0.95,
    medium_close_up: 0.75,
    medium_shot: 0.55,
    full_shot: 0.4,
    wide_shot: 0.22,
    detail_shot: 0.6,
  };
  const SCENE_PREVIEW_CAMERA_VIEW_LABEL: Record<string, string> = {
    front: "Chính diện",
    three_quarter_left: "Chếch trái",
    three_quarter_right: "Chếch phải",
    side: "Nghiêng ngang",
    back: "Sau lưng",
    face: "Cận mặt",
  };
  const SCENE_PREVIEW_SHOT_SIZE_LABEL: Record<string, string> = {
    close_up: "Cận cảnh",
    medium_close_up: "Cận vừa",
    medium_shot: "Trung cảnh",
    full_shot: "Toàn thân",
    wide_shot: "Toàn cảnh rộng",
    detail_shot: "Chi tiết (vật/tay/mắt...)",
  };
  const SCENE_PREVIEW_CAMERA_ANGLE_LABEL: Record<string, string> = {
    eye_level: "Ngang tầm mắt",
    low_angle: "Máy thấp hướng lên",
    high_angle: "Máy cao hướng xuống",
    aerial_shot: "Từ trên cao (chim bay)",
    dutch_angle: "Nghiêng máy",
  };
  const SCENE_PREVIEW_CAMERA_MOVEMENT_LABEL: Record<string, string> = {
    static: "Tĩnh",
    pan: "Lia ngang",
    dolly_in: "Tiến vào",
    dolly_out: "Lùi ra",
    tracking: "Bám theo",
  };
  // Đặt tên theo đúng thuật ngữ điện ảnh (tham khảo bảng Lighting thật của Higgsfield Cinema Studio) —
  // xem LIGHT_DIRECTION_LABELS trong lib/story-video.ts (6 giá trị y hệt).
  const SCENE_PREVIEW_LIGHT_DIRECTION_LABEL: Record<string, string> = {
    front_lighting: "Ánh sáng thẳng",
    back_lighting: "Ngược sáng (Contre jour)",
    silhouette: "Bóng đen (Silhouette)",
    side_lighting: "Sáng chéo (Rembrandt)",
    top_lighting: "Sáng từ trên",
    low_lighting: "Sáng hắt từ dưới",
  };
  const LIGHT_DIRECTION_OPTIONS = ["front_lighting", "back_lighting", "silhouette", "side_lighting", "top_lighting", "low_lighting"];
  // 3 trục thiết bị quay độc lập (xem CAMERA_BODY_LABELS/LENS_LABELS/APERTURE_LABELS trong
  // lib/story-video.ts) — tham khảo bảng "Camera > Setup" thật của Higgsfield Cinema Studio.
  const SCENE_PREVIEW_CAMERA_BODY_LABEL: Record<string, string> = {
    modern: "Hiện đại",
    dv_camcorder: "DV cổ điển",
    film_35mm: "Phim 35mm",
    film_8mm: "Phim 8mm (hoài cổ)",
  };
  const CAMERA_BODY_OPTIONS = ["modern", "dv_camcorder", "film_35mm", "film_8mm"];
  const SCENE_PREVIEW_LENS_LABEL: Record<string, string> = {
    clean_sharp: "Sắc nét hiện đại",
    vintage_anamorphic: "Anamorphic cổ điển",
    warm_vintage: "Ấm áp cổ điển",
    halation_vintage: "Cổ điển (quầng sáng)",
  };
  const LENS_OPTIONS = ["clean_sharp", "vintage_anamorphic", "warm_vintage", "halation_vintage"];
  const SCENE_PREVIEW_APERTURE_LABEL: Record<string, string> = {
    moderate: "Vừa phải (f/4)",
    wide_open: "Xoá phông mạnh (f/1.4)",
    deep_focus: "Nét sâu toàn khung (f/11)",
  };
  const APERTURE_OPTIONS = ["moderate", "wide_open", "deep_focus"];
  // Màu thanh trên cùng theo camera_angle — trùng bảng SCENE_PREVIEW_ANGLE_BAR_COLOR trong
  // components/MannequinPreviewCard.tsx (component đó tự vẽ thanh màu, không đọc bảng này nữa).

  // Vị trí/tỉ lệ (theo %, khớp trực tiếp với khung "aspect-video" 16:9) để đặt mannequin 3D tương tác
  // (MannequinPreviewCard) trong khối xem trước bố cục MIỄN PHÍ — nếu khách đã dùng "Chọn vị trí đứng"
  // thì đặt đúng vùng đã khoanh, không thì neo đáy giữa khung theo tỉ lệ shot_size (cận cảnh chiếm gần
  // hết khung, toàn cảnh chỉ chiếm 1 góc nhỏ) — trước đây tính bằng px trên Canvas 2D (renderScenePreviewComposite,
  // đã bỏ), giờ chỉ cần % vì mannequin tự render sống (WebGL) ngay trong khung, không ghép ảnh tĩnh nữa.
  function computeMannequinBoxStyle(
    shotSize: string | null,
    positionRect?: { x: number; y: number; w: number; h: number } | null
  ): { left: string; top: string; width: string; height: string } {
    const scale = SCENE_PREVIEW_SHOT_SCALE[shotSize ?? ""] ?? 0.5;
    // Tỉ lệ khung người chuẩn (rộng:cao) — mannequin cao gấp ~2.2 lần rộng, xấp xỉ đúng camera setup
    // trong buildMannequin()/MannequinPreviewCard (canvas render theo đúng khung div này).
    const personAspect = 0.42;
    let heightPct: number;
    let leftPct: number;
    let topPct: number;
    if (positionRect) {
      const rectHeightPct = positionRect.h * 100;
      heightPct = Math.max(rectHeightPct, scale * 100 * 0.6);
      const widthPct = heightPct * personAspect * (9 / 16);
      leftPct = positionRect.x * 100 + (positionRect.w * 100 - widthPct) / 2;
      topPct = (positionRect.y + positionRect.h) * 100 - heightPct;
      return { left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` };
    }
    heightPct = scale * 100;
    const widthPct = heightPct * personAspect * (9 / 16);
    leftPct = (100 - widthPct) / 2;
    topPct = 100 - heightPct;
    return { left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` };
  }

  // Khách kéo chuột xoay mannequin ở khối "Tạo kịch bản" rồi bấm "Chọn góc này" — ghi đè cameraView vào
  // ĐÚNG action gốc trong storyScriptActions (thứ thật sự gửi lên server khi submit qua preplannedActions)
  // VÀ vào storyScriptScenes[i] (chỉ để hiện nhãn đúng ngay trên UI). Một scene có thể được GỘP từ NHIỀU
  // action gốc (xem PlannedScene.merged_from trong lib/story-video.ts) — chỉ cho ghi đè khi scene đó gộp
  // từ ĐÚNG 1 action (trường hợp phổ biến nhất), tránh ghi nhầm cameraView cho action không liên quan khi
  // bị gộp nhiều action lại thành 1 cảnh.
  function handleScriptCameraViewChange(sceneIndex: number, view: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], camera_view: view };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], camera_view: view };
      return next;
    });
  }

  // Khách kéo chuột xoay mannequin ở khối "scenes_ready" (SAU khi đã submit job, scene đã có id thật
  // trong DB) rồi bấm "Chọn góc này" — cập nhật UI ngay (optimistic) + gọi API lưu lại cameraView thật
  // vào đúng hàng story_video_scenes, để lúc bấm "Tạo ảnh" sau đó dùng đúng góc khách vừa chọn thay vì
  // góc Agent chọn lúc chia cảnh.
  async function handleScenePreviewCameraViewChange(sceneId: number, view: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, cameraView: view } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-camera-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, cameraView: view }),
      });
    } catch {
      // Lưu thất bại thì UI vẫn hiện đúng lựa chọn khách vừa xoay (optimistic) — không chặn thao tác,
      // rủi ro thấp nhất (nếu server không lưu được, ảnh tạo ra vẫn theo góc Agent chọn ban đầu, không
      // sai lệch nghiêm trọng).
    }
  }

  // Mirror đúng handleScriptCameraViewChange nhưng cho light_direction — khách bấm 1 trong 6 nút preset
  // hướng sáng (không kéo-xoay, chỉ dãy nút bấm — xem LIGHT_DIRECTION_OPTIONS).
  function handleScriptLightDirectionChange(sceneIndex: number, lightDirection: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], light_direction: lightDirection };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], light_direction: lightDirection };
      return next;
    });
  }

  // Mirror đúng handleScenePreviewCameraViewChange nhưng cho light_direction.
  async function handleScenePreviewLightDirectionChange(sceneId: number, lightDirection: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, lightDirection } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-light-direction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, lightDirection }),
      });
    } catch {
      // Xem chú thích ở handleScenePreviewCameraViewChange — cùng lý do, không chặn thao tác.
    }
  }

  // Mirror đúng handleScriptLightDirectionChange nhưng cho 3 trục thiết bị (field nào gọi thì truyền
  // đúng field đó, 2 field còn lại giữ nguyên — xem cách gọi trong JSX, mỗi dãy nút chỉ đổi đúng 1 field).
  function handleScriptCameraGearChange(sceneIndex: number, field: "camera_body" | "lens" | "aperture", value: string) {
    setStoryScriptScenes((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[sceneIndex] = { ...next[sceneIndex], [field]: value };
      return next;
    });
    setStoryScriptActions((prev) => {
      if (!prev || !storyScriptScenes) return prev;
      const scene = storyScriptScenes[sceneIndex] as unknown as { merged_from?: StoryScriptAction[] };
      const sourceAction = scene.merged_from && scene.merged_from.length === 1 ? scene.merged_from[0] : null;
      if (!sourceAction) return prev;
      const actionIndex = prev.indexOf(sourceAction);
      if (actionIndex === -1) return prev;
      const next = [...prev];
      next[actionIndex] = { ...next[actionIndex], [field]: value };
      return next;
    });
  }

  // Mirror đúng handleScenePreviewLightDirectionChange nhưng cho 3 trục thiết bị — gọi chung 1 API
  // (update-scene-camera-gear) nhận field nào đổi thì gửi đúng field đó (xem updateSceneCameraGear).
  async function handleScenePreviewCameraGearChange(sceneId: number, field: "cameraBody" | "lens" | "aperture", value: string) {
    setStoryScenePreviews((prev) => (prev ? prev.map((s) => (s.id === sceneId ? { ...s, [field]: value } : s)) : prev));
    try {
      await fetch("/api/story-video/update-scene-camera-gear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneId, [field]: value }),
      });
    } catch {
      // Xem chú thích ở handleScenePreviewCameraViewChange — cùng lý do, không chặn thao tác.
    }
  }

  useEffect(() => {
    if (storyResult) {
      storyResultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyResult]);

  // Ảnh phân cảnh (dù AI tự vẽ hay khách tự tải) luôn đổ về chung 1 khung "Ảnh phân cảnh" — đồng bộ
  // ảnh đã tạo xong từ job đang chạy vào storySceneImages để khung đó luôn có đủ nút xoá/tải thêm/zoom,
  // không bị chuyển sang chế độ chỉ xem sau khi chạy xong.
  useEffect(() => {
    if (!storyScenes) return;
    const urls = storyScenes.map((s) => s.imageUrl).filter((u): u is string => !!u);
    if (urls.length > 0) setStorySceneImages(urls);
  }, [storyScenes]);

  // Thư viện Character đã lưu — tải khi vào app + sau khi lưu 1 Character mới.
  function loadSavedStoryCharacters(userId: string) {
    fetch(`/api/story-video/characters?userId=${userId}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.characters)) setStorySavedCharacters(data.characters);
      })
      .catch(() => {});
  }
  useEffect(() => {
    if (!user) return;
    loadSavedStoryCharacters(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleDeleteSavedCharacter(characterId: number) {
    if (!user) return;
    setStorySavedCharacters((prev) => prev.filter((c) => c.id !== characterId));
    if (storySelectedSavedCharacterId === characterId) setStorySelectedSavedCharacterId(null);
    try {
      await fetch(`/api/story-video/characters?userId=${user.id}&id=${characterId}`, { method: "DELETE" });
    } catch {
      loadSavedStoryCharacters(user.id);
    }
  }

  useEffect(() => {
    return () => {
      if (storyPollRef.current) clearInterval(storyPollRef.current);
    };
  }, []);

  // "Video từ ý tưởng truyện": tải danh sách model ảnh/video từ catalog 1 lần khi vào trang, chọn sẵn
  // model đầu tiên mỗi loại.
  useEffect(() => {
    fetch("/api/story-video/models?miniAppId=video-tu-y-tuong")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.imageModels)) {
          setStoryImageModels(data.imageModels);
          const first = data.imageModels[0];
          if (first) {
            setStoryImageModelKey(first.key);
            if (first.resolution_price_vnd) setStoryResolutionKey(Object.keys(first.resolution_price_vnd)[0]);
          }
        }
        if (Array.isArray(data.videoModels)) {
          setStoryVideoModels(data.videoModels);
          const first = data.videoModels[0];
          if (first) {
            setStoryVideoModelKey(first.key);
            if (first.duration_price_vnd) setStoryDurationKey(Object.keys(first.duration_price_vnd)[0]);
          }
        }
        if (data.genreThumbnails && typeof data.genreThumbnails === "object") {
          setStoryGenreThumbnails(data.genreThumbnails);
        }
        if (typeof data.enableSpeedSlider === "boolean") setStoryEnableSpeedSlider(data.enableSpeedSlider);
      })
      .catch(() => {});
  }, []);

  // Từ 2 nhân vật trở lên bắt buộc dùng model hỗ trợ nhiều ảnh tham chiếu (multi_image) — đã kiểm
  // chứng qua test thật chỉ loại model này ghép được nhiều người vào 1 cảnh. Tự chuyển sang model
  // multi_image đầu tiên nếu model đang chọn không hỗ trợ, tránh khách bấm chạy rồi mới bị lỗi. Ảnh
  // Bối cảnh/Địa điểm và ảnh Vật phẩm riêng cũng cần multi_image (thêm ảnh tham chiếu nữa) nên dùng
  // chung điều kiện — thiếu điều kiện vật phẩm trước đây khiến job chỉ có vật phẩm (không kèm nhiều
  // nhân vật/địa điểm) âm thầm bỏ qua hẳn ảnh vật phẩm vì vẫn ở model 1-ảnh mặc định (xác nhận qua
  // job thật #127: item_reference_urls có dữ liệu nhưng image_model vẫn là flux-pro/kontext).
  useEffect(() => {
    // Đã khoanh vùng đặt nhân vật (mask) — CHỈ GPT Image 2 Edit thật sự hỗ trợ mask_url, ưu tiên điều
    // kiện này trước cả multi_image (GPT Image 2 Edit vốn cũng multi_image nên không xung đột).
    if (storyLocationReferenceMaskUrl) {
      const current = storyImageModels.find((m) => m.key === storyImageModelKey);
      if (current && current.model !== "fal-ai/gpt-image-2/edit") {
        const fallback = storyImageModels.find((m) => m.model === "fal-ai/gpt-image-2/edit");
        if (fallback) setStoryImageModelKey(fallback.key);
      }
      return;
    }
    if (storyExtraCharacters.length === 0 && !storyLocationReference && storyPrimaryItemReferences.length === 0) return;
    const current = storyImageModels.find((m) => m.key === storyImageModelKey);
    if (current && !current.multi_image) {
      const fallback = storyImageModels.find((m) => m.multi_image);
      if (fallback) setStoryImageModelKey(fallback.key);
    }
  }, [
    storyExtraCharacters.length,
    storyLocationReference,
    storyLocationReferenceMaskUrl,
    storyPrimaryItemReferences.length,
    storyImageModels,
    storyImageModelKey,
  ]);

  // "Video từ ý tưởng truyện": tự khôi phục job gần nhất còn dở dang khi khách quay lại trang (đóng
  // tab/tắt máy giữa chừng) — trước đây mọi tiến trình chỉ nằm trong state trình duyệt nên tắt đi là
  // mất, dù job vẫn đang chạy/đã hoàn thành phía server. Bao gồm cả "failed" vì job này có 2 lượt trừ
  // credit riêng (ảnh/video) — lỗi ở bước video không có nghĩa ảnh đã tạo (đã trả tiền) cũng mất theo.
  useEffect(() => {
    if (!user || storyJobId) return;
    fetch(`/api/story-video/active?userId=${user.id}`)
      .then((res) => res.json())
      .then(async (data) => {
        const job = data.job;
        if (!job) return;
        if (data.project) restoreStoryProject(data.project, data.chapterIndex ?? null);
        setStoryJobId(job.id);
        if (job.storyDescription) setInput(job.storyDescription);
        if (Array.isArray(job.characterImageUrls) && job.characterImageUrls.length > 0) {
          setStoryCharacterImages(job.characterImageUrls);
        }
        if (job.locationReferenceUrl) setStoryLocationReference(job.locationReferenceUrl);
        if (job.locationReferenceMaskUrl) setStoryLocationReferenceMaskUrl(job.locationReferenceMaskUrl);
        restoreLocationMaskZones(job.locationReferenceMaskZones);
        // Job 1 nhân vật không có toạ độ vùng (chỉ có ảnh mask) — dò lại từ ảnh mask để vẽ đè lên ảnh Bối cảnh.
        if (job.locationReferenceMaskUrl && !(Array.isArray(job.locationReferenceMaskZones) && job.locationReferenceMaskZones.length > 0)) {
          restoreSingleMaskRect(job.locationReferenceMaskUrl);
        }
        setStoryRunning(true);
        setStoryStatusText("Đang khôi phục công việc đang làm dở...");
        try {
          const res = await fetch(`/api/story-video/status?jobId=${job.id}`);
          const statusData = await res.json();
          if (Array.isArray(statusData.scenes)) setStoryScenes(statusData.scenes);
          setStoryStatus(statusData.status ?? null);
          if (statusData.characterSheetUrl) setStoryCharacterSheetUrl(statusData.characterSheetUrl);
          if (statusData.characterSource) setStoryCharacterSource(statusData.characterSource);
          if (statusData.status === "done" && statusData.outputUrl) {
            setStoryResult(statusData.outputUrl);
            setStoryRunning(false);
            setStoryStatusText(null);
          } else if (statusData.status === "character_ready" || statusData.status === "images_ready") {
            setStoryRunning(false);
            setStoryStatusText(statusData.statusText ?? null);
          } else if (statusData.status === "failed" || statusData.status === "cancelled") {
            setStoryError(
              statusData.status === "cancelled"
                ? statusData.errorMessage ?? "Đã dừng theo yêu cầu của bạn"
                : statusData.errorMessage ?? "Tạo video thất bại, credit đã được hoàn"
            );
            setStoryRunning(false);
            setStoryStatusText(null);
          } else {
            setStoryStatusText(statusData.statusText ?? "Đang xử lý...");
            pollStoryVideoStatus(job.id);
          }
        } catch {
          setStoryRunning(false);
          setStoryStatusText(null);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // "Video từ ý tưởng truyện": giá tăng theo số phân cảnh (2-8) + model/tỉ lệ/độ phân giải/thời
  // lượng đã chọn — tính lại mỗi khi đổi.
  useEffect(() => {
    if (!storyImageModelKey || !storyVideoModelKey) return;
    const params2 = new URLSearchParams({
      miniAppId: "video-tu-y-tuong",
      numScenes: String(numScenes),
      imageModelKey: storyImageModelKey,
      videoModelKey: storyVideoModelKey,
    });
    if (storyResolutionKey) params2.set("resolutionKey", storyResolutionKey);
    if (storyDurationKey) params2.set("durationKey", storyDurationKey);
    if (storyContinuousMotion) params2.set("continuousMotion", "1");
    fetch(`/api/story-video/price?${params2.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.imageCost === "number") setStoryImageCost(data.imageCost);
        if (typeof data.videoCost === "number") setStoryVideoCost(data.videoCost);
        if (typeof data.characterCost === "number") setStoryCharacterCost(data.characterCost);
      })
      .catch(() => {});
  }, [numScenes, storyImageModelKey, storyVideoModelKey, storyResolutionKey, storyDurationKey, storyContinuousMotion]);

  if (!app) {
    return null;
  }

  const relatedApps = MINI_APPS.filter(
    (item) => item.category === app.category && item.id !== app.id
  ).slice(0, 3);

  // Nén/resize ảnh NGAY trên trình duyệt trước khi tạo base64 để tải lên — ảnh điện thoại chụp
  // thường 3-8MB, base64 hoá phình thêm ~33% rồi còn phải đi 2 chặng mạng (trình duyệt → Vercel →
  // Supabase Storage), là nguyên nhân chính khiến tải ảnh chậm. Các model AI tạo ảnh xử lý ảnh tham
  // chiếu ở độ phân giải nội bộ thấp hơn maxDimension này nhiều, nên thu nhỏ không làm giảm chất
  // lượng AI nhận diện nhân vật — chỉ giảm dung lượng file thật sự cần gửi đi.
  async function compressImageFile(file: File, maxDimension = 1800, quality = 0.85): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // GIF động: canvas chỉ lấy được 1 khung hình tĩnh, sẽ mất hoạt ảnh — giữ nguyên gốc, không nén.
    if (file.type === "image/gif") return dataUrl;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Không đọc được ảnh"));
        el.src = dataUrl;
      });
      const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return dataUrl;
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", quality);
    } catch {
      // Nén lỗi (trình duyệt cũ, ảnh hỏng...) — dùng ảnh gốc, không chặn khách tải lên.
      return dataUrl;
    }
  }

  // Sinh ảnh mask đen/trắng cùng kích thước ẢNH GỐC (naturalW/naturalH) từ N vùng chữ nhật đã khoanh
  // (toạ độ chuẩn hoá 0..1, mỗi vùng ứng với 1 nhân vật) — TẤT CẢ vùng đều tô trắng chung 1 ảnh (mask
  // không tự phân biệt vùng nào cho ai, xem lib/story-video.ts: describeMaskZonePosition dùng toạ độ
  // riêng để viết chỉ dẫn văn bản gán từng vùng cho đúng người). Dùng PNG (không nén mất dữ liệu) để
  // giữ đúng biên trắng/đen sắc nét.
  function generateLocationMaskDataUrl(
    rects: { x: number; y: number; w: number; h: number }[],
    naturalW: number,
    naturalH: number
  ): string {
    const canvas = document.createElement("canvas");
    canvas.width = naturalW;
    canvas.height = naturalH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, naturalW, naturalH);
    ctx.fillStyle = "white";
    rects.forEach((rect) => ctx.fillRect(rect.x * naturalW, rect.y * naturalH, rect.w * naturalW, rect.h * naturalH));
    return canvas.toDataURL("image/png");
  }

  function handleLocationMaskPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return; // khung chưa có kích thước (đang ẩn) — tránh chia cho 0 ra NaN
    const x = Math.min(Math.max((e.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - bounds.top) / bounds.height, 0), 1);
    storyLocationMaskDragStartRef.current = { x, y };
    setStoryLocationMaskRect({ x, y, w: 0, h: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleLocationMaskPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = storyLocationMaskDragStartRef.current;
    if (!start) return;
    // Không còn nút chuột nào đang giữ = lượt kéo đã kết thúc (sự kiện nhả chuột bị mất, vd nhả ngoài khung
    // hoặc kéo nhanh) — nếu không dừng ở đây, cờ kéo bị kẹt và vùng tự chạy theo chuột khi chỉ rê qua ảnh.
    if (e.buttons === 0) {
      storyLocationMaskDragStartRef.current = null;
      return;
    }
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - bounds.left) / bounds.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - bounds.top) / bounds.height, 0), 1);
    setStoryLocationMaskRect({ x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) });
  }

  function handleLocationMaskPointerUp() {
    storyLocationMaskDragStartRef.current = null;
  }

  // 1 nhân vật (mặc định) — giữ đúng luồng cũ, đơn giản: vẽ xong 1 vùng, bấm là xong ngay, không cần
  // bước "Lưu vị trí" trung gian như luồng nhiều nhân vật bên dưới.
  function handleConfirmLocationMask() {
    if (!storyLocationMaskRect || !storyLocationImageNaturalSize) return;
    if (storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION || storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION) return; // vùng quá nhỏ, coi như chưa chọn
    const dataUrl = generateLocationMaskDataUrl([storyLocationMaskRect], storyLocationImageNaturalSize.w, storyLocationImageNaturalSize.h);
    setStoryLocationReferenceMaskUrl(dataUrl);
    // Lưu vùng đã chọn thành "vị trí của nhân vật #1" để vẽ đè lên ảnh Bối cảnh (cùng cơ chế nhiều nhân vật).
    setStoryLocationMaskAssignments([{ characterPosition: 0, rect: storyLocationMaskRect }]);
    setStoryLocationMaskEditorOpen(false);
  }

  // Khôi phục job 1 nhân vật: server chỉ lưu ẢNH mask (không lưu toạ độ) — dò lại hình chữ nhật trắng từ chính
  // ảnh mask để vẽ đè lên ảnh Bối cảnh. Lỗi (vd trình duyệt chặn đọc ảnh khác nguồn) thì bỏ qua, chỉ mất khung
  // vẽ đè, mask vẫn dùng bình thường.
  function restoreSingleMaskRect(maskUrl: string) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const scale = Math.min(1, 240 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4] > 200) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return;
        setStoryLocationMaskAssignments((prev) =>
          prev.length > 0
            ? prev
            : [{ characterPosition: 0, rect: { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h } }]
        );
      } catch {}
    };
    img.src = maskUrl;
  }

  // NHIỀU nhân vật — lưu vùng vừa vẽ cho ĐÚNG nhân vật đang chọn (storyLocationMaskActiveCharacter),
  // ghi đè nếu người đó đã có vùng trước đó, rồi tự chuyển sang nhân vật kế tiếp CHƯA có vùng (nếu
  // còn) để khách không phải tự bấm chọn từng người theo đúng thứ tự.
  function handleSaveLocationMaskAssignment(characterOptions: { position: number; label: string }[]) {
    if (!storyLocationMaskRect) return;
    if (storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION || storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION) return;
    const rect = storyLocationMaskRect;
    storyLocationMaskDragStartRef.current = null;
    const updatedAssignments = [
      ...storyLocationMaskAssignments.filter((a) => a.characterPosition !== storyLocationMaskActiveCharacter),
      { characterPosition: storyLocationMaskActiveCharacter, rect },
    ];
    commitLocationMaskAssignments(updatedAssignments);
    const assignedPositions = new Set(updatedAssignments.map((a) => a.characterPosition));
    const next = characterOptions.find((c) => !assignedPositions.has(c.position));
    if (next) {
      // Còn người chưa gán — chuyển sang người đó, ô vẽ để trống chờ khách vẽ mới cho người này.
      setStoryLocationMaskActiveCharacter(next.position);
      setStoryLocationMaskRect(null);
    } else {
      // SỬA (xác nhận thật qua ảnh chụp khách gửi): trước đây luôn setStoryLocationMaskRect(null) ở
      // đây — khi vừa lưu xong NGƯỜI CUỐI CÙNG (không còn ai chưa gán), ô vừa vẽ bị xoá trắng ngay lập
      // tức dù đã lưu thành công (chip vẫn có ✓), khiến khách tưởng nhầm "vị trí chưa lưu" vì không
      // thấy ô nào trên ảnh cho tới khi bấm lại đúng chip đó. Giữ nguyên ô vừa vẽ hiển thị luôn thay vì
      // xoá trắng khi không còn ai để tự động chuyển sang.
      setStoryLocationMaskRect(rect);
    }
  }

  // Đặt danh sách vị trí mới VÀ sinh lại ảnh mask ngay (không chờ bấm "Xong") — mask gửi lên server luôn khớp
  // đúng các vị trí đang hiện trên ảnh, không có tình trạng "đã lưu vị trí nhưng mask cũ/thiếu".
  function commitLocationMaskAssignments(next: { characterPosition: number; rect: { x: number; y: number; w: number; h: number } }[]) {
    setStoryLocationMaskAssignments(next);
    if (next.length === 0 || !storyLocationImageNaturalSize) {
      setStoryLocationReferenceMaskUrl(null);
      return;
    }
    setStoryLocationReferenceMaskUrl(
      generateLocationMaskDataUrl(
        next.map((a) => a.rect),
        storyLocationImageNaturalSize.w,
        storyLocationImageNaturalSize.h
      )
    );
  }

  function handleRemoveLocationMaskAssignment(characterPosition: number) {
    commitLocationMaskAssignments(storyLocationMaskAssignments.filter((a) => a.characterPosition !== characterPosition));
    if (characterPosition === storyLocationMaskActiveCharacter) setStoryLocationMaskRect(null);
  }

  // Gộp mọi vùng đã "Lưu vị trí" thành 1 ảnh mask duy nhất, đóng khung chọn — dùng cho luồng NHIỀU
  // nhân vật (nút "Xong"). Không làm gì nếu chưa gán vùng nào (giữ nguyên mask cũ nếu có, hoặc vẫn null).
  function handleFinishLocationMask() {
    if (storyLocationMaskAssignments.length === 0 || !storyLocationImageNaturalSize) {
      setStoryLocationMaskEditorOpen(false);
      return;
    }
    const dataUrl = generateLocationMaskDataUrl(
      storyLocationMaskAssignments.map((a) => a.rect),
      storyLocationImageNaturalSize.w,
      storyLocationImageNaturalSize.h
    );
    setStoryLocationReferenceMaskUrl(dataUrl);
    setStoryLocationMaskEditorOpen(false);
  }

  function handleClearLocationMask() {
    setStoryLocationReferenceMaskUrl(null);
    setStoryLocationMaskRect(null);
    setStoryLocationMaskAssignments([]);
    setStoryLocationMaskActiveCharacter(0);
  }

  // Khôi phục job dở dang — dựng lại storyLocationMaskAssignments từ dữ liệu server (chỉ có ở job
  // nhiều nhân vật) để khách "Chọn lại vị trí đứng" vẫn thấy đúng các vùng đã gán trước đó.
  function restoreLocationMaskZones(zones: unknown) {
    if (!Array.isArray(zones)) return;
    const assignments = zones
      .filter(
        (z): z is { position: number; xPct: number; yPct: number; wPct: number; hPct: number } =>
          !!z && typeof z === "object" && typeof (z as Record<string, unknown>).position === "number"
      )
      .map((z) => ({ characterPosition: z.position, rect: { x: z.xPct, y: z.yPct, w: z.wPct, h: z.hPct } }));
    if (assignments.length > 0) setStoryLocationMaskAssignments(assignments);
  }

  async function uploadOutfitSwapImage(dataUrl: string): Promise<string> {
    const res = await fetch("/api/outfit-swap/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user!.id, dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Không tải được ảnh lên");
    return data.url as string;
  }
  function pollStoryVideoStatus(jobId: number) {
    storyPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (Array.isArray(data.scenes)) setStoryScenes(data.scenes);
        if (Array.isArray(data.scenePreviews)) setStoryScenePreviews(data.scenePreviews);
        if (data.characterAngleUrls) setStoryCharacterAngleUrlsForPreview(data.characterAngleUrls);
        setStoryStatus(data.status ?? null);
        if (data.characterSheetUrl) setStoryCharacterSheetUrl(data.characterSheetUrl);
        if (data.characterSource) setStoryCharacterSource(data.characterSource);
        setStoryJobCharacters(Array.isArray(data.characters) ? data.characters : null);
        if (data.locationReferenceUrl) setStoryLocationReference(data.locationReferenceUrl);
        if (data.locationReferenceMaskUrl) setStoryLocationReferenceMaskUrl(data.locationReferenceMaskUrl);
        restoreLocationMaskZones(data.locationReferenceMaskZones);

        if (data.status === "done" && data.outputUrl) {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryResult(data.outputUrl);
          setStoryRunning(false);
          setStoryStatusText(null);
        } else if (data.status === "scenes_ready") {
          // Dừng poll — job đang chờ khách xem preview bố cục MIỄN PHÍ (chưa tốn credit) rồi tự bấm
          // "Tạo ảnh" (handleContinueToImages), không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "character_ready") {
          // Dừng poll — job đang chờ khách xem/duyệt ảnh Character, tự bấm "Tạo lại" hoặc
          // "Tiếp tục chia cảnh", không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "images_ready") {
          // Dừng poll — job đang chờ khách xem ảnh và tự bấm "Tạo video", không có gì chạy ngầm nữa.
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryRunning(false);
          setStoryStatusText(data.statusText ?? null);
        } else if (data.status === "failed" || data.status === "cancelled") {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryError(
            data.status === "cancelled" ? data.errorMessage ?? "Đã dừng theo yêu cầu của bạn" : data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn"
          );
          setStoryRunning(false);
          setStoryStatusText(null);
        } else if (data.statusText) {
          setStoryStatusText(data.statusText);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  // Poll riêng cho tạo lại 1 cảnh — khác pollStoryVideoStatus vì job.status đã ở "images_ready"/"failed"
  // từ trước (không đổi khi tạo lại 1 cảnh), nên không thể dùng chung vòng poll đó (nó dừng ngay lập
  // tức khi thấy status "images_ready"). CHỈ cập nhật storyScenes khi ảnh cảnh này đã có url mới —
  // không cập nhật lúc còn null, tránh làm lệch storySceneImages (effect đồng bộ lọc bỏ null nên 1
  // cảnh null giữa chừng sẽ làm co mảng, dịch chuyển sai vị trí các ảnh khác). Ảnh cũ vẫn hiện nguyên
  // (kèm overlay đang xử lý) cho tới khi có ảnh mới thay hẳn.
  function pollSceneRegenerate(jobId: number, sceneId: number) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { id: number; imageUrl: string | null }) => s.id === sceneId)
          : null;
        if (scene?.imageUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingSceneId((cur) => (cur === sceneId ? null : cur));
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingSceneId((cur) => (cur === sceneId ? null : cur));
    }, 120000);
  }

  async function handleRegenerateScene(sceneId: number) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingSceneId(sceneId);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sceneId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingSceneId(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollSceneRegenerate(storyJobId, sceneId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingSceneId(null);
    }
  }

  // Poll cho tạo lại ảnh chế độ chuyển động liên tục — theo dõi VỊ TRÍ (không phải sceneId, xem
  // handleRegenerateContinuousScene) vì ảnh mới có thể được ghi vào 1 cảnh KHÁC (cảnh liền trước) rồi
  // copy sang image_url của đúng vị trí này.
  function pollContinuousSceneRegenerate(jobId: number, position: number, previousUrl: string | null) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { position: number; imageUrl: string | null }) => s.position === position)
          : null;
        if (scene?.imageUrl && scene.imageUrl !== previousUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingContinuousPosition((cur) => (cur === position ? null : cur));
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingContinuousPosition((cur) => (cur === position ? null : cur));
    }, 120000);
  }

  async function handleRegenerateContinuousScene(position: number) {
    if (!user || !storyJobId) return;
    const previousUrl = storyScenes?.find((s) => s.position === position)?.imageUrl ?? null;
    setStoryRegeneratingContinuousPosition(position);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-continuous-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId, position }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingContinuousPosition(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollContinuousSceneRegenerate(storyJobId, position, previousUrl);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingContinuousPosition(null);
    }
  }

  // "Kiểm tra thiếu chi thể" — nút thủ công, không trừ credit, gọi trực tiếp qua sceneId+imageUrl.
  async function handleCheckSceneAnatomy(sceneId: number, imageUrl: string) {
    setStoryAnatomyChecking((prev) => ({ ...prev, [sceneId]: true }));
    try {
      const res = await fetch("/api/story-video/check-scene-anatomy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, miniAppId: "video-tu-y-tuong" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi kiểm tra");
        return;
      }
      setStoryAnatomyResults((prev) => ({ ...prev, [sceneId]: { ok: data.ok, issue: data.issue } }));
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryAnatomyChecking((prev) => ({ ...prev, [sceneId]: false }));
    }
  }

  // "Kiểm tra lệch ảnh đầu/cuối" — chỉ áp dụng cảnh có đủ image_url + endImageUrl (chuyển động liên
  // tục), không trừ credit.
  async function handleCheckSceneContinuity(sceneId: number, startImageUrl: string, endImageUrl: string) {
    setStoryContinuityChecking((prev) => ({ ...prev, [sceneId]: true }));
    try {
      const res = await fetch("/api/story-video/check-scene-continuity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startImageUrl, endImageUrl, miniAppId: "video-tu-y-tuong" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi kiểm tra");
        return;
      }
      setStoryContinuityResults((prev) => ({ ...prev, [sceneId]: { ok: data.ok, issue: data.issue } }));
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryContinuityChecking((prev) => ({ ...prev, [sceneId]: false }));
    }
  }

  // Poll riêng cho tạo lại VIDEO 1 cảnh — cùng khuôn pollSceneRegenerate (ảnh) nhưng theo dõi videoUrl
  // thay vì imageUrl. job.status không đổi khi tạo lại 1 cảnh (có thể đã "done" từ trước), nên không
  // dùng chung pollStoryVideoStatus (nó dừng ngay khi thấy "done").
  function pollSceneVideoRegenerate(jobId: number, sceneId: number) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();
        const scene = Array.isArray(data.scenes)
          ? data.scenes.find((s: { id: number; videoUrl: string | null }) => s.id === sceneId)
          : null;
        if (scene?.videoUrl) {
          setStoryScenes(data.scenes);
          clearInterval(interval);
          setStoryRegeneratingVideoSceneId((cur) => (cur === sceneId ? null : cur));
          // Server có thể đã ghép lại thành video cuối mới (khi tất cả cảnh đã có video) -> lấy luôn
          // outputUrl mới nhất để khách thấy đúng bản đã cập nhật, không phải bản ghép cũ.
          if (data.status === "done" && data.outputUrl) setStoryResult(data.outputUrl);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
    setTimeout(() => {
      clearInterval(interval);
      setStoryRegeneratingVideoSceneId((cur) => (cur === sceneId ? null : cur));
    }, 180000);
  }

  async function handleRegenerateSceneVideo(sceneId: number, customPrompt?: string) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingVideoSceneId(sceneId);
    setStoryEditingPromptSceneId(null);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-scene-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sceneId, customPrompt }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingVideoSceneId(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      pollSceneVideoRegenerate(storyJobId, sceneId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingVideoSceneId(null);
    }
  }

  async function handleRegenerateCharacter() {
    if (!user || !storyJobId) return;
    setStoryRegeneratingCharacter(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingCharacter(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryRegeneratingCharacter(false);
      setStoryRunning(true);
      setStoryCharacterSheetUrl(null);
      setStoryStatusText("Đang tạo lại ảnh Character...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingCharacter(false);
    }
  }

  // Tạo lại Character của ĐÚNG 1 người trong job nhiều nhân vật — mirror handleRegenerateCharacter()
  // nhưng nhắm đúng 1 "position", các người khác trong lưới giữ nguyên ảnh cũ.
  async function handleRegenerateJobCharacter(position: number) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingJobCharacterPosition(position);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-job-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId, position }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRegeneratingJobCharacterPosition(null);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryRunning(true);
      setStoryStatusText("Đang tạo lại ảnh Character...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRegeneratingJobCharacterPosition(null);
    }
  }

  async function handleCheckCharacterImage() {
    if (storyCharacterImages.length === 0) return;
    setStoryCheckingImage(true);
    setStoryImageCheckResult(null);
    try {
      // Kiểm tra TOÀN BỘ ảnh đã tải — chỉ báo "đã là Character" khi TẤT CẢ đều là sheet sẵn.
      // Ảnh đã có URL thật (vd job dở dang được khôi phục) thì dùng thẳng, chỉ upload ảnh base64 mới.
      const imageUrls = await Promise.all(
        storyCharacterImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))
      );
      const res = await fetch("/api/story-video/classify-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls }),
      });
      const data = await res.json();
      setStoryImageCheckResult(res.ok && data.isSheet ? "sheet" : "photo");
    } catch {
      setStoryImageCheckResult(null);
    } finally {
      setStoryCheckingImage(false);
    }
  }

  async function handleSaveCharacter() {
    if (!user || !storyCharacterSheetUrl) return;
    setStorySavingCharacter(true);
    setStorySavedCharacterMsg(null);
    try {
      const res = await fetch("/api/story-video/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, imageUrl: storyCharacterSheetUrl, jobId: storyJobId ?? undefined }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.id) {
        setStorySavedCharacterMsg("Đã lưu vào thư viện Character.");
        // Chuyển ô "Ảnh nhân vật" sang hiển thị đúng Character vừa lưu (thay vì còn giữ ảnh thường gốc
        // đã tải lên) — khách không cần tự chọn lại từ thư viện, thấy ngay đây là Character đang dùng.
        const sheetUrl = storyCharacterSheetUrl;
        setStorySavedCharacters((prev) => [...prev, { id: data.id, imageUrl: sheetUrl, label: null }]);
        setStorySelectedSavedCharacterId(data.id);
        setStoryCharacterImages([]);
        loadSavedStoryCharacters(user.id);
      } else {
        setStorySavedCharacterMsg("Không lưu được, thử lại.");
      }
    } catch {
      setStorySavedCharacterMsg("Không kết nối được tới server");
    } finally {
      setStorySavingCharacter(false);
    }
  }

  async function handleContinueToScenes() {
    if (!user || !storyJobId || !input.trim()) return;
    setStoryContinuingScenes(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue-to-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: storyJobId,
          modelChatKey: storyModelChatKey,
          storyDescription: input.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuingScenes(false);
        return;
      }
      // newBalance null = luồng 1 nhân vật, chưa trừ credit (chỉ chia cảnh, xem preview miễn phí trước) —
      // không cần phát sự kiện cập nhật số dư vì số dư chưa đổi. Luồng nhiều nhân vật vẫn trừ ngay như
      // cũ nên vẫn phát sự kiện bình thường.
      if (data.newBalance !== null) window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingScenes(false);
      setStoryRunning(true);
      setStoryStatusText("Đang chia phân cảnh...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingScenes(false);
    }
  }

  // Bước 2 của preview miễn phí (luồng 1 nhân vật) — khách đã xem bố cục Agent chọn ở status
  // "scenes_ready", bấm "Tạo ảnh" mới thật sự trừ credit + gọi model ảnh.
  async function handleContinueToImages() {
    if (!user || !storyJobId) return;
    setStoryContinuingImages(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue-to-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuingImages(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingImages(false);
      setStoryRunning(true);
      setStoryStatusText(`Đang tạo ảnh cho ${storyScenePreviews?.length ?? numScenes} phân cảnh...`);
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingImages(false);
    }
  }

  async function handleContinueToVideo() {
    if (!user || !storyJobId) return;
    setStoryActiveButton("video");
    setStoryContinuing(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryContinuing(false);
        return;
      }
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuing(false);
      setStoryRunning(true);
      setStoryStatusText("Đang tạo video cho từng phân cảnh...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuing(false);
    }
  }

  // Khách chấp nhận bỏ cảnh mãi không tạo video được (vd bị model chặn nội dung) — ghép video cuối
  // chỉ từ các cảnh đã có video, không chờ đủ tất cả cảnh nữa.
  // Khách chủ động bấm "Dừng tạo" khi job đang chạy dở — dừng hẳn, xem cancelStoryVideoJob() trong
  // lib/story-video.ts (KHÔNG hoàn credit các cảnh đã tốn trước đó, đúng lựa chọn của khách).
  async function handleCancelStoryVideo() {
    if (!user || !storyJobId) return;
    if (storyPollRef.current) clearInterval(storyPollRef.current);
    setStoryCancelling(true);
    try {
      const res = await fetch("/api/story-video/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra khi dừng job");
        setStoryCancelling(false);
        return;
      }
      setStoryStatus("cancelled");
      setStoryError("Đã dừng theo yêu cầu của bạn");
      setStoryRunning(false);
      setStoryStatusText(null);
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryCancelling(false);
    }
  }

  async function handleFinalizePartial() {
    if (!user || !storyJobId) return;
    setStoryFinalizingPartial(true);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/finalize-partial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, jobId: storyJobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryFinalizingPartial(false);
        return;
      }
      setStoryRunning(true);
      setStoryStatusText("Đang ghép video từ các cảnh đã có...");
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
    } finally {
      setStoryFinalizingPartial(false);
    }
  }

  // ================= Video NHIỀU CHƯƠNG (dự án) =================
  // Model không hỗ trợ tỉ lệ đã khoá theo chương 1 thì ẩn khỏi dropdown (không thì đổi model sẽ phá khoá).
  function modelSupportsLockedRatio(m: { aspect_ratios?: string[] }): boolean {
    return !storyLockedAspectRatio || !m.aspect_ratios || m.aspect_ratios.includes(storyLockedAspectRatio);
  }
  async function handleToggleMultiChapter(enabled: boolean) {
    setStoryProjectError(null);
    if (!enabled) {
      setStoryMultiChapter(false);
      return;
    }
    setStoryMultiChapter(true);
    setStoryActiveChapter(0);
    try {
      let projectId = storyProjectId;
      if (projectId === null) {
        const res = await fetch("/api/story-video/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ miniAppId: app!.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Không tạo được dự án");
        projectId = data.projectId as number;
        setStoryProjectId(projectId);
      }
      // Trang đã có sẵn 1 job (vd job vừa khôi phục sau khi tải lại trang, hoặc đang chạy dở) — gắn luôn làm
      // Chương 1 để khách không phải bỏ nó đi làm lại từ đầu.
      if (storyJobId !== null) {
        const res = await fetch("/api/story-video/projects/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, jobId: storyJobId, chapterIndex: 0 }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Không gắn được video hiện tại vào dự án");
        }
      }
    } catch (err) {
      setStoryMultiChapter(false);
      setStoryProjectError(err instanceof Error ? err.message : "Không tạo được dự án");
    }
  }
  // Đưa MỌI ô của form về trạng thái trống cho chương mới. GIỮ LẠI (khách vẫn sửa được): model ảnh/video, độ
  // phân giải/thời lượng, model chat, thể loại, tự động tạo video, chuyển động liên tục/frame-chain, tỉ lệ khung
  // hình (khoá theo chương 1). Ảnh nhân vật, ảnh bối cảnh, vật phẩm, ý tưởng, kịch bản, cảnh, video: xoá hết.
  function resetStoryFormForNextChapter() {
    if (storyPollRef.current) clearInterval(storyPollRef.current);
    setInput("");
    setNumScenes(3);
    setSceneCountChosen(false);
    setStoryScriptActions(null);
    setStoryScriptScenes(null);
    setStoryScriptTotalSeconds(null);
    setStoryScriptVideoCreditCost(null);
    setStoryScriptLoading(false);
    setStoryScriptError(null);
    setStorySpeedDrafts({});
    setStorySpeedFinalized(false);
    setStorySpeedLoading(false);
    setStoryCharacterImages([]);
    setStoryExtraCharacters([]);
    setStoryPrimaryCharacterLabel("");
    setStoryCharacterInputMode("photo");
    setStoryCharacterAppearanceDescription("");
    setStoryLocationReference(null);
    setStoryLocationReferenceMaskUrl(null);
    setStoryLocationMaskRect(null);
    setStoryLocationMaskEditorOpen(false);
    setStoryLocationImageNaturalSize(null);
    setStoryLocationMaskAssignments([]);
    setStoryLocationMaskActiveCharacter(0);
    setStoryPrimaryItemReferences([]);
    setStorySkipCharacterCreation(false);
    setStoryUseOwnSceneImages(false);
    setStorySceneImages([]);
    setStorySceneHints([]);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStoryRegeneratingCharacter(false);
    setStoryJobCharacters(null);
    setStoryRegeneratingJobCharacterPosition(null);
    setStoryContinuingScenes(false);
    setStorySavingCharacter(false);
    setStorySavedCharacterMsg(null);
    setStorySelectedSavedCharacterId(null);
    setStoryCheckingImage(false);
    setStoryImageCheckResult(null);
    setStoryRunning(false);
    setStoryContinuing(false);
    setStoryFinalizingPartial(false);
    setStoryCancelling(false);
    setStoryActiveButton(null);
    setStoryStatusText(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryScenes(null);
    setStoryRegeneratingSceneId(null);
    setStoryRegeneratingContinuousPosition(null);
    setStoryAnatomyChecking({});
    setStoryAnatomyResults({});
    setStoryContinuityChecking({});
    setStoryContinuityResults({});
    setStoryRegeneratingVideoSceneId(null);
    setStoryEditingPromptSceneId(null);
    setStoryEditedPrompt("");
    setStoryResult(null);
    setStoryError(null);
    setStoryQuickZoomUrl(null);
    setSuggestingScenes(false);
    setSceneSuggestError(null);
  }
  async function handleNextChapter() {
    if (storyProjectId === null || !storyJobId || !storyResult) return;
    if (storyActiveChapter + 1 >= STORY_MAX_CHAPTERS) return;
    const finished: StoryProjectChapter = {
      chapterIndex: storyActiveChapter,
      jobId: storyJobId,
      outputUrl: storyResult,
      title: input.trim().slice(0, 80),
    };
    // Tỉ lệ khoá theo chương 1 — lấy từ server (tỉ lệ job chương 1 THỰC SỰ dùng), lỗi mạng thì dùng tỉ lệ đang chọn.
    let locked = storyLockedAspectRatio ?? storyAspectRatio;
    try {
      const res = await fetch(`/api/story-video/projects?projectId=${storyProjectId}`);
      const data = await res.json();
      if (res.ok && data.project?.aspectRatio) locked = data.project.aspectRatio;
    } catch {}
    setStoryProjectChapters((prev) => [...prev.filter((c) => c.chapterIndex !== finished.chapterIndex), finished]);
    setStoryLockedAspectRatio(locked);
    setStoryAspectRatio(locked);
    resetStoryFormForNextChapter();
    setStoryActiveChapter(finished.chapterIndex + 1);
    setStoryViewChapter(null);
    setTimeout(() => storyFormTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function handleFinishProject() {
    if (storyProjectId === null || storyProjectFinalizing) return;
    setStoryProjectFinalizing(true);
    setStoryProjectError(null);
    try {
      const res = await fetch("/api/story-video/projects/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: storyProjectId, transitions: storyChapterTransitions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Không ghép được video");
      setStoryProjectFinalUrl(data.finalOutputUrl);
      setTimeout(() => storyProjectFinalRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (err) {
      setStoryProjectError(err instanceof Error ? err.message : "Không ghép được video");
    } finally {
      setStoryProjectFinalizing(false);
    }
  }
  // Dự án đã kết thúc -> bắt đầu dự án mới (form trống, quay về chế độ thường; khách bật lại nếu muốn nhiều chương).
  function handleNewProject() {
    resetStoryFormForNextChapter();
    setStoryProjectChapters([]);
    setStoryProjectFinalUrl(null);
    setStoryLockedAspectRatio(null);
    setStoryViewChapter(null);
    setStoryActiveChapter(0);
    setStoryProjectId(null);
    setStoryMultiChapter(false);
    setStoryProjectError(null);
    setStoryChapterTransitions([]);
    setTimeout(() => storyFormTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  // Khôi phục dự án dở dang sau khi tải lại trang — dựng lại tab chương từ database (chương đang soạn dở mà
  // chưa bấm chạy thì không có gì để khôi phục, giống hành vi 1 job đơn hiện tại).
  function restoreStoryProject(
    project: {
      id: number;
      status: string;
      aspectRatio: string | null;
      finalOutputUrl: string | null;
      chapters: { chapterIndex: number; jobId: number; status: string; outputUrl: string | null; storyDescription: string | null }[];
    },
    activeIndex: number | null
  ) {
    const active = activeIndex ?? project.chapters.length;
    setStoryMultiChapter(true);
    setStoryProjectId(project.id);
    setStoryActiveChapter(active);
    setStoryProjectChapters(
      project.chapters
        .filter((c) => c.chapterIndex !== active && c.status === "done" && c.outputUrl)
        .map((c) => ({ chapterIndex: c.chapterIndex, jobId: c.jobId, outputUrl: c.outputUrl as string, title: (c.storyDescription ?? "").slice(0, 80) }))
    );
    if (active > 0 && project.aspectRatio) {
      setStoryLockedAspectRatio(project.aspectRatio);
      setStoryAspectRatio(project.aspectRatio);
    }
    if (project.status === "done" && project.finalOutputUrl) setStoryProjectFinalUrl(project.finalOutputUrl);
  }

  async function handleRunStoryVideo() {
    const images = storyCharacterImages;
    const reuseId = storySelectedSavedCharacterId;
    // Bước này thường chỉ tạo Character, chưa cần Ý tưởng truyện — thứ đó bắt buộc ở bước "Tiếp tục
    // chia cảnh" sau. NGOẠI LỆ: khi dùng Character đã lưu từ thư viện (biết chắc 100%, không cần AI
    // kiểm tra lại), server sẽ chạy thẳng 1 lượt luôn tới chia cảnh nếu đã có Ý tưởng truyện — nên bắt
    // buộc nhập trước ở đây để chắc chắn kích hoạt được đường tắt đó (ảnh thường vẫn không cần, vì
    // server không biết trước có phải toàn bộ ảnh đã là sheet hay không).
    const hasMultipleCharacters = storyExtraCharacters.length > 0;
    // Chế độ "Mô tả bằng chữ" — không có ảnh, AI tự vẽ từ mô tả này (xem storyCharacterInputMode). Mỗi
    // nhân vật (kể cả #2+ bên dưới) độc lập chọn ảnh thật hoặc mô tả chữ.
    const usesAppearanceDescription = storyCharacterInputMode === "text" && !!storyCharacterAppearanceDescription.trim();
    if (!user || (!reuseId && !usesAppearanceDescription && images.length === 0) || !storyImageModelKey || !storyVideoModelKey) return;
    if (reuseId && !input.trim()) return;
    if (storyMultiChapter && storyProjectId === null) {
      setStoryError("Chưa tạo được dự án nhiều chương — bỏ tick rồi tick lại ô \"Video nhiều chương\"");
      return;
    }
    if (
      hasMultipleCharacters &&
      storyExtraCharacters.some(
        (s) => !s.reuseId && s.images.length === 0 && !(s.inputMode === "text" && s.appearanceDescription.trim())
      )
    ) {
      setStoryError("Có nhân vật chưa tải ảnh — xoá bớt hoặc tải ảnh cho đủ trước khi chạy");
      return;
    }
    // Luồng mặc định (1 nhân vật, AI tự vẽ ảnh, KHÔNG own-images) bắt buộc phải có kịch bản đã xác nhận
    // trước — đảm bảo giá hiện lúc "Tạo kịch bản" luôn khớp với giá thật lúc submit (không chia cảnh
    // ngầm bằng số cảnh cũ/mặc định nếu khách quên bấm nút). Own-images/nhiều nhân vật/chuyển động liên
    // tục/frame-chain không dùng bước kịch bản này (xem storyUsesScriptFlow).
    // 2 điều kiện TÁCH RIÊNG (trước đây gộp chung "input.trim() && !storyScriptActions" — khi ô Ý tưởng
    // truyện đang trống, cả cụm bị bỏ qua hoàn toàn vì short-circuit, cho lọt request preplannedActions=
    // null lên server và bị 400 "Danh sách hành động không hợp lệ"; xảy ra thật ở chế độ "AI tự vẽ" nhân
    // vật vì khách có thể điền xong mô tả nhân vật mà quên/chưa kịp viết Ý tưởng truyện).
    if (storyUsesScriptFlow && !input.trim()) {
      setStoryError("Nhập Ý tưởng truyện trước khi tạo ảnh phân cảnh");
      return;
    }
    if (storyUsesScriptFlow && (!storyScriptActions || storyScriptActions.length === 0)) {
      setStoryError('Bấm "Tạo kịch bản" trước khi tạo ảnh phân cảnh');
      return;
    }
    // Nếu khách bấm chạy ngay sau khi rời ô truyện, lượt gợi ý số cảnh (chạy nền từ onBlur) có thể
    // chưa kịp xong — tự đợi nốt ở đây, dùng biến cục bộ (không đọc numScenes từ state, tránh đọc
    // trúng giá trị cũ do setState là bất đồng bộ) để đảm bảo submit đúng số cảnh AI vừa tính. CHỈ áp
    // dụng luồng CHƯA nối kiến trúc "Tạo kịch bản" mới — luồng mặc định lấy thẳng số cảnh từ
    // storyScriptActions.length (đã set numScenes lúc "Tạo kịch bản" xong).
    let resolvedNumScenes = numScenes;
    if (!sceneCountChosen && !storyUseOwnSceneImages && !storyUsesScriptFlow && input.trim()) {
      const suggested = await fetchSuggestedSceneCount();
      if (suggested !== null) {
        resolvedNumScenes = suggested;
        setNumScenes(suggested);
        setSceneCountChosen(true);
      }
    }
    setStoryActiveButton("images");
    setStoryRunning(true);
    setStoryResult(null);
    setStoryError(null);
    setStoryScenes(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStorySavedCharacterMsg(null);

    let characterImageUrls: string[] = [];
    let primaryItemReferenceUrls: string[] = [];
    let characters:
      | {
          imageUrls: string[];
          reuseCharacterId?: number;
          skipCharacterCreation?: boolean;
          label?: string;
          itemReferenceUrls?: string[];
          appearanceDescription?: string;
        }[]
      | undefined;
    let locationReferenceUrl: string | undefined;
    let locationReferenceMaskUrl: string | undefined;
    if (!reuseId || storyPrimaryItemReferences.length > 0 || hasMultipleCharacters || storyLocationReference) {
      setStoryStatusText("Đang tải ảnh lên...");
      try {
        // Gộp TẤT CẢ lượt tải ảnh (nhân vật #1, vật phẩm #1, từng nhân vật phụ, địa điểm) vào 1 lượt
        // Promise.all duy nhất thay vì 4 khối await tuần tự như trước — mỗi khối trước đây chờ khối
        // trước xong mới bắt đầu dù hoàn toàn độc lập với nhau, cộng dồn thời gian chờ (vd 4 khối x
        // ~2-3s = 8-12s+), khiến khách cảm thấy "tải ảnh lâu". Giờ chạy song song, tổng thời gian chỉ
        // còn bằng khối chậm nhất thay vì tổng cả 4 khối.
        const [characterImageUrlsResult, primaryItemReferenceUrlsResult, extraUploaded, locationReferenceUrlResult, locationReferenceMaskUrlResult] =
          await Promise.all([
          // Ảnh đã có URL thật (vd job dở dang được khôi phục) thì dùng thẳng, chỉ upload ảnh base64 mới.
          !reuseId
            ? Promise.all(images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))))
            : Promise.resolve<string[]>([]),
          storyPrimaryItemReferences.length > 0
            ? Promise.all(storyPrimaryItemReferences.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))))
            : Promise.resolve<string[]>([]),
          // Job nhiều nhân vật — tải ảnh của từng nhân vật phụ (#2, #3, #4), gộp cùng nhân vật #1 thành
          // mảng "characters" gửi server. Mỗi nhân vật tự tải ảnh + vật phẩm SONG SONG (không tuần tự).
          hasMultipleCharacters
            ? Promise.all(
                storyExtraCharacters.map(async (slot) => {
                  const [slotImages, slotItemImages] = await Promise.all([
                    slot.reuseId
                      ? Promise.resolve<string[]>([])
                      : Promise.all(slot.images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))),
                    Promise.all(slot.itemImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))),
                  ]);
                  return {
                    imageUrls: slotImages,
                    reuseCharacterId: slot.reuseId ?? undefined,
                    label: slot.label.trim() || undefined,
                    itemReferenceUrls: slotItemImages,
                    appearanceDescription:
                      !slot.reuseId && slot.inputMode === "text" ? slot.appearanceDescription.trim() || undefined : undefined,
                  };
                })
              )
            : Promise.resolve(undefined),
          // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — tải lên nếu là ảnh mới (base64),
          // dùng thẳng nếu đã là URL thật (job khôi phục dở dang).
          storyLocationReference
            ? storyLocationReference.startsWith("http")
              ? Promise.resolve(storyLocationReference)
              : uploadOutfitSwapImage(storyLocationReference)
            : Promise.resolve(undefined),
          // Vị trí đứng chính xác (mask đen/trắng, xem storyLocationReferenceMaskUrl) — mirror đúng cách
          // tải ảnh Bối cảnh ở trên: dùng thẳng nếu đã là URL thật (job khôi phục dở dang), tải lên nếu
          // là data URL PNG vừa sinh ra ở trình duyệt.
          storyLocationReferenceMaskUrl
            ? storyLocationReferenceMaskUrl.startsWith("http")
              ? Promise.resolve(storyLocationReferenceMaskUrl)
              : uploadOutfitSwapImage(storyLocationReferenceMaskUrl)
            : Promise.resolve(undefined),
        ]);
        characterImageUrls = characterImageUrlsResult;
        primaryItemReferenceUrls = primaryItemReferenceUrlsResult;
        if (hasMultipleCharacters && extraUploaded) {
          characters = [
            {
              imageUrls: reuseId ? [] : characterImageUrls,
              reuseCharacterId: reuseId ?? undefined,
              skipCharacterCreation: !reuseId && storySkipCharacterCreation,
              label: storyPrimaryCharacterLabel.trim() || undefined,
              itemReferenceUrls: primaryItemReferenceUrls,
              appearanceDescription: usesAppearanceDescription ? storyCharacterAppearanceDescription.trim() : undefined,
            },
            ...extraUploaded,
          ];
        }
        locationReferenceUrl = locationReferenceUrlResult;
        locationReferenceMaskUrl = locationReferenceMaskUrlResult;
      } catch (err) {
        setStoryError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }
    }

    setStoryStatusText(reuseId ? "Đang chuẩn bị Character đã lưu..." : "AI đang kiểm tra ảnh nhân vật...");

    try {
      const res = await fetch("/api/story-video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          storyDescription: input.trim(),
          numScenes: resolvedNumScenes,
          characterImageUrls,
          imageModelKey: storyImageModelKey,
          videoModelKey: storyVideoModelKey,
          autoVideo: storyAutoVideo,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
          // Luồng dùng bước "Tạo kịch bản" đã khoá thời lượng riêng từng cảnh qua preplannedActions —
          // bỏ qua dropdown phẳng cũ (đã ẩn khỏi UI cho đúng luồng này). Own-images/nhiều nhân vật/
          // chuyển động liên tục/frame-chain vẫn gửi bình thường (chưa nối kiến trúc kịch bản mới).
          durationKey: storyUsesScriptFlow ? undefined : storyDurationKey,
          modelChatKey: storyModelChatKey,
          reuseCharacterId: reuseId ?? undefined,
          skipCharacterCreation: !reuseId && storySkipCharacterCreation,
          genreKey: storyGenreKey !== "default" ? storyGenreKey : undefined,
          characters,
          locationReferenceUrl,
          locationReferenceMaskUrl,
          // Nhiều nhân vật, nhiều vị trí — chỉ có ý nghĩa khi job nhiều nhân vật (server tự bỏ qua khi
          // không phải nhánh đó). Dữ liệu thuần toạ độ, không cần upload — gửi thẳng trong JSON.
          locationReferenceMaskZones:
            hasMultipleCharacters && storyLocationMaskAssignments.length > 0
              ? storyLocationMaskAssignments.map((a) => ({
                  position: a.characterPosition,
                  xPct: a.rect.x,
                  yPct: a.rect.y,
                  wPct: a.rect.w,
                  hPct: a.rect.h,
                }))
              : undefined,
          itemReferenceUrls: primaryItemReferenceUrls,
          continuousMotion: storyContinuousMotion,
          frameChainMode: storyFrameChainMode,
          preplannedActions: storyUsesScriptFlow && !hasMultipleCharacters ? storyScriptActions : undefined,
          preplannedActionsMulti: storyUsesScriptFlow && hasMultipleCharacters ? storyScriptActions : undefined,
          characterAppearanceDescription: usesAppearanceDescription ? storyCharacterAppearanceDescription.trim() : undefined,
          projectId: storyMultiChapter ? (storyProjectId ?? undefined) : undefined,
          chapterIndex: storyMultiChapter ? storyActiveChapter : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setStoryJobId(data.jobId);
      setStoryStatusText("Đang xử lý ảnh Character...");
      pollStoryVideoStatus(data.jobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRunning(false);
      setStoryStatusText(null);
    }
  }

  // Khách đã có sẵn ảnh cho từng phân cảnh — bỏ qua hoàn toàn bước Character + AI tạo ảnh, chỉ tốn
  // credit video. Agent tự viết mô tả chuyển động cho từng ảnh (gợi ý của khách chỉ là hỗ trợ thêm).
  async function handleRunStoryVideoWithOwnImages(forceAutoVideo?: boolean) {
    if (!user || !input.trim() || !storyVideoModelKey || storySceneImages.length < STORY_MIN_SCENES) return;
    if (storyMultiChapter && storyProjectId === null) {
      setStoryError("Chưa tạo được dự án nhiều chương — bỏ tick rồi tick lại ô \"Video nhiều chương\"");
      return;
    }
    setStoryActiveButton("video");
    setStoryRunning(true);
    setStoryResult(null);
    setStoryError(null);
    setStoryScenes(null);
    setStoryStatus(null);
    setStoryJobId(null);
    setStoryCharacterSheetUrl(null);
    setStoryCharacterSource(null);
    setStorySavedCharacterMsg(null);

    setStoryStatusText("Đang tải ảnh phân cảnh lên...");
    let sceneImageUrls: string[];
    try {
      // Ảnh đã là URL thật (vd đồng bộ từ 1 job trước qua storyScenes) thì dùng thẳng, không tải lại —
      // uploadOutfitSwapImage chỉ nhận đúng ảnh còn ở dạng base64 mới từ máy (chưa có URL thật).
      sceneImageUrls = await Promise.all(storySceneImages.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))));
    } catch (err) {
      setStoryError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setStoryRunning(false);
      setStoryStatusText(null);
      return;
    }

    setStoryStatusText("Agent đang viết mô tả chuyển động cho từng ảnh...");

    try {
      const res = await fetch("/api/story-video/submit-own-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          storyDescription: input.trim(),
          sceneImages: sceneImageUrls.map((imageUrl, i) => ({ imageUrl, hint: storySceneHints[i]?.trim() || undefined })),
          videoModelKey: storyVideoModelKey,
          autoVideo: forceAutoVideo ?? storyAutoVideo,
          aspectRatio: storyAspectRatio,
          durationKey: storyDurationKey,
          modelChatKey: storyModelChatKey,
          projectId: storyMultiChapter ? (storyProjectId ?? undefined) : undefined,
          chapterIndex: storyMultiChapter ? storyActiveChapter : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setStoryError(data.error ?? "Có lỗi xảy ra");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setStoryJobId(data.jobId);
      setStoryStatusText("Agent đang viết mô tả chuyển động cho từng ảnh...");
      pollStoryVideoStatus(data.jobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryRunning(false);
      setStoryStatusText(null);
    }
  }
  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex items-center justify-between px-6 py-4 max-w-[1600px]">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              ← Quay lại Danh mục
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto px-6 max-w-[1600px] pt-4 pb-24">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{app.name}</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleShareResult}
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {shareCopied ? "Đã sao chép liên kết!" : "🔗 Chia sẻ"}
            </button>
            <button
              onClick={() =>
                window.open(
                  `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`,
                  "_blank",
                  "noopener,noreferrer,width=600,height=500"
                )
              }
              title="Chia sẻ lên Facebook"
              className="rounded-full border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Facebook
            </button>
          </div>
        </div>

        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 story-video-theme">
          <div>
          <div>
            <div className="mb-4">
              {/* Hàng 1: Ý tưởng truyện */}
              <div ref={storyFormTopRef}>
                <p className="mb-1 text-base font-medium text-zinc-500 dark:text-zinc-400">Ý tưởng truyện</p>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onBlur={() => {
                    // Tự gợi ý số cảnh ngay khi khách gõ xong (click ra khỏi ô) — CHỈ còn dùng cho luồng
                    // chưa nối kiến trúc "Tạo kịch bản" mới (nhiều nhân vật/chuyển động liên tục/frame-chain).
                    // Luồng mặc định dùng nút "Tạo kịch bản" riêng bên dưới thay cho auto-suggest này.
                    if (!storyUseOwnSceneImages && !storyUsesScriptFlow && input.trim() && !suggestingScenes) {
                      handleSuggestSceneCount();
                    }
                  }}
                  placeholder="Mô tả mạch truyện, bối cảnh — AI sẽ chia thành phân cảnh"
                  rows={8}
                  maxLength={2000}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                />

                <label className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    checked={storyMultiChapter}
                    disabled={storyProjectChapters.length > 0}
                    onChange={(e) => handleToggleMultiChapter(e.target.checked)}
                  />
                  📚 Video nhiều chương — mỗi chương là 1 đoạn video ngắn (ý tưởng, ảnh nhân vật, bối cảnh riêng), cuối cùng ghép các chương lại
                </label>
                {storyProjectError && <p className="mt-1 text-xs text-red-500">{storyProjectError}</p>}
                {storyMultiChapter && (
                  <div className="mt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {storyProjectChapters.map((c) => (
                        <button
                          key={c.chapterIndex}
                          type="button"
                          onClick={() => setStoryViewChapter((v) => (v === c.chapterIndex ? null : c.chapterIndex))}
                          title={c.title}
                          className={`rounded-full border px-3 py-1 text-sm font-medium ${
                            storyViewChapter === c.chapterIndex
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-emerald-600 text-emerald-700 dark:text-emerald-400"
                          }`}
                        >
                          ✓ Chương {c.chapterIndex + 1}
                        </button>
                      ))}
                      <span className="rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 text-sm font-semibold text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900">
                        Chương {storyActiveChapter + 1}
                      </span>
                      {storyProjectChapters.length + (storyResult ? 1 : 0) > 0 && !storyProjectFinalUrl && (
                        <button
                          type="button"
                          onClick={handleFinishProject}
                          disabled={storyRunning || storyProjectFinalizing}
                          title="Ghép video các chương đã xong thành video cuối (chương đang soạn dở/chưa xong sẽ không được ghép)"
                          className="ml-auto rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          {storyProjectFinalizing ? "Đang ghép..." : "🏁 Kết thúc"}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                      Toàn bộ các ô bên dưới thuộc Chương {storyActiveChapter + 1} (tối đa {STORY_MAX_CHAPTERS} chương).
                      {storyLockedAspectRatio ? ` Tỉ lệ khung hình khoá theo chương 1: ${storyLockedAspectRatio}.` : ""}
                    </p>
                    {/* Chọn kiểu chuyển cảnh RIÊNG TỪNG điểm nối giữa 2 chương liên tiếp (phản hồi thật:
                        khách muốn Chương 1→2 hoà mờ nhưng Chương 2→3 cắt cứng — không thể dùng 1 công tắc
                        chung cho cả dự án). Chỉ hiện khi đã có từ 2 chương trở lên (đủ ít nhất 1 điểm nối).
                        Đặt ở đây (ngay dưới hàng chip chương) vì cả 2 nút "🏁 Kết thúc" trong trang (ở đây
                        và ở khối kết quả chương hiện tại bên dưới) đều gọi chung handleFinishProject — đặt
                        1 chỗ duy nhất, áp dụng chung cho cả 2 lối vào. */}
                    {storyProjectChapters.length + (storyResult ? 1 : 0) >= 2 && !storyProjectFinalUrl && (
                      <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Kiểu chuyển cảnh giữa các chương:</p>
                        {Array.from({ length: storyProjectChapters.length + (storyResult ? 1 : 0) - 1 }, (_, i) => {
                          const current = storyChapterTransitions[i] ?? "cut";
                          return (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <span className="text-zinc-600 dark:text-zinc-400">
                                Chương {i + 1} → Chương {i + 2}:
                              </span>
                              <div className="inline-flex overflow-hidden rounded-full border border-zinc-300 dark:border-zinc-600">
                                {(["cut", "crossfade"] as const).map((opt) => (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() =>
                                      setStoryChapterTransitions((prev) => {
                                        const next = [...prev];
                                        next[i] = opt;
                                        return next;
                                      })
                                    }
                                    className={`px-2.5 py-1 text-xs font-medium ${
                                      current === opt
                                        ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                        : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                    }`}
                                  >
                                    {opt === "cut" ? "Cắt cứng" : "Hoà mờ"}
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {storyViewChapter !== null &&
                      (() => {
                        const c = storyProjectChapters.find((x) => x.chapterIndex === storyViewChapter);
                        return c ? (
                          <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                            <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Chương {c.chapterIndex + 1}: {c.title}
                            </p>
                            <video src={c.outputUrl} controls className="w-full max-w-xs rounded-lg" />
                          </div>
                        ) : null;
                      })()}
                  </div>
                )}

                {storyUseOwnSceneImages ? (
                  <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                    Số phân cảnh: <strong className="text-zinc-900 dark:text-zinc-50">{storySceneImages.length || "0"}</strong> (theo đúng số ảnh đã tải ở khung "Ảnh phân cảnh" phía dưới)
                  </p>
                ) : !storyUsesScriptFlow ? (
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Số phân cảnh</p>
                      {suggestingScenes && <p className="text-xs text-zinc-400 dark:text-zinc-500">Đang tính...</p>}
                    </div>
                    {sceneSuggestError && <p className="mb-1 text-xs text-red-500">{sceneSuggestError}</p>}
                    <div className="flex flex-wrap gap-2">
                      {Array.from({ length: STORY_MAX_SCENES - STORY_MIN_SCENES + 1 }, (_, i) => STORY_MIN_SCENES + i).map((n) => (
                        <button
                          key={n}
                          onClick={() => {
                            setNumScenes(n);
                            setSceneCountChosen(true);
                          }}
                          className={`rounded-full border px-4 py-1.5 text-sm font-medium ${
                            sceneCountChosen && numScenes === n
                              ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                              : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          }`}
                        >
                          {n} cảnh
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={handleCreateScript}
                      disabled={storyScriptLoading || !input.trim() || !storyVideoModelKey}
                      className="rounded-full border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyScriptLoading ? "Đang tạo kịch bản..." : "📝 Tạo kịch bản"}
                    </button>
                    {!storyVideoModelKey && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">Đang tải danh sách model video...</p>
                    )}
                    {storyScriptError && <p className="mt-1 text-xs text-red-500">{storyScriptError}</p>}
                    {storyScriptActions && storyEnableSpeedSlider && !storySpeedFinalized ? (
                      <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                        <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          Chỉnh tốc độ từng hành động (kéo chậm/nhanh), xong bấm &quot;Hoàn thành&quot; để tính lại số cảnh và giá.
                        </p>
                        <div className="space-y-3">
                          {storyScriptActions.map((a, i) => {
                            const selectedVideoModel = storyVideoModels.find((m) => m.key === storyVideoModelKey);
                            const maxSeconds = selectedVideoModel?.duration_price_vnd
                              ? Math.max(...Object.keys(selectedVideoModel.duration_price_vnd).map(Number))
                              : 15;
                            const value = storySpeedDrafts[i] ?? a.duration_seconds;
                            return (
                              <div key={i} className="rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                                    {a.description.length > 70 ? `${a.description.slice(0, 70)}…` : a.description}
                                  </span>
                                  <span className="shrink-0 text-xs font-medium text-zinc-900 dark:text-zinc-50">{value.toFixed(1)}s</span>
                                </div>
                                <input
                                  type="range"
                                  min={1}
                                  max={maxSeconds}
                                  step="any"
                                  value={value}
                                  onChange={(e) =>
                                    setStorySpeedDrafts((prev) => ({ ...prev, [i]: Math.round(Number(e.target.value) * 10) / 10 }))
                                  }
                                  className="w-full"
                                />
                                <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">Agent gợi ý: {a.duration_seconds.toFixed(1)}s</p>
                              </div>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={handleFinalizeSpeed}
                          disabled={storySpeedLoading}
                          className="mt-3 rounded-full border border-zinc-900 bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                        >
                          {storySpeedLoading ? "Đang tính lại..." : "✅ Hoàn thành chỉnh tốc độ"}
                        </button>
                      </div>
                    ) : (
                      storyScriptScenes && (
                        <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                          <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            {storyScriptScenes.length} cảnh · ~{storyScriptTotalSeconds?.toFixed(1)}s · ~{storyScriptVideoCreditCost} credit video
                          </p>
                          <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                            {storyScriptScenes.map((s, i) => {
                              const characterLabels = [
                                storyPrimaryCharacterLabel.trim() || "Nhân vật 1",
                                ...storyExtraCharacters.map((c, ci) => c.label.trim() || `Nhân vật ${ci + 2}`),
                              ];
                              const dialogueLine =
                                typeof s.dialogue === "string"
                                  ? s.dialogue
                                  : s.dialogue
                                    ? `${characterLabels[s.dialogue.speaker] ?? "?"}: "${s.dialogue.line}"`
                                    : null;
                              return (
                                <li key={i}>
                                  <strong>Cảnh {i + 1}</strong> {s.duration_key ? `(${s.duration_key}s)` : ""}: {s.description.length > 90 ? `${s.description.slice(0, 90)}…` : s.description}
                                  {dialogueLine && <div className="mt-0.5 text-emerald-600 dark:text-emerald-400">💬 {dialogueLine}</div>}
                                </li>
                              );
                            })}
                          </ul>
                          <p className="mb-1 mt-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            🧍 Xem trước bố cục (mannequin 3D, không phải ảnh thật) — kéo chuột để xoay xem góc khác, chưa cần tạo ảnh nhân vật/tốn credit gì cả
                          </p>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {storyScriptScenes.map((s, i) => (
                              <div key={i} className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                                <div className="relative">
                                  <MannequinPreviewCard
                                    locationUrl={storyLocationReference}
                                    boxStyle={computeMannequinBoxStyle(s.shot_size ?? null, storyLocationMaskAssignments[0]?.rect ?? storyLocationMaskRect ?? null)}
                                    cameraAngle={s.camera_angle ?? null}
                                    cameraView={s.camera_view ?? "front"}
                                    onCameraViewChange={(view) => handleScriptCameraViewChange(i, view)}
                                  />
                                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">Cảnh {i + 1}</span>
                                </div>
                                <div className="flex flex-wrap gap-1 p-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                  {s.shot_size && (
                                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                                      {SCENE_PREVIEW_SHOT_SIZE_LABEL[s.shot_size] ?? s.shot_size}
                                    </span>
                                  )}
                                  {s.camera_angle && (
                                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                                      {SCENE_PREVIEW_CAMERA_ANGLE_LABEL[s.camera_angle] ?? s.camera_angle}
                                    </span>
                                  )}
                                  {s.camera_view && (
                                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                                      {SCENE_PREVIEW_CAMERA_VIEW_LABEL[s.camera_view] ?? s.camera_view}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1 border-t border-zinc-100 p-1.5 dark:border-zinc-800">
                                  <button
                                    type="button"
                                    onClick={() => setActivePresetModal({ stage: "script", key: i, type: "light" })}
                                    className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                                  >
                                    💡 {SCENE_PREVIEW_LIGHT_DIRECTION_LABEL[(s.light_direction as (typeof LIGHT_DIRECTION_OPTIONS)[number]) ?? "front_lighting"]}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setActivePresetModal({ stage: "script", key: i, type: "gear" })}
                                    className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                                  >
                                    🎥 {SCENE_PREVIEW_CAMERA_BODY_LABEL[(s.camera_body as (typeof CAMERA_BODY_OPTIONS)[number]) ?? "modern"]} ·{" "}
                                    {SCENE_PREVIEW_LENS_LABEL[(s.lens as (typeof LENS_OPTIONS)[number]) ?? "clean_sharp"]} ·{" "}
                                    {SCENE_PREVIEW_APERTURE_LABEL[(s.aperture as (typeof APERTURE_OPTIONS)[number]) ?? "moderate"]}
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}

                <label className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <input type="checkbox" checked={storyAutoVideo} onChange={(e) => setStoryAutoVideo(e.target.checked)} />
                  Tự động tạo video luôn (gộp 1 lượt) — mặc định tắt: chỉ tạo ảnh trước, xem ưng ý mới tạo video
                </label>
              </div>

              {/* Hàng 4: Ảnh nhân vật (full width) */}
              <div ref={storyCharacterCardRef} className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">📷 Ảnh nhân vật</p>

                      <input
                        type="text"
                        value={storyPrimaryCharacterLabel}
                        onChange={(e) => setStoryPrimaryCharacterLabel(e.target.value)}
                        placeholder={
                          storyExtraCharacters.length > 0
                            ? 'Tên nhân vật này (vd "Lan") — dùng đúng tên này trong Ý tưởng truyện để Agent gán đúng người'
                            : 'Tên nhân vật (không bắt buộc) — giúp Agent viết kịch bản không tự bịa ngoại hình, để trống thì mặc định "Nhân vật 1"'
                        }
                        className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />

                      {/* Chế độ "Mô tả bằng chữ" — khách không có ảnh thật, để AI tự vẽ hẳn nhân vật từ mô
                          tả. Mỗi nhân vật (kể cả #2+ bên dưới) chọn độc lập ảnh thật HOẶC mô tả chữ. */}
                      <div className="mb-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => setStoryCharacterInputMode("photo")}
                          className={`rounded-full border px-3 py-1 text-sm font-medium ${
                            storyCharacterInputMode === "photo"
                              ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                              : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          }`}
                        >
                          📷 Tải ảnh thật
                        </button>
                        <button
                          type="button"
                          onClick={() => setStoryCharacterInputMode("text")}
                          className={`rounded-full border px-3 py-1 text-sm font-medium ${
                            storyCharacterInputMode === "text"
                              ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                              : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          }`}
                        >
                          ✍️ Mô tả bằng chữ (AI tự vẽ)
                        </button>
                      </div>

                      {storyCharacterInputMode === "text" ? (
                        <div>
                          <textarea
                            value={storyCharacterAppearanceDescription}
                            onChange={(e) => setStoryCharacterAppearanceDescription(e.target.value)}
                            placeholder='Mô tả ngoại hình nhân vật để AI tự vẽ (vd "phụ nữ Việt Nam khoảng 25 tuổi, tóc dài đen, dáng người mảnh, mặc áo sơ mi trắng") — không có ảnh thật, AI sẽ bịa 1 nhân vật khớp mô tả này'
                            rows={4}
                            maxLength={500}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                          />
                          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                            AI sẽ tự vẽ 1 nhân vật khớp mô tả (không phải người thật) rồi dùng giữ đúng nhân vật đó xuyên
                            suốt các cảnh — giống hệt cách hoạt động của ảnh tải lên.
                          </p>
                        </div>
                      ) : (
                        <>
                      {storySavedCharacters.length > 0 && (
                        <div className="mb-3">
                          <p className="mb-1 text-sm text-zinc-500 dark:text-zinc-400">📂 Character đã lưu</p>
                          <div className="flex flex-wrap gap-2">
                            {storySavedCharacters.map((c) => (
                              <div key={c.id} className="relative h-14 w-14">
                                <button
                                  onClick={() => {
                                    const wasSelected = storySelectedSavedCharacterId === c.id;
                                    setStorySelectedSavedCharacterId(wasSelected ? null : c.id);
                                    setStoryQuickZoomUrl(wasSelected ? null : c.imageUrl);
                                  }}
                                  className={`h-14 w-14 cursor-zoom-in overflow-hidden rounded-lg border-2 ${
                                    storySelectedSavedCharacterId === c.id ? "border-zinc-900 dark:border-zinc-50" : "border-transparent"
                                  }`}
                                  title={`${c.label ?? `Character #${c.id}`} — bấm để chọn + xem to`}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={c.imageUrl} alt={c.label ?? `Character #${c.id}`} className="h-full w-full object-cover" />
                                </button>
                                <button
                                  onClick={() => handleDeleteSavedCharacter(c.id)}
                                  title="Xoá Character này"
                                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] font-medium text-white hover:bg-black/90"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {storySelectedSavedCharacterId ? (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-zinc-600 dark:text-zinc-400">Đã chọn Character đã lưu — bỏ qua tải ảnh mới</span>
                            <div className="flex items-center gap-2">
                              {(() => {
                                const selected = storySavedCharacters.find((c) => c.id === storySelectedSavedCharacterId);
                                return selected ? (
                                  <>
                                    <button
                                      onClick={() => setStoryQuickZoomUrl(selected.imageUrl)}
                                      className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300"
                                    >
                                      Xem to
                                    </button>
                                    <a
                                      href={`/api/download?url=${encodeURIComponent(selected.imageUrl)}&filename=character-sheet.png`}
                                      download
                                      className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300"
                                    >
                                      Tải xuống
                                    </a>
                                  </>
                                ) : null;
                              })()}
                              <button
                                onClick={() => {
                                  setStorySelectedSavedCharacterId(null);
                                  setStoryQuickZoomUrl(null);
                                }}
                                className="text-sm font-medium text-zinc-700 underline dark:text-zinc-300"
                              >
                                Bỏ chọn
                              </button>
                              <button
                                onClick={() => {
                                  if (storySelectedSavedCharacterId) handleDeleteSavedCharacter(storySelectedSavedCharacterId);
                                  setStoryQuickZoomUrl(null);
                                }}
                                className="text-sm font-medium text-red-600 underline dark:text-red-400"
                              >
                                Xoá
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-4 gap-3">
                            {storyCharacterImages.map((img, index) => (
                              <div key={index} className="relative w-full" style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={img}
                                  alt={`Ảnh nhân vật ${index + 1}`}
                                  onClick={() => setStoryQuickZoomUrl(img)}
                                  className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                                  title="Bấm để xem to"
                                />
                                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">Ảnh {index + 1}</span>
                                <button
                                  onClick={() => {
                                    setStoryCharacterImages((prev) => prev.filter((_, i) => i !== index));
                                    setStoryImageCheckResult(null);
                                    if (storyQuickZoomUrl === img) setStoryQuickZoomUrl(null);
                                  }}
                                  className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                            <label
                              className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                              style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}
                            >
                              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (!file) return;
                                  compressImageFile(file).then((dataUrl) => {
                                    setStoryCharacterImages((prev) => [...prev, dataUrl]);
                                    setStoryImageCheckResult(null);
                                  });
                                }}
                              />
                            </label>
                          </div>
                          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                            AI sẽ tự tạo 1 ảnh Character (nhiều góc) từ ảnh anh/chị tải lên, dùng giữ đúng nhân vật xuyên suốt các cảnh
                          </p>
                          <label className="mt-2 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                            <input
                              type="checkbox"
                              checked={storySkipCharacterCreation}
                              onChange={(e) => setStorySkipCharacterCreation(e.target.checked)}
                              className="mt-0.5"
                            />
                            <span>
                              Bỏ qua tạo Character, dùng thẳng ảnh đã tải (tiết kiệm ~{storyCharacterCost ?? 18} credit, nhưng có
                              thể kém đồng nhất khi đổi góc quay)
                            </span>
                          </label>
                          {storyCharacterImages.length > 0 && !storySkipCharacterCreation && (
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                onClick={handleCheckCharacterImage}
                                disabled={storyCheckingImage}
                                className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                              >
                                {storyCheckingImage ? "Đang kiểm tra..." : "🔍 Kiểm tra ảnh"}
                              </button>
                              {storyImageCheckResult === "sheet" && (
                                <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                                  ✅ Toàn bộ ảnh đã là Character nhiều góc — sẽ không tốn credit tạo mới
                                  <button
                                    onClick={() => setStoryImageCheckResult(null)}
                                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                                  >
                                    ✕
                                  </button>
                                </span>
                              )}
                              {storyImageCheckResult === "photo" && (
                                <span className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                                  📷 Có ảnh thường lẫn vào — sẽ tự tạo Character mới (tốn {storyCharacterCost ?? "?"} credit)
                                  <button
                                    onClick={() => setStoryImageCheckResult(null)}
                                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                                  >
                                    ✕
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      )}
                        </>
                      )}

                      {/* Vật phẩm riêng của nhân vật #1 (tuỳ chọn) — mirror khối tương tự ở mỗi card
                          nhân vật #2+ phía dưới, độc lập với ảnh mặt/thân, đặt ngay dưới ảnh nhân vật #1
                          để không bị hiểu nhầm là thiếu. */}
                      <div className="mt-3">
                        <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                          👟 Vật phẩm riêng (tuỳ chọn, tối đa {STORY_MAX_ITEM_REFERENCES}, vd đôi giày, túi xách...)
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {storyPrimaryItemReferences.map((img, imgIndex) => (
                            <div key={imgIndex} className="relative w-24" style={{ aspectRatio: "1 / 1" }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={img}
                                alt={`Vật phẩm ${imgIndex + 1} nhân vật 1`}
                                onClick={() => setStoryQuickZoomUrl(img)}
                                className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                                title="Bấm để xem to"
                              />
                              <button
                                onClick={() =>
                                  setStoryPrimaryItemReferences((prev) => prev.filter((_, j) => j !== imgIndex))
                                }
                                className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          {storyPrimaryItemReferences.length < STORY_MAX_ITEM_REFERENCES && (
                            <label
                              className="flex w-24 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                              style={{ aspectRatio: "1 / 1" }}
                            >
                              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (!file) return;
                                  compressImageFile(file).then((dataUrl) => setStoryPrimaryItemReferences((prev) => [...prev, dataUrl]));
                                }}
                              />
                            </label>
                          )}
                        </div>
                      </div>

                      {/* Nhân vật #2+ — cùng xuất hiện chung 1 khung hình với nhân vật #1 (vd tuần trăng
                          mật, cầu hôn). Mỗi nhân vật thêm là 1 khối riêng, độc lập với khối chính ở trên. */}
                      {storyExtraCharacters.map((slot, slotIndex) => (
                        <div key={slotIndex} className="mt-4 rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
                          <div className="mb-2 flex items-center gap-2">
                            <input
                              type="text"
                              value={slot.label}
                              onChange={(e) =>
                                setStoryExtraCharacters((prev) =>
                                  prev.map((s, i) => (i === slotIndex ? { ...s, label: e.target.value } : s))
                                )
                              }
                              placeholder={`Tên nhân vật này (vd "Mai") — dùng đúng tên này trong Ý tưởng truyện`}
                              className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                            />
                            <button
                              onClick={() => setStoryExtraCharacters((prev) => prev.filter((_, i) => i !== slotIndex))}
                              className="text-sm font-medium text-red-600 underline dark:text-red-400"
                            >
                              Xoá
                            </button>
                          </div>

                          {storySavedCharacters.length > 0 && (
                            <select
                              value={slot.reuseId ?? ""}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null;
                                setStoryExtraCharacters((prev) =>
                                  prev.map((s, i) => (i === slotIndex ? { ...s, reuseId: val, images: val ? [] : s.images } : s))
                                );
                              }}
                              className="mb-2 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                            >
                              <option value="">— Tải ảnh mới thay vì dùng thư viện —</option>
                              {storySavedCharacters.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label ?? `Character #${c.id}`}
                                </option>
                              ))}
                            </select>
                          )}

                          {!slot.reuseId && (
                            <div className="mb-2 flex gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setStoryExtraCharacters((prev) => prev.map((s, i) => (i === slotIndex ? { ...s, inputMode: "photo" } : s)))
                                }
                                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                                  slot.inputMode === "photo"
                                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                                }`}
                              >
                                📷 Tải ảnh thật
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setStoryExtraCharacters((prev) => prev.map((s, i) => (i === slotIndex ? { ...s, inputMode: "text" } : s)))
                                }
                                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                                  slot.inputMode === "text"
                                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                                }`}
                              >
                                ✍️ Mô tả bằng chữ
                              </button>
                            </div>
                          )}

                          {!slot.reuseId && slot.inputMode === "text" ? (
                            <textarea
                              value={slot.appearanceDescription}
                              onChange={(e) =>
                                setStoryExtraCharacters((prev) =>
                                  prev.map((s, i) => (i === slotIndex ? { ...s, appearanceDescription: e.target.value } : s))
                                )
                              }
                              placeholder='Mô tả ngoại hình nhân vật này để AI tự vẽ (vd "đàn ông khoảng 30 tuổi, tóc ngắn, dáng cao") — không cần ảnh'
                              rows={3}
                              maxLength={500}
                              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                            />
                          ) : (
                          !slot.reuseId && (
                            <div className="grid grid-cols-4 gap-3">
                              {slot.images.map((img, imgIndex) => (
                                <div key={imgIndex} className="relative w-full" style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={img}
                                    alt={`${slot.label || `Nhân vật ${slotIndex + 2}`} ${imgIndex + 1}`}
                                    onClick={() => setStoryQuickZoomUrl(img)}
                                    className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                                    title="Bấm để xem to"
                                  />
                                  <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                                    Ảnh {imgIndex + 1}
                                  </span>
                                  <button
                                    onClick={() =>
                                      setStoryExtraCharacters((prev) =>
                                        prev.map((s, i) => (i === slotIndex ? { ...s, images: s.images.filter((_, j) => j !== imgIndex) } : s))
                                      )
                                    }
                                    className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                              <label
                                className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                                style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}
                              >
                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  className="hidden"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (!file) return;
                                    compressImageFile(file).then((dataUrl) => {
                                      setStoryExtraCharacters((prev) =>
                                        prev.map((s, i) => (i === slotIndex ? { ...s, images: [...s.images, dataUrl] } : s))
                                      );
                                    });
                                  }}
                                />
                              </label>
                            </div>
                          )
                          )}

                          {/* Vật phẩm riêng của nhân vật này (tuỳ chọn, vd đôi giày/túi xách thật) — độc
                              lập với ảnh mặt/thân ở trên, luôn hiện kể cả khi dùng ảnh từ thư viện. */}
                          <div className="mt-3">
                            <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
                              👟 Vật phẩm riêng (tuỳ chọn, tối đa {STORY_MAX_ITEM_REFERENCES}, vd đôi giày, túi xách...)
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {slot.itemImages.map((img, imgIndex) => (
                                <div key={imgIndex} className="relative w-24" style={{ aspectRatio: "1 / 1" }}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={img}
                                    alt={`Vật phẩm ${imgIndex + 1} của ${slot.label || `Nhân vật ${slotIndex + 2}`}`}
                                    onClick={() => setStoryQuickZoomUrl(img)}
                                    className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                                    title="Bấm để xem to"
                                  />
                                  <button
                                    onClick={() =>
                                      setStoryExtraCharacters((prev) =>
                                        prev.map((s, i) =>
                                          i === slotIndex ? { ...s, itemImages: s.itemImages.filter((_, j) => j !== imgIndex) } : s
                                        )
                                      )
                                    }
                                    className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                              {slot.itemImages.length < STORY_MAX_ITEM_REFERENCES && (
                                <label
                                  className="flex w-24 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                                  style={{ aspectRatio: "1 / 1" }}
                                >
                                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      e.target.value = "";
                                      if (!file) return;
                                      compressImageFile(file).then((dataUrl) =>
                                        setStoryExtraCharacters((prev) =>
                                          prev.map((s, i) =>
                                            i === slotIndex ? { ...s, itemImages: [...s.itemImages, dataUrl] } : s
                                          )
                                        )
                                      );
                                    }}
                                  />
                                </label>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}

                      {storyExtraCharacters.length < STORY_MAX_CHARACTERS - 1 && (
                        <button
                          onClick={() =>
                            setStoryExtraCharacters((prev) => [
                              ...prev,
                              { images: [], reuseId: null, label: "", itemImages: [], inputMode: "photo", appearanceDescription: "" },
                            ])
                          }
                          className="mt-3 rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          + Thêm nhân vật (tối đa {STORY_MAX_CHARACTERS} người cùng khung hình)
                        </button>
                      )}
                      {storyExtraCharacters.length > 0 && (
                        <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                          ⚠️ Nhiều nhân vật cùng khung hình — chỉ hoạt động tốt với model ảnh hỗ trợ nhiều ảnh tham chiếu (Nano
                          Banana Pro Edit, GPT Image 2 Edit). App sẽ tự lọc lại dropdown Model ảnh bên dưới.
                        </p>
                      )}
                    </div>

              {/* Hàng 2+3: Model tạo ảnh phân cảnh + Model tạo video + Agent xử lý + Model chat — gộp
                  chung 1 lưới, lên 4 cột ở màn hình rất rộng (2xl) để dùng hết chiều ngang thay vì để
                  trống 2 bên, đặt ngay dưới Ý tưởng truyện/Tạo kịch bản để chọn model trước khi cuộn
                  xuống các khối còn lại. */}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">Model tạo ảnh phân cảnh</p>
                      {storyExtraCharacters.length > 0 && (
                        <p className="mb-2 text-sm text-zinc-400 dark:text-zinc-500">
                          Đang có nhiều nhân vật — chỉ hiện model hỗ trợ nhiều ảnh tham chiếu (ghép nhiều người vào 1 cảnh).
                        </p>
                      )}
                      {storyExtraCharacters.length === 0 && storyPrimaryItemReferences.length > 0 && (
                        <p className="mb-2 text-sm text-zinc-400 dark:text-zinc-500">
                          Đang có ảnh vật phẩm — chỉ hiện model hỗ trợ nhiều ảnh tham chiếu (nếu không, vật phẩm sẽ bị bỏ qua).
                        </p>
                      )}
                      {storyLocationReferenceMaskUrl && (
                        <p className="mb-2 text-sm text-zinc-400 dark:text-zinc-500">
                          Đã chọn vị trí đứng chính xác trong ảnh Bối cảnh — chỉ hiện model hỗ trợ đặt đúng vị trí (GPT Image 2
                          Edit).
                        </p>
                      )}
                      {(() => {
                        const availableImageModels = (storyLocationReferenceMaskUrl
                          ? storyImageModels.filter((m) => m.model === "fal-ai/gpt-image-2/edit")
                          : storyExtraCharacters.length > 0 || storyPrimaryItemReferences.length > 0
                            ? storyImageModels.filter((m) => m.multi_image)
                            : storyImageModels
                        ).filter(modelSupportsLockedRatio);
                        const selected = availableImageModels.find((m) => m.key === storyImageModelKey);
                        return (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model</label>
                              <select
                                value={storyImageModelKey ?? ""}
                                onChange={(e) => {
                                  setStoryImageModelKey(e.target.value);
                                  const m = availableImageModels.find((x) => x.key === e.target.value);
                                  setStoryResolutionKey(m?.resolution_price_vnd ? Object.keys(m.resolution_price_vnd)[0] : null);
                                  if (!storyLockedAspectRatio && m?.aspect_ratios && !m.aspect_ratios.includes(storyAspectRatio)) setStoryAspectRatio(m.aspect_ratios[0]);
                                }}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {Array.from(new Set(availableImageModels.map((m) => m.provider))).map((provider) => (
                                  <optgroup key={provider} label={provider}>
                                    {availableImageModels
                                      .filter((m) => m.provider === provider)
                                      .map((m) => (
                                        <option key={m.key} value={m.key}>
                                          {m.label} — {m.provider_cost_vnd}đ/cảnh
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Tỉ lệ</label>
                              <select
                                value={storyAspectRatio}
                                disabled={!!storyLockedAspectRatio}
                                title={storyLockedAspectRatio ? "Tỉ lệ khung hình khoá theo chương 1 để video cuối đồng nhất" : undefined}
                                onChange={(e) => setStoryAspectRatio(e.target.value)}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {(selected?.aspect_ratios ?? ["9:16", "16:9", "1:1"]).map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selected?.resolution_price_vnd && (
                              <div>
                                <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Độ phân giải</label>
                                <select
                                  value={storyResolutionKey ?? ""}
                                  onChange={(e) => setStoryResolutionKey(e.target.value)}
                                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                >
                                  {Object.entries(selected.resolution_price_vnd).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {k} — {v}đ
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                        {storyUseOwnSceneImages ? (
                          "Không tốn credit ảnh — dùng ảnh khách đã tải lên"
                        ) : (
                          <>
                            Đơn giá đã chọn: <strong className="text-zinc-900 dark:text-zinc-50">{storyImageCost ?? "?"} credit</strong>
                          </>
                        )}
                      </p>
                    </div>

                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🎬 Video phân cảnh</p>
                      {(() => {
                        const selected = storyVideoModels.find((m) => m.key === storyVideoModelKey);
                        return (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model</label>
                              <select
                                value={storyVideoModelKey ?? ""}
                                onChange={(e) => {
                                  setStoryVideoModelKey(e.target.value);
                                  const m = storyVideoModels.find((x) => x.key === e.target.value);
                                  setStoryDurationKey(m?.duration_price_vnd ? Object.keys(m.duration_price_vnd)[0] : null);
                                  // "veo31-lite-flf" bắt buộc cả ảnh đầu lẫn ảnh cuối (API Fal.ai không cho tuỳ chọn như
                                  // Kling O1) - tự bật chuyển động liên tục, không chờ khách tick tay.
                                  if (e.target.value === "veo31-lite-flf") {
                                    setStoryContinuousMotion(true);
                                  } else if (e.target.value !== "kling-o1-flfv") {
                                    // Đổi sang model không hỗ trợ chuyển động liên tục — tắt lại nếu đang bật dở từ
                                    // model trước đó (veo31-lite-flf hoặc tick tay ở kling-o1-flfv), tránh
                                    // storyContinuousMotion bị kẹt true khiến "Tạo kịch bản" bị ẩn nhầm cho tới khi
                                    // tải lại trang.
                                    setStoryContinuousMotion(false);
                                  }
                                }}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {/* "veo31-lite-flf" bắt buộc CẢ ảnh đầu lẫn ảnh cuối (last_frame_url — Fal.ai không cho
                                    tuỳ chọn như Kling O1's end_image_url, thiếu là lỗi 422 ngay). Luồng "khách tự tải
                                    ảnh phân cảnh" (chỉ 1 ảnh/cảnh) VÀ frame-chain (chỉ 1 ảnh đầu thật/cảnh, không có
                                    ảnh cuối) đều không có cơ chế tạo ảnh cuối cho model này — ẩn khỏi danh sách khi
                                    đang bật 1 trong 2 chế độ đó. Kling O1 FLFV KHÔNG cần loại trừ tương tự — ảnh cuối
                                    của nó tuỳ chọn thật (thiếu thì tự chạy như model 1 ảnh bình thường, không lỗi). */}
                                {Array.from(
                                  new Set(
                                    storyVideoModels
                                      .filter((m) => !((storyUseOwnSceneImages || storyFrameChainMode) && m.key === "veo31-lite-flf") && modelSupportsLockedRatio(m))
                                      .map((m) => m.provider)
                                  )
                                ).map((provider) => (
                                  <optgroup key={provider} label={provider}>
                                    {storyVideoModels
                                      .filter(
                                        (m) =>
                                          m.provider === provider &&
                                          !((storyUseOwnSceneImages || storyFrameChainMode) && m.key === "veo31-lite-flf") &&
                                          modelSupportsLockedRatio(m)
                                      )
                                      .map((m) => (
                                        <option key={m.key} value={m.key}>
                                          {m.label} — {m.provider_cost_vnd}đ/cảnh
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Tỉ lệ</label>
                              <select
                                value={storyAspectRatio}
                                disabled={!!storyLockedAspectRatio}
                                title={storyLockedAspectRatio ? "Tỉ lệ khung hình khoá theo chương 1 để video cuối đồng nhất" : undefined}
                                onChange={(e) => setStoryAspectRatio(e.target.value)}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {(selected?.aspect_ratios ?? ["9:16", "16:9", "1:1"]).map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {/* Luồng mặc định (1 nhân vật, AI tự vẽ ảnh) đã dùng bước "Tạo kịch bản" ở
                                Hàng 1 để khoá thời lượng riêng từng cảnh — ẩn dropdown phẳng này để tránh
                                hiểu nhầm (nó không còn ảnh hưởng gì tới mức thực tế dùng ở luồng đó). Vẫn
                                giữ nguyên cho own-images/nhiều nhân vật (chưa nối kiến trúc kịch bản mới). */}
                            {selected?.duration_price_vnd && !storyUsesScriptFlow && (
                              <div>
                                <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Thời lượng</label>
                                <select
                                  value={storyDurationKey ?? ""}
                                  onChange={(e) => setStoryDurationKey(e.target.value)}
                                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                >
                                  {Object.entries(selected.duration_price_vnd).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {k}s — {v}đ
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                        Đơn giá đã chọn: <strong className="text-zinc-900 dark:text-zinc-50">{storyVideoCost ?? "?"} credit</strong>
                      </p>
                      {(storyVideoModelKey === "kling-o1-flfv" || storyVideoModelKey === "veo31-lite-flf") && (
                        <label className="mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                          <input
                            type="checkbox"
                            checked={storyContinuousMotion}
                            disabled={storyVideoModelKey === "veo31-lite-flf"}
                            onChange={(e) => {
                              setStoryContinuousMotion(e.target.checked);
                              if (e.target.checked) setStoryFrameChainMode(false);
                            }}
                            className="mt-0.5"
                          />
                          <span>
                            🎬 Chuyển động liên tục giữa các cảnh — mỗi cảnh nối liền mạch sang cảnh sau (thêm ~1 ảnh cho cả video, không
                            phải nhân đôi).
                            {storyVideoModelKey === "veo31-lite-flf" && " Model này bắt buộc bật, không tắt được."}
                          </span>
                        </label>
                      )}
                      {!storyUseOwnSceneImages && (
                        <label className="mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                          <input
                            type="checkbox"
                            checked={storyFrameChainMode}
                            onChange={(e) => {
                              setStoryFrameChainMode(e.target.checked);
                              if (e.target.checked) {
                                setStoryContinuousMotion(false);
                                // "veo31-lite-flf" bắt buộc CẢ ảnh đầu lẫn ảnh cuối (Fal.ai từ chối thiếu field,
                                // lỗi 422) — frame-chain chỉ có đúng 1 ảnh đầu thật/cảnh, không có ảnh cuối, không
                                // tương thích. Đổi sang model khác nếu đang chọn dở, tránh submit với model không
                                // tương thích (đúng cơ chế đã có cho toggle "khách tự tải ảnh phân cảnh" ở trên).
                                // Kling O1 FLFV KHÔNG cần loại trừ — ảnh cuối của nó tuỳ chọn thật, thiếu thì tự
                                // chạy như model 1 ảnh bình thường, không lỗi.
                                if (storyVideoModelKey === "veo31-lite-flf") {
                                  const fallback = storyVideoModels.find((m) => m.key !== "veo31-lite-flf");
                                  setStoryVideoModelKey(fallback?.key ?? null);
                                  setStoryDurationKey(fallback?.duration_price_vnd ? Object.keys(fallback.duration_price_vnd)[0] : null);
                                }
                              }
                            }}
                            className="mt-0.5"
                          />
                          <span>
                            🧵 Dẫn trạng thái qua khung hình thật — mỗi cảnh nối tiếp bằng đúng khung hình cuối THẬT của video cảnh
                            trước (không phải ảnh AI đoán trước), liền mạch chính xác hơn nhưng phải tạo TUẦN TỰ nên chậm hơn nhiều
                            (không chạy song song các cảnh).
                          </span>
                        </label>
                      )}
                    </div>

                <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                  <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🤖 Agent xử lý</p>
                  <label className="mb-2 block text-sm text-zinc-500 dark:text-zinc-400">Thể loại</label>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {STORY_GENRE_OPTIONS.map((g) => {
                      const thumbUrl = storyGenreThumbnails[g.value];
                      const isSelected = storyGenreKey === g.value;
                      return (
                        <button
                          key={g.value}
                          type="button"
                          onClick={() => setStoryGenreKey(g.value)}
                          className={`relative w-20 shrink-0 overflow-hidden rounded-xl border-2 text-center ${
                            isSelected ? "border-emerald-500" : "border-transparent"
                          }`}
                        >
                          <div className={`flex h-20 w-20 items-center justify-center text-2xl ${thumbUrl ? "" : `bg-gradient-to-br ${g.gradient}`}`}>
                            {thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={thumbUrl} alt={g.label} className="h-full w-full object-cover" />
                            ) : (
                              <span>{g.emoji}</span>
                            )}
                          </div>
                          <div className="bg-zinc-100 px-1 py-1 text-[11px] font-medium leading-tight text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                            {g.label}
                          </div>
                          {isSelected && (
                            <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">
                              ✓
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                  <label className="mb-1 block text-sm text-zinc-500 dark:text-zinc-400">Model chat</label>
                  <select
                    value={storyModelChatKey}
                    onChange={(e) => setStoryModelChatKey(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  >
                    {STORY_MODEL_CHAT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">Admin chỉnh hướng dẫn Agent trong /admin.</p>
                </div>
              </div>

              {/* Hàng 5: Bối cảnh/Địa điểm thật (tuỳ chọn) — full width, độc lập với Ảnh nhân vật */}
              <div className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">📍 Bối cảnh/Địa điểm (tuỳ chọn)</p>
                <p className="mb-3 text-sm text-zinc-400 dark:text-zinc-500">
                  Đưa ảnh thật của 1 địa điểm (sân vườn, nhà, cửa hàng...) để video diễn ra đúng tại khung cảnh đó — không bắt
                  buộc, bỏ trống thì AI tự vẽ bối cảnh theo mô tả truyện.
                </p>
                <div className="grid grid-cols-4 gap-3">
                  {storyLocationReference ? (
                    <div
                      className="relative w-full"
                      // Theo đúng tỉ lệ ẢNH THẬT (không ép theo tỉ lệ video) để không bị cắt xén — khung vị trí đã
                      // chọn vẽ đè lên bằng toạ độ % theo ảnh gốc, chỉ khớp chính xác khi ảnh hiện đủ, không crop.
                      style={{
                        aspectRatio: storyLocationImageNaturalSize
                          ? `${storyLocationImageNaturalSize.w} / ${storyLocationImageNaturalSize.h}`
                          : storyAspectRatio.replace(":", " / "),
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={storyLocationReference}
                        alt="Bối cảnh/Địa điểm"
                        onClick={() => setStoryQuickZoomUrl(storyLocationReference)}
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          setStoryLocationImageNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
                        }}
                        className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                        title="Bấm để xem to"
                      />
                      <button
                        onClick={() => {
                          setStoryLocationReference(null);
                          handleClearLocationMask();
                          setStoryLocationImageNaturalSize(null);
                        }}
                        className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                      >
                        ✕
                      </button>
                      {/* Vẽ ĐÈ vùng đã chọn lên ảnh để khách thấy ngay nhân vật sẽ đứng ở đâu (mỗi nhân vật 1
                          màu + tên khi nhiều người; 1 nhân vật thì 1 khung xanh "Vị trí đứng"). */}
                      {storyLocationMaskAssignments.map((a) => {
                          const color = STORY_MASK_ZONE_COLORS[a.characterPosition % STORY_MASK_ZONE_COLORS.length];
                          const label =
                            storyExtraCharacters.length === 0
                              ? "Vị trí đứng"
                              : a.characterPosition === 0
                                ? storyPrimaryCharacterLabel.trim() || "Nhân vật 1"
                                : storyExtraCharacters[a.characterPosition - 1]?.label.trim() || `Nhân vật ${a.characterPosition + 1}`;
                          return (
                            <div
                              key={a.characterPosition}
                              className="pointer-events-none absolute border-2"
                              style={{
                                left: `${a.rect.x * 100}%`,
                                top: `${a.rect.y * 100}%`,
                                width: `${a.rect.w * 100}%`,
                                height: `${a.rect.h * 100}%`,
                                borderColor: color,
                                backgroundColor: `${color}33`,
                              }}
                            >
                              <span
                                className="absolute left-0 top-0 max-w-full -translate-y-full truncate rounded-t px-1 text-[10px] font-semibold leading-4 text-white"
                                style={{ backgroundColor: color }}
                              >
                                {label}
                              </span>
                            </div>
                          );
                        })}
                      {storyLocationReferenceMaskUrl && (
                        <span className="absolute bottom-1 left-1 rounded-full bg-emerald-600/90 px-2 py-0.5 text-xs font-medium text-white">
                          ✓ Đã chọn vị trí
                        </span>
                      )}
                    </div>
                  ) : (
                    <label
                      className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                      style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}
                    >
                      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          handleClearLocationMask();
                          setStoryLocationImageNaturalSize(null);
                          compressImageFile(file).then((dataUrl) => setStoryLocationReference(dataUrl));
                        }}
                      />
                    </label>
                  )}
                </div>

                {storyLocationReference && (
                  <div className="mt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => {
                          // 1 nhân vật: mở lại khung chọn thì hiện sẵn vùng đã chọn lần trước để chỉnh tiếp.
                          if (!storyLocationMaskEditorOpen && storyExtraCharacters.length === 0 && storyLocationMaskAssignments[0]) {
                            setStoryLocationMaskRect(storyLocationMaskAssignments[0].rect);
                          }
                          setStoryLocationMaskEditorOpen((v) => !v);
                        }}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        {storyLocationMaskEditorOpen ? "Đóng" : storyLocationReferenceMaskUrl ? "🎯 Chọn lại vị trí đứng" : "🎯 Chọn vị trí đứng"}
                      </button>
                      {storyLocationReferenceMaskUrl && (
                        <button
                          onClick={handleClearLocationMask}
                          className="text-sm font-medium text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                        >
                          Bỏ vị trí đã chọn
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-zinc-400 dark:text-zinc-500">
                      Tuỳ chọn — kéo chuột chọn đúng chỗ muốn nhân vật đứng trong ảnh Bối cảnh (chỉ hoạt động với model GPT
                      Image 2 Edit, app sẽ tự chuyển model nếu cần).
                    </p>
                    {storyLocationMaskEditorOpen &&
                      (() => {
                        const maskCharacterOptions =
                          storyExtraCharacters.length > 0
                            ? [
                                { position: 0, label: storyPrimaryCharacterLabel.trim() || "Nhân vật 1" },
                                ...storyExtraCharacters.map((c, i) => ({ position: i + 1, label: c.label.trim() || `Nhân vật ${i + 2}` })),
                              ]
                            : [];
                        const isMulti = maskCharacterOptions.length > 0;
                        return (
                          <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                            <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                              {isMulti
                                ? "Bấm chọn từng nhân vật bên dưới → kéo chuột khoanh vùng người đó đứng → bấm \"Lưu vị trí cho…\". Xong tất cả bấm \"Xong\"."
                                : "Hiện chỉ có 1 nhân vật nên chọn được 1 vị trí. Muốn 2 người đứng 2 chỗ riêng: thêm nhân vật ở khung \"Ảnh nhân vật\" (nút \"+ Thêm nhân vật\"), rồi mở lại \"Chọn vị trí đứng\"."}
                            </p>
                            {isMulti && (
                              <div className="mb-2 flex flex-wrap gap-2">
                                {maskCharacterOptions.map((c) => {
                                  const color = STORY_MASK_ZONE_COLORS[c.position % STORY_MASK_ZONE_COLORS.length];
                                  const assigned = storyLocationMaskAssignments.some((a) => a.characterPosition === c.position);
                                  const active = storyLocationMaskActiveCharacter === c.position;
                                  return (
                                    <span key={c.position} className="inline-flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        storyLocationMaskDragStartRef.current = null;
                                        setStoryLocationMaskActiveCharacter(c.position);
                                        setStoryLocationMaskRect(
                                          storyLocationMaskAssignments.find((a) => a.characterPosition === c.position)?.rect ?? null
                                        );
                                      }}
                                      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium"
                                      style={{
                                        borderColor: color,
                                        backgroundColor: active ? `${color}30` : "transparent",
                                        color: active ? color : undefined,
                                      }}
                                    >
                                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                                      {c.label}
                                      {assigned && " ✓"}
                                    </button>
                                    {assigned && (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveLocationMaskAssignment(c.position)}
                                        title={`Bỏ vị trí của ${c.label}`}
                                        className="rounded-full px-1.5 text-sm font-semibold text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950"
                                      >
                                        ✕
                                      </button>
                                    )}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            <div
                              // SỬA (phản hồi thật của khách): max-w-md (~448px) quá nhỏ để quan sát rõ chi tiết
                              // ảnh Bối cảnh khi cần chọn chính xác vị trí đứng — tăng lên max-w-3xl (~768px) để
                              // khách nhìn rõ hơn nhiều trên màn hình laptop/desktop, vẫn co giãn về full-width trên
                              // điện thoại (w-full vẫn giữ, chỉ nới trần max-width). Khach xin to hon nua sau
                              // ban max-w-3xl (768px) - tang tiep len max-w-5xl (1024px).
                              className="relative mx-auto w-full max-w-5xl cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-black/10"
                              style={{
                                aspectRatio: storyLocationImageNaturalSize
                                  ? `${storyLocationImageNaturalSize.w} / ${storyLocationImageNaturalSize.h}`
                                  : storyAspectRatio.replace(":", " / "),
                              }}
                              onPointerDown={handleLocationMaskPointerDown}
                              onPointerMove={handleLocationMaskPointerMove}
                              onPointerUp={handleLocationMaskPointerUp}
                              onPointerCancel={handleLocationMaskPointerUp}
                              onLostPointerCapture={handleLocationMaskPointerUp}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={storyLocationReference}
                                alt="Chọn vị trí đứng"
                                className="pointer-events-none h-full w-full object-contain"
                                draggable={false}
                              />
                              {isMulti &&
                                storyLocationMaskAssignments
                                  .filter((a) => a.characterPosition !== storyLocationMaskActiveCharacter)
                                  .map((a) => {
                                    const otherColor = STORY_MASK_ZONE_COLORS[a.characterPosition % STORY_MASK_ZONE_COLORS.length];
                                    const otherLabel = maskCharacterOptions.find((c) => c.position === a.characterPosition)?.label;
                                    return (
                                    <div
                                      key={a.characterPosition}
                                      className="pointer-events-none absolute border-2"
                                      style={{
                                        left: `${a.rect.x * 100}%`,
                                        top: `${a.rect.y * 100}%`,
                                        width: `${a.rect.w * 100}%`,
                                        height: `${a.rect.h * 100}%`,
                                        borderColor: otherColor,
                                        backgroundColor: `${otherColor}25`,
                                      }}
                                    >
                                      {/* SỬA (phản hồi thật của khách): ô vùng của người KHÁC (không phải người
                                          đang active) trước đây không có nhãn tên — nếu 2 vị trí gần/trùng nhau,
                                          nhìn như chỉ có 1 ô, tưởng nhầm là vị trí kia chưa lưu dù chip đã có ✓.
                                          Thêm nhãn tên giống hệt cách đã làm ở khung ảnh Bối cảnh thu nhỏ bên ngoài. */}
                                      {otherLabel && (
                                        <span
                                          className="absolute left-0 top-0 max-w-full -translate-y-full truncate rounded-t px-1 text-[10px] font-semibold leading-4 text-white"
                                          style={{ backgroundColor: otherColor }}
                                        >
                                          {otherLabel}
                                        </span>
                                      )}
                                    </div>
                                    );
                                  })}
                              {storyLocationMaskRect && (
                                <div
                                  className="pointer-events-none absolute border-2"
                                  style={{
                                    left: `${storyLocationMaskRect.x * 100}%`,
                                    top: `${storyLocationMaskRect.y * 100}%`,
                                    width: `${storyLocationMaskRect.w * 100}%`,
                                    height: `${storyLocationMaskRect.h * 100}%`,
                                    borderColor: isMulti
                                      ? STORY_MASK_ZONE_COLORS[storyLocationMaskActiveCharacter % STORY_MASK_ZONE_COLORS.length]
                                      : "#34d399",
                                    backgroundColor: isMulti
                                      ? `${STORY_MASK_ZONE_COLORS[storyLocationMaskActiveCharacter % STORY_MASK_ZONE_COLORS.length]}40`
                                      : "#34d39940",
                                  }}
                                >
                                  {/* Nhãn tên cho ô đang chỉnh (active) — nhất quán với ô của người khác, đỡ
                                      phải nhìn lên chip màu ở trên mới biết đang vẽ cho ai. */}
                                  {isMulti && (
                                    <span
                                      className="absolute left-0 top-0 max-w-full -translate-y-full truncate rounded-t px-1 text-[10px] font-semibold leading-4 text-white"
                                      style={{ backgroundColor: STORY_MASK_ZONE_COLORS[storyLocationMaskActiveCharacter % STORY_MASK_ZONE_COLORS.length] }}
                                    >
                                      {maskCharacterOptions.find((c) => c.position === storyLocationMaskActiveCharacter)?.label}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {isMulti ? (
                                <>
                                  <button
                                    onClick={() => handleSaveLocationMaskAssignment(maskCharacterOptions)}
                                    disabled={
                                      !storyLocationMaskRect ||
                                      storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION ||
                                      storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION
                                    }
                                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                                  >
                                    Lưu vị trí cho{" "}
                                    {maskCharacterOptions.find((c) => c.position === storyLocationMaskActiveCharacter)?.label}
                                  </button>
                                  <button
                                    onClick={handleFinishLocationMask}
                                    disabled={storyLocationMaskAssignments.length === 0}
                                    className="rounded-lg border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950"
                                  >
                                    Xong ({storyLocationMaskAssignments.length}/{maskCharacterOptions.length})
                                  </button>
                                  {storyLocationMaskAssignments.some((a) => a.characterPosition === storyLocationMaskActiveCharacter) && (
                                    <button
                                      onClick={() => handleRemoveLocationMaskAssignment(storyLocationMaskActiveCharacter)}
                                      className="text-sm font-medium text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                                    >
                                      Xoá vị trí người này
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={handleConfirmLocationMask}
                                  disabled={
                                    !storyLocationMaskRect ||
                                    storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION ||
                                    storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION
                                  }
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                                >
                                  Xác nhận vị trí
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  setStoryLocationMaskRect(null);
                                  setStoryLocationMaskEditorOpen(false);
                                }}
                                className="text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                              >
                                {isMulti ? "Đóng (không lưu thêm)" : "Huỷ"}
                              </button>
                            </div>
                            {/* SỬA (phản hồi thật của khách): trước đây nút "Lưu vị trí"/"Xác nhận vị trí" tự
                                mờ đi khi vùng khoanh quá nhỏ mà KHÔNG có dòng nào giải thích lý do — khách chỉ
                                thấy nút không bấm được, tưởng bị lỗi. Thêm cảnh báo rõ ràng ngay khi phát hiện. */}
                            {storyLocationMaskRect &&
                              (storyLocationMaskRect.w < STORY_MASK_MIN_FRACTION || storyLocationMaskRect.h < STORY_MASK_MIN_FRACTION) && (
                                <p className="mt-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                                  ⚠️ Vùng vừa khoanh quá nhỏ — kéo chuột rộng ra thêm 1 chút để bấm được nút lưu.
                                </p>
                              )}
                          </div>
                        );
                      })()}
                  </div>
                )}
              </div>

              {/* Hàng 6: Ảnh phân cảnh (full width) */}
              <div ref={storyScenesPreviewRef} className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🖼️ Ảnh phân cảnh</p>
                      <label className="mb-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                        <input
                          type="checkbox"
                          checked={storyUseOwnSceneImages}
                          onChange={(e) => {
                            setStoryUseOwnSceneImages(e.target.checked);
                            // "veo31-lite-flf" không dùng được ở chế độ này (xem chú thích ở dropdown Model video) —
                            // đổi sang model khác nếu đang chọn dở, tránh submit với model không tương thích.
                            if (e.target.checked && storyVideoModelKey === "veo31-lite-flf") {
                              const fallback = storyVideoModels.find((m) => m.key !== "veo31-lite-flf");
                              setStoryVideoModelKey(fallback?.key ?? null);
                              setStoryContinuousMotion(false);
                            }
                          }}
                        />
                        Đã có sẵn ảnh phân cảnh — tải lên thay vì để AI tạo
                      </label>
                      <>
                          <div className="grid grid-cols-4 gap-3">
                            {storySceneImages.map((img, index) => {
                              const aiScene = !storyUseOwnSceneImages ? storyScenes?.[index] : undefined;
                              const isRegeneratingThis = aiScene && storyRegeneratingSceneId === aiScene.id;
                              const isRegeneratingThisContinuous = aiScene && storyRegeneratingContinuousPosition === aiScene.position;
                              return (
                              <div key={index} className="space-y-1">
                                <div
                                  className="relative w-full overflow-hidden rounded-lg bg-black/10 dark:bg-black/30"
                                  style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={img}
                                    alt={`Ảnh phân cảnh ${index + 1}`}
                                    onClick={() => setStoryQuickZoomUrl(img)}
                                    className="h-full w-full cursor-zoom-in object-contain"
                                    title="Bấm để xem to"
                                  />
                                  {(isRegeneratingThis || isRegeneratingThisContinuous) && (
                                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-xs text-white">
                                      Đang tạo lại...
                                    </div>
                                  )}
                                  <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                                    Cảnh {index + 1}
                                  </span>
                                  {aiScene && !storyContinuousMotion && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!isRegeneratingThis) handleRegenerateScene(aiScene.id);
                                      }}
                                      disabled={!!storyRegeneratingSceneId}
                                      title="Tạo lại đúng cảnh này (tốn thêm credit như 1 ảnh phân cảnh)"
                                      className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-1 text-xs text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      🔄
                                    </button>
                                  )}
                                  {aiScene && storyContinuousMotion && storyStatus === "images_ready" && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!isRegeneratingThisContinuous) handleRegenerateContinuousScene(aiScene.position);
                                      }}
                                      disabled={storyRegeneratingContinuousPosition !== null}
                                      title="Tạo lại đúng cảnh này (tốn thêm credit như 1 ảnh phân cảnh)"
                                      className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-1 text-xs text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                      🔄
                                    </button>
                                  )}
                                  <button
                                    onClick={() => {
                                      setStorySceneImages((prev) => prev.filter((_, i) => i !== index));
                                      setStorySceneHints((prev) => prev.filter((_, i) => i !== index));
                                      if (storyQuickZoomUrl === img) setStoryQuickZoomUrl(null);
                                    }}
                                    className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                                  >
                                    ✕
                                  </button>
                                  <a
                                    href={img.startsWith("http") ? `/api/download?url=${encodeURIComponent(img)}&filename=canh-${index + 1}.jpg` : img}
                                    download={`canh-${index + 1}.jpg`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white hover:bg-black/80"
                                    title="Tải ảnh về máy"
                                  >
                                    ⬇
                                  </a>
                                </div>
                                {aiScene && (
                                  <div className="flex flex-wrap gap-1">
                                    <button
                                      onClick={() => handleCheckSceneAnatomy(aiScene.id, img)}
                                      disabled={!!storyAnatomyChecking[aiScene.id]}
                                      title="Nhờ AI kiểm tra ảnh này có thiếu/lỗi tay chân, chữ lạ, nhiều người không (miễn phí)"
                                      className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                    >
                                      {storyAnatomyChecking[aiScene.id] ? "Đang kiểm tra..." : "🩻 Kiểm tra chi thể"}
                                    </button>
                                    {aiScene.endImageUrl && (
                                      <button
                                        onClick={() => handleCheckSceneContinuity(aiScene.id, aiScene.imageUrl as string, aiScene.endImageUrl as string)}
                                        disabled={!!storyContinuityChecking[aiScene.id]}
                                        title="Nhờ AI so sánh ảnh đầu/cuối cảnh này có cùng phòng/đồ nội thất không (miễn phí)"
                                        className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                      >
                                        {storyContinuityChecking[aiScene.id] ? "Đang kiểm tra..." : "🔗 Kiểm tra đầu/cuối"}
                                      </button>
                                    )}
                                  </div>
                                )}
                                {storyAnatomyResults[aiScene?.id ?? -1] && (
                                  <p className={`text-[11px] ${storyAnatomyResults[aiScene!.id].ok ? "text-emerald-600" : "text-red-500"}`}>
                                    {storyAnatomyResults[aiScene!.id].ok ? "✅ Chi thể ổn" : `⚠️ ${storyAnatomyResults[aiScene!.id].issue ?? "Có lỗi"}`}
                                  </p>
                                )}
                                {storyContinuityResults[aiScene?.id ?? -1] && (
                                  <p className={`text-[11px] ${storyContinuityResults[aiScene!.id].ok ? "text-emerald-600" : "text-red-500"}`}>
                                    {storyContinuityResults[aiScene!.id].ok
                                      ? "✅ Đầu/cuối khớp nhau"
                                      : `⚠️ ${storyContinuityResults[aiScene!.id].issue ?? "Lệch đầu/cuối"}`}
                                  </p>
                                )}
                                {storyUseOwnSceneImages && (
                                  <textarea
                                    value={storySceneHints[index] ?? ""}
                                    onChange={(e) =>
                                      setStorySceneHints((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))
                                    }
                                    placeholder="Gợi ý chuyển động (tuỳ chọn)"
                                    rows={2}
                                    className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                                  />
                                )}
                              </div>
                              );
                            })}
                            {storySceneImages.length < STORY_MAX_SCENES && (
                              <label
                                className="flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-800"
                                style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}
                              >
                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">+ Tải ảnh</span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  className="hidden"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (!file) return;
                                    compressImageFile(file).then((dataUrl) => {
                                      setStorySceneImages((prev) => [...prev, dataUrl]);
                                      setStorySceneHints((prev) => [...prev, ""]);
                                    });
                                  }}
                                />
                              </label>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                            {storyUseOwnSceneImages
                              ? `Đã tải ${storySceneImages.length}/${STORY_MAX_SCENES} ảnh — mỗi ảnh là 1 phân cảnh theo đúng thứ tự tải lên. AI (Agent) sẽ tự viết mô tả chuyển động cho từng ảnh dựa theo ảnh + Ý tưởng truyện — gợi ý ở trên chỉ để hỗ trợ thêm, không bắt buộc. Không tốn credit tạo ảnh.`
                              : "Chưa có ảnh — bấm \"Tạo ảnh phân cảnh\" để AI tự vẽ theo Model bên dưới, hoặc tự tải ảnh có sẵn vào đây."}
                          </p>
                        </>
              </div>

              {storyStatusText && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{storyStatusText}</p>
                  {storyRunning && storyJobId && (
                    <button
                      onClick={handleCancelStoryVideo}
                      disabled={storyCancelling}
                      className="shrink-0 rounded-full border border-red-400 px-4 py-1.5 text-sm font-medium text-red-600 disabled:opacity-40 dark:border-red-500 dark:text-red-400"
                    >
                      {storyCancelling ? "Đang dừng..." : "⏹ Dừng tạo"}
                    </button>
                  )}
                </div>
              )}
              {storyError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{storyError}</p>}

              {/* SỬA (phản hồi thật của khách): trước đây "xem to" chỉ render ảnh ở 1 khối cố định tuốt CUỐI
                  trang (phải cuộn xuống mới thấy), lại giới hạn max-w-xl (~576px) — không đủ to để quan sát rõ
                  chi tiết ảnh Bối cảnh trước khi chọn vị trí đứng. Đổi thành overlay TOÀN MÀN HÌNH (fixed, che
                  nền tối, ảnh hiện ngay giữa màn hình lớn nhất có thể) — dùng chung cho MỌI chỗ gọi
                  setStoryQuickZoomUrl trong trang (ảnh nhân vật, ảnh cảnh...), không riêng ảnh Bối cảnh. */}
              {storyQuickZoomUrl && (
                <div
                  ref={storyQuickZoomRef}
                  onClick={() => setStoryQuickZoomUrl(null)}
                  className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
                >
                  <button
                    onClick={() => setStoryQuickZoomUrl(null)}
                    className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20"
                  >
                    ✕ Đóng
                  </button>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={storyQuickZoomUrl}
                    alt="Xem trước ảnh"
                    className="max-h-full max-w-full rounded-lg object-contain"
                    title="Bấm để đóng"
                  />
                </div>
              )}

              {storyStatus === "character_ready" && storyCharacterSheetUrl && (
                <div
                  ref={storyCharacterPreviewRef}
                  className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <p className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh Character (nhiều góc) — xem trước rồi mới chia cảnh
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={storyCharacterSheetUrl} alt="Character sheet" className="w-full max-w-xl rounded-lg" />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(storyCharacterSheetUrl)}&filename=character-sheet.png`}
                      download
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    {storyCharacterSource !== "reused" && (
                      <button
                        onClick={handleRegenerateCharacter}
                        disabled={storyRegeneratingCharacter || storyContinuingScenes}
                        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {storyRegeneratingCharacter ? "Đang tạo lại..." : "🔄 Tạo lại Character"}
                      </button>
                    )}
                    {storyCharacterSource !== "reused" && (
                      <button
                        onClick={handleSaveCharacter}
                        disabled={storySavingCharacter}
                        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {storySavingCharacter ? "Đang lưu..." : "💾 Lưu vào thư viện"}
                      </button>
                    )}
                    <button
                      onClick={handleContinueToScenes}
                      disabled={storyContinuingScenes || storyRegeneratingCharacter || !input.trim()}
                      title={!input.trim() ? "Nhập Ý tưởng truyện ở ô phía trên trước" : undefined}
                      className="ml-auto rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyContinuingScenes ? "Đang gửi..." : "Tiếp tục chia cảnh →"}
                    </button>
                  </div>
                  {!input.trim() && (
                    <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                      ⚠️ Nhập "Ý tưởng truyện" ở ô phía trên trước khi tiếp tục — bước chia cảnh cần nội dung này.
                    </p>
                  )}
                  {storySavedCharacterMsg && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{storySavedCharacterMsg}</p>}
                </div>
              )}

              {(storyStatus === "character_ready" || storyStatus === "generating_character") &&
                storyJobCharacters &&
                storyJobCharacters.length > 0 && (
                  <div
                    ref={storyCharacterPreviewRef}
                    className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                  >
                    <p className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                      Ảnh Character từng nhân vật ({storyJobCharacters.filter((c) => c.ready).length}/{storyJobCharacters.length} xong)
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {storyJobCharacters.map((c) => {
                        const isRegeneratingThis = storyRegeneratingJobCharacterPosition === c.position;
                        return (
                          <div key={c.position} className="space-y-1">
                            <div className="relative w-full aspect-square">
                              {c.sheetUrl && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={c.sheetUrl} alt={c.label ?? `Nhân vật ${c.position + 1}`} className="h-full w-full rounded-lg object-cover" />
                              )}
                              {(!c.sheetUrl || isRegeneratingThis) && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-xs text-white">
                                  {isRegeneratingThis ? "Đang tạo lại..." : "Đang tạo..."}
                                </div>
                              )}
                              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                                {c.label || `Nhân vật ${c.position + 1}`}
                              </span>
                            </div>
                            {c.ready && (
                              <button
                                onClick={() => handleRegenerateJobCharacter(c.position)}
                                disabled={!!storyRegeneratingJobCharacterPosition}
                                className="w-full rounded-full border border-zinc-300 py-1 text-xs font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                              >
                                🔄 Tạo lại
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {storyStatus === "character_ready" && (
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          onClick={handleContinueToScenes}
                          disabled={storyContinuingScenes || !!storyRegeneratingJobCharacterPosition || !input.trim()}
                          title={!input.trim() ? "Nhập Ý tưởng truyện ở ô phía trên trước" : undefined}
                          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                        >
                          {storyContinuingScenes ? "Đang gửi..." : "Tiếp tục chia cảnh →"}
                        </button>
                      </div>
                    )}
                    {storyStatus === "character_ready" && !input.trim() && (
                      <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                        ⚠️ Nhập "Ý tưởng truyện" ở ô phía trên trước khi tiếp tục — bước chia cảnh cần nội dung này.
                      </p>
                    )}
                  </div>
                )}

              {storyStatus === "scenes_ready" && storyScenePreviews && storyScenePreviews.length > 0 && (
                <div
                  ref={storyScenePreviewSectionRef}
                  className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <p className="mb-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    Xem trước bố cục ({storyScenePreviews.length} cảnh) — ảnh phác thảo dưới đây chỉ để tham khảo khung hình,
                    chưa tốn credit
                  </p>
                  <p className="mb-3 text-xs text-zinc-400 dark:text-zinc-500">
                    Kéo chuột trên mannequin để xoay xem góc khác, bấm &quot;Chọn góc này&quot; nếu muốn đổi. Ưng bố cục thì bấm
                    &quot;Tạo ảnh&quot; để AI vẽ ảnh thật cho từng cảnh (lúc này mới trừ credit).
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {storyScenePreviews.map((scene) => (
                      <div key={scene.id} className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                        <div className="relative">
                          <MannequinPreviewCard
                            locationUrl={storyLocationReference}
                            boxStyle={computeMannequinBoxStyle(scene.shotSize, storyLocationMaskAssignments[0]?.rect ?? storyLocationMaskRect ?? null)}
                            cameraAngle={scene.cameraAngle}
                            cameraView={scene.cameraView ?? "front"}
                            onCameraViewChange={(view) => handleScenePreviewCameraViewChange(scene.id, view)}
                          />
                          <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                            Cảnh {scene.position + 1}
                          </span>
                        </div>
                        <div className="p-3">
                          <p className="line-clamp-3 text-sm text-zinc-600 dark:text-zinc-300">{scene.sceneDescription}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            {scene.shotSize && (
                              <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                                {SCENE_PREVIEW_SHOT_SIZE_LABEL[scene.shotSize] ?? scene.shotSize}
                              </span>
                            )}
                            {scene.cameraAngle && (
                              <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                                {SCENE_PREVIEW_CAMERA_ANGLE_LABEL[scene.cameraAngle] ?? scene.cameraAngle}
                              </span>
                            )}
                            {scene.cameraView && (
                              <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                                {SCENE_PREVIEW_CAMERA_VIEW_LABEL[scene.cameraView] ?? scene.cameraView}
                              </span>
                            )}
                            {scene.cameraMovement && (
                              <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                                {SCENE_PREVIEW_CAMERA_MOVEMENT_LABEL[scene.cameraMovement] ?? scene.cameraMovement}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                            <button
                              type="button"
                              onClick={() => setActivePresetModal({ stage: "preview", key: scene.id, type: "light" })}
                              className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              💡 {SCENE_PREVIEW_LIGHT_DIRECTION_LABEL[(scene.lightDirection as (typeof LIGHT_DIRECTION_OPTIONS)[number]) ?? "front_lighting"]}
                            </button>
                            <button
                              type="button"
                              onClick={() => setActivePresetModal({ stage: "preview", key: scene.id, type: "gear" })}
                              className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                            >
                              🎥 {SCENE_PREVIEW_CAMERA_BODY_LABEL[(scene.cameraBody as (typeof CAMERA_BODY_OPTIONS)[number]) ?? "modern"]} ·{" "}
                              {SCENE_PREVIEW_LENS_LABEL[(scene.lens as (typeof LENS_OPTIONS)[number]) ?? "clean_sharp"]} ·{" "}
                              {SCENE_PREVIEW_APERTURE_LABEL[(scene.aperture as (typeof APERTURE_OPTIONS)[number]) ?? "moderate"]}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex justify-end">
                    <button
                      onClick={handleContinueToImages}
                      disabled={storyContinuingImages}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyContinuingImages ? "Đang gửi..." : "Tạo ảnh →"}
                    </button>
                  </div>
                </div>
              )}

              {(storyStatus === "failed" || storyStatus === "cancelled") && storyScenes && storyScenes.every((s) => s.imageUrl) && (
                <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh phân cảnh đã tạo thành công trước khi lỗi ở bước sau, không bị mất (xem lại ở khung "Ảnh phân cảnh" phía trên)
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-600 dark:text-zinc-400">
                      Thử tạo video lại từ ảnh phân cảnh đã có — không cần làm lại từ đầu
                    </span>
                    <button
                      onClick={handleContinueToVideo}
                      disabled={storyContinuing}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900"
                    >
                      {storyContinuing ? "Đang gửi..." : "Thử lại tạo video"}
                    </button>
                  </div>
                </div>
              )}

              {/* Tách riêng khỏi khối "every imageUrl" ở trên — chế độ frame-chaining vẽ ảnh TUẦN TỰ
                  (ảnh cảnh N+1 cần video cảnh N xong mới có), nên nếu 1 cảnh giữa chừng kẹt video vĩnh
                  viễn (vd bị model từ chối nội dung), các cảnh SAU nó không bao giờ có ảnh — điều kiện
                  "every(s => s.imageUrl)" ở trên không bao giờ đúng, khiến nút ghép-bỏ-cảnh-lỗi không thể
                  hiện ra dù job đang kẹt thật. Nút này chỉ cần đủ điều kiện tối thiểu: job đã "failed" và
                  có ít nhất 1 cảnh đã có video để ghép. */}
              {(storyStatus === "failed" || storyStatus === "cancelled") && storyScenes && storyScenes.some((s) => s.videoUrl) && (
                <div className="mt-4 flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    Có cảnh mãi không tạo video được (vd bị model từ chối nội dung) — ghép video cuối chỉ từ các
                    cảnh đã có video, bỏ hẳn cảnh lỗi
                  </span>
                  <button
                    onClick={handleFinalizePartial}
                    disabled={storyFinalizingPartial}
                    className="rounded-full border border-zinc-400 px-5 py-2 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-500 dark:text-zinc-300"
                  >
                    {storyFinalizingPartial ? "Đang ghép..." : "Ghép video, bỏ cảnh lỗi"}
                  </button>
                </div>
              )}

              {storyScenes && storyScenes.some((s) => s.videoUrl || s.imageUrl) && (
                <div className="mt-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
                  <p className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">🎬 Video từng cảnh</p>
                  <div className="grid grid-cols-4 gap-3">
                    {storyScenes.map((scene, index) => {
                      const isRegeneratingThisVideo = storyRegeneratingVideoSceneId === scene.id;
                      // Cảnh có ảnh nhưng chưa/không có video (lỗi lúc tạo, vd bị chặn nội dung) vẫn cần
                      // hiện card kèm nút 🔄 — trước đây return null nên cảnh lỗi biến mất hoàn toàn khỏi
                      // khung này, khách không có cách nào bấm tạo lại đúng cảnh đó qua UI.
                      if (!scene.videoUrl && !scene.imageUrl && !isRegeneratingThisVideo) return null;
                      const isEditingThisPrompt = storyEditingPromptSceneId === scene.id;
                      return (
                        <div key={scene.id} className="relative w-full" style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}>
                          {scene.videoUrl && <video src={scene.videoUrl} controls className="h-full w-full rounded-lg object-cover" />}
                          {!scene.videoUrl && scene.imageUrl && (
                            <div className="relative h-full w-full">
                              <img src={scene.imageUrl} alt={`Cảnh ${index + 1}`} className="h-full w-full rounded-lg object-cover opacity-50" />
                              {!isRegeneratingThisVideo && !isEditingThisPrompt && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 px-2 text-center text-xs text-white">
                                  Chưa có video — bấm "Viết mô tả chuyển động để tạo video" ở dưới, hoặc bấm 🔄 nếu đã tạo mà lỗi
                                </div>
                              )}
                            </div>
                          )}
                          {isRegeneratingThisVideo && (
                            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-xs text-white">
                              Đang tạo lại...
                            </div>
                          )}
                          {isEditingThisPrompt && (
                            <div className="absolute inset-0 flex flex-col gap-1.5 rounded-lg bg-black/85 p-2">
                              <p className="text-xs text-zinc-300">
                                Sửa câu mô tả chuyển động trước khi tạo lại (đổi cách diễn đạt nếu bị model từ chối):
                              </p>
                              <textarea
                                value={storyEditedPrompt}
                                onChange={(e) => setStoryEditedPrompt(e.target.value)}
                                rows={4}
                                className="flex-1 resize-none rounded border border-zinc-600 bg-zinc-900 p-1.5 text-xs text-white"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => handleRegenerateSceneVideo(scene.id, storyEditedPrompt)}
                                  className="flex-1 rounded-full bg-white px-2 py-1 text-xs font-medium text-zinc-900"
                                >
                                  Tạo lại
                                </button>
                                <button
                                  onClick={() => setStoryEditingPromptSceneId(null)}
                                  className="rounded-full border border-zinc-500 px-2 py-1 text-xs text-white"
                                >
                                  Huỷ
                                </button>
                              </div>
                            </div>
                          )}
                          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                            Cảnh {index + 1}
                          </span>
                          {scene.hasDialogue && (
                            <span
                              className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
                              title="Cảnh này có lời thoại, đã lồng tiếng"
                            >
                              🗣️
                            </span>
                          )}
                          {(scene.identityRetryCount ?? 0) > 0 && (
                            <span
                              className="absolute top-1 right-1 rounded bg-amber-600/80 px-1.5 py-0.5 text-xs text-white"
                              title={`Hệ thống phát hiện khuôn mặt bị lệch so với nhân vật gốc và đã tự vẽ lại ${scene.identityRetryCount} lần`}
                            >
                              🔄 x{scene.identityRetryCount}
                            </span>
                          )}
                          {!isEditingThisPrompt && (
                            <button
                              onClick={() => {
                                if (isRegeneratingThisVideo) return;
                                // Cảnh chưa có video (lỗi lần trước) — mở ô sửa mô tả trước khi gửi lại,
                                // vì gửi lại y hệt câu cũ dễ bị model từ chối y hệt lần trước (đã xác nhận
                                // thật với lỗi "no_media_generated" của Veo, lặp lại 2/2 lần thử).
                                if (!scene.videoUrl) {
                                  setStoryEditedPrompt(scene.motionPrompt ?? "");
                                  setStoryEditingPromptSceneId(scene.id);
                                } else {
                                  handleRegenerateSceneVideo(scene.id);
                                }
                              }}
                              disabled={!!storyRegeneratingVideoSceneId}
                              title="Tạo lại đúng video cảnh này (tốn thêm credit như 1 video phân cảnh)"
                              className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-1 text-xs text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              🔄
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
                    Không ưng video cảnh nào thì bấm 🔄 để tạo lại đúng cảnh đó, không cần tạo lại cả video.
                  </p>
                </div>
              )}

              {storyResult && (
                <div ref={storyResultRef} className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI (video hoàn chỉnh đã ghép)</p>
                  <video src={storyResult} controls className="w-full max-w-md rounded-lg" />
                  <div className="mt-3 flex gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(storyResult)}&filename=video-tu-y-tuong.mp4`}
                      download
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    {!storyMultiChapter && (
                    <button
                      onClick={() => {
                        setStoryResult(null);
                        setStoryCharacterImages([]);
                        setStorySelectedSavedCharacterId(null);
                        setStoryCharacterSheetUrl(null);
                        setStoryCharacterSource(null);
                        setStoryScenes(null);
                        setStoryStatus(null);
                        setStoryJobId(null);
                        setInput("");
                      }}
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Chạy lại với input khác
                    </button>
                    )}
                  </div>
                  {storyMultiChapter && !storyProjectFinalUrl && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                      <button
                        type="button"
                        onClick={handleNextChapter}
                        disabled={storyActiveChapter + 1 >= STORY_MAX_CHAPTERS}
                        className="rounded-full border border-zinc-900 bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                      >
                        ➕ Tạo chương {storyActiveChapter + 2}
                      </button>
                      <button
                        type="button"
                        onClick={handleFinishProject}
                        disabled={storyProjectFinalizing}
                        className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {storyProjectFinalizing ? "Đang ghép các chương..." : "🏁 Kết thúc"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {storyProjectFinalUrl && (
                <div ref={storyProjectFinalRef} className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950">
                  <p className="mb-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    🎬 Video hoàn chỉnh (đã ghép {storyProjectChapters.length + (storyResult ? 1 : 0)} chương)
                  </p>
                  <video src={storyProjectFinalUrl} controls className="w-full max-w-md rounded-lg" />
                  <div className="mt-3 flex gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(storyProjectFinalUrl)}&filename=video-nhieu-chuong.mp4`}
                      download
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    <button
                      type="button"
                      onClick={handleNewProject}
                      className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Bắt đầu dự án mới
                    </button>
                  </div>
                </div>
              )}
            </div>
          {!user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            // Nút này trước đây nằm cuối trang, phải cuộn rất xa mới thấy khi đang thao tác ở khung
            // "Ảnh nhân vật" phía trên — giờ ghim cố định đáy màn hình (giống thanh action bar) để luôn
            // bấm được ngay, không cần cuộn tìm. main đã thêm pb-24 để không bị thanh này che nội dung.
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 px-6 py-3 backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
              <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
                <span className="text-base text-zinc-600 dark:text-zinc-400">
                  {storySelectedSavedCharacterId ? (
                    input.trim() ? (
                      <>
                        "Tạo ảnh phân cảnh": Character đã lưu — chạy thẳng luôn chia cảnh + tạo ảnh, không tốn credit bước Character. "Viết mô tả chuyển động để tạo video": cần có ≥1 ảnh phân cảnh (AI tạo hoặc tự tải lên) + Ý tưởng truyện, tốn ~
                        <strong className="text-zinc-900 dark:text-zinc-50">{storyVideoCost ?? app.creditCost} credit</strong>.
                      </>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        ⚠️ Nhập "Ý tưởng truyện" ở ô phía trên trước — Character đã lưu nên sẽ chạy thẳng luôn chia cảnh, cần có ý tưởng truyện ngay từ bước này
                      </span>
                    )
                  ) : (
                    <>
                      "Tạo ảnh phân cảnh" tốn tối đa{" "}
                      <strong className="text-zinc-900 dark:text-zinc-50">{storyCharacterCost ?? "?"} credit</strong> (chỉ khi cần tạo Character mới, ảnh tính sau). "Viết mô tả chuyển động để tạo video" cần có ≥1 ảnh phân cảnh (AI tạo hoặc tự tải lên) + Ý tưởng truyện, tốn ~
                      <strong className="text-zinc-900 dark:text-zinc-50">{storyVideoCost ?? app.creditCost} credit</strong>.
                    </>
                  )}
                </span>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={handleRunStoryVideo}
                    disabled={
                      storyRunning ||
                      !storyVideoModelKey ||
                      !storyImageModelKey ||
                      (!storySelectedSavedCharacterId &&
                        storyCharacterImages.length === 0 &&
                        !(storyCharacterInputMode === "text" && storyCharacterAppearanceDescription.trim())) ||
                      (!!storySelectedSavedCharacterId && !input.trim()) ||
                      // Luồng mặc định (1 nhân vật, không own-images): bắt buộc có Ý tưởng truyện VÀ đã "Tạo
                      // kịch bản" xong — 2 điều kiện tách riêng, không được gộp bằng "&&" chung với input.trim()
                      // (trước đây gộp chung khiến ô Ý tưởng truyện trống làm cả cụm bị bỏ qua, nút không khoá dù
                      // chưa có kịch bản — xảy ra thật ở chế độ "AI tự vẽ" nhân vật). Mảng RỖNG (không chỉ null)
                      // cũng phải chặn — [] vẫn "truthy" trong JS nên chỉ check !storyScriptActions sẽ bỏ lọt.
                      (storyUsesScriptFlow && !input.trim()) ||
                      (storyUsesScriptFlow && (!storyScriptActions || storyScriptActions.length === 0)) ||
                      // Đang bật thanh trượt tốc độ: bắt buộc đã bấm "Hoàn thành" trước khi submit, tránh
                      // khách chỉnh xong quên bấm rồi giá/thời lượng gửi lên không khớp thanh trượt đang thấy.
                      (storyEnableSpeedSlider && !!storyScriptActions && !storySpeedFinalized)
                    }
                    className="rounded-full bg-zinc-900 px-6 py-2.5 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                  >
                    {storyRunning && storyActiveButton === "images" ? "Đang xử lý..." : "Tạo ảnh phân cảnh"}
                  </button>
                  <button
                    onClick={
                      storyStatus === "images_ready" ? handleContinueToVideo : () => handleRunStoryVideoWithOwnImages(true)
                    }
                    disabled={
                      storyRunning ||
                      storyContinuing ||
                      !storyVideoModelKey ||
                      !input.trim() ||
                      storySceneImages.length < STORY_MIN_SCENES
                    }
                    className="rounded-full border border-zinc-300 px-5 py-2.5 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {(storyRunning && storyActiveButton === "video") || storyContinuing ? "Đang xử lý..." : "Viết mô tả chuyển động để tạo video"}
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>
          </div>
        </section>

        {/* Lịch sử tạo của riêng app này — không lẫn kết quả từ app khác */}
        {appHistory.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Lịch sử
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {appHistory.map((item) => (
                <div key={item.id} className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                  {item.outputType === "video" ? (
                    <video src={item.outputUrl} className="h-full w-full object-cover" muted />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.outputUrl} alt="Kết quả cũ" className="h-full w-full object-cover" />
                  )}
                  <a
                    href={item.outputUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute inset-0"
                    title={new Date(item.createdAt).toLocaleString("vi-VN")}
                  />
                  <button
                    onClick={() => handleDeleteAppHistory(item.id)}
                    title="Xoá khỏi lịch sử"
                    className="absolute right-1 top-1 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white opacity-0 hover:bg-black/90 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Gợi ý Mini App liên quan — Tập 5 mục 4.1 */}
        {relatedApps.length > 0 && (
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Mini App liên quan
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {relatedApps.map((related) => (
                <Link
                  key={related.id}
                  href={`/mini-app/${related.id}`}
                  className="rounded-xl border border-zinc-200 bg-white p-4 text-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <p className="mb-1 font-medium text-zinc-900 dark:text-zinc-50">{related.name}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{related.creditCost} credit</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
      {activePresetModal &&
        (() => {
          const current =
            activePresetModal.stage === "script"
              ? storyScriptScenes?.[activePresetModal.key]
              : storyScenePreviews?.find((s) => s.id === activePresetModal.key);
          if (!current) return null;
          const isScript = activePresetModal.stage === "script";
          const c = current as any;
          const lightValue = (isScript ? c.light_direction : c.lightDirection) ?? "front_lighting";
          const bodyValue = (isScript ? c.camera_body : c.cameraBody) ?? "modern";
          const lensValue = c.lens ?? "clean_sharp";
          const apertureValue = c.aperture ?? "moderate";
          const onLight = (opt: string) =>
            isScript ? handleScriptLightDirectionChange(activePresetModal.key, opt) : handleScenePreviewLightDirectionChange(activePresetModal.key, opt);
          const onGear = (field: "camera_body" | "lens" | "aperture", opt: string) =>
            isScript
              ? handleScriptCameraGearChange(activePresetModal.key, field, opt)
              : handleScenePreviewCameraGearChange(activePresetModal.key, field === "camera_body" ? "cameraBody" : field, opt);
          const optionClass = (active: boolean) =>
            `rounded-lg border px-2 py-2.5 text-xs font-medium ${
              active
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`;
          return (
            <div
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
              onClick={() => setActivePresetModal(null)}
            >
              <div
                className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-4 dark:bg-zinc-900"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                    {activePresetModal.type === "light" ? "💡 Ánh sáng" : "🎥 Máy ảnh"}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActivePresetModal(null)}
                    className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                  >
                    ✕
                  </button>
                </div>
                {activePresetModal.type === "light" ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {LIGHT_DIRECTION_OPTIONS.map((opt) => (
                      <button key={opt} type="button" onClick={() => onLight(opt)} className={optionClass(lightValue === opt)}>
                        {SCENE_PREVIEW_LIGHT_DIRECTION_LABEL[opt]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Máy quay</p>
                      <div className="grid grid-cols-2 gap-2">
                        {CAMERA_BODY_OPTIONS.map((opt) => (
                          <button key={opt} type="button" onClick={() => onGear("camera_body", opt)} className={optionClass(bodyValue === opt)}>
                            {SCENE_PREVIEW_CAMERA_BODY_LABEL[opt]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Lens</p>
                      <div className="grid grid-cols-2 gap-2">
                        {LENS_OPTIONS.map((opt) => (
                          <button key={opt} type="button" onClick={() => onGear("lens", opt)} className={optionClass(lensValue === opt)}>
                            {SCENE_PREVIEW_LENS_LABEL[opt]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Khẩu độ</p>
                      <div className="grid grid-cols-2 gap-2">
                        {APERTURE_OPTIONS.map((opt) => (
                          <button key={opt} type="button" onClick={() => onGear("aperture", opt)} className={optionClass(apertureValue === opt)}>
                            {SCENE_PREVIEW_APERTURE_LABEL[opt]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
