"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, MINI_APPS } from "@/lib/mock-mini-apps";
import { BalanceBadge } from "@/components/BalanceBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/lib/auth-context";
import { supabaseBrowser } from "@/lib/supabase-browser";

// Kling (model tạo video đang dùng) từ chối xử lý (lỗi 422) nếu prompt quá dài — giữ dưới ngưỡng an toàn.
const VIDEO_PROMPT_MAX_LENGTH = 2000;

// Giá hiện trên nút chọn tier — tier tính theo duration hiện giá rẻ nhất ("từ X credit") thay vì
// tra theo selectedVideoDuration hiện tại, vì mỗi tier/model có bộ giây hợp lệ khác nhau (Kling
// 5/10, LTX-2.3 6/8/10/12/...) nên số giây đang chọn ở tier khác có thể không tồn tại ở tier này.
function tierDisplayCost(tier: { creditCost?: number; creditCostByDuration?: Record<string, number> }): number | undefined {
  if (tier.creditCost !== undefined) return tier.creditCost;
  if (tier.creditCostByDuration) {
    const values = Object.values(tier.creditCostByDuration);
    return values.length ? Math.min(...values) : undefined;
  }
  return undefined;
}

export default function MiniAppDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const app = MINI_APPS.find((item) => item.id === params.id);
  const { user } = useAuth();

  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  // "Nhảy theo video mẫu": endFrameDataUrl tái dùng để chứa URL video mẫu (không phải base64) vì
  // video có thể tới 15MB — upload thẳng lên Supabase Storage từ trình duyệt, không qua API route
  // (vượt giới hạn ~4.5MB request body của Vercel).
  const [uploadingReferenceVideo, setUploadingReferenceVideo] = useState(false);
  const [textFileError, setTextFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveCreditCost, setLiveCreditCost] = useState<number | null>(null);
  // Tier chất lượng video (Tiết kiệm/Cơ bản/Cao cấp) — app không có tier trả mảng rỗng nên UI chọn
  // tier chỉ hiện khi videoTiers.length > 0.
  const [videoTiers, setVideoTiers] = useState<
    {
      key: "basic" | "premium" | "budget";
      label: string;
      creditCost?: number;
      creditCostByDuration?: Record<string, number>; // key là số giây — mỗi tier/model có bộ giây riêng
    }[]
  >([]);
  const [selectedVideoTier, setSelectedVideoTier] = useState<"basic" | "premium" | "budget">("basic");
  const [selectedVideoDuration, setSelectedVideoDuration] = useState<string>("5");
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // "AI viết giúp mô tả" — khách gõ 1 gợi ý ngắn tiếng Việt, gọi OpenRouter (có nhìn ảnh nhân vật
  // nếu đã tải) để tự viết prompt tiếng Anh chuẩn cho Kling, điền thẳng vào ô "Câu lệnh mô tả".
  const [promptHint, setPromptHint] = useState("");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [promptGenError, setPromptGenError] = useState<string | null>(null);

  async function handleGeneratePrompt() {
    if (!promptHint.trim()) {
      setPromptGenError("Nhập gợi ý trước đã");
      return;
    }
    setGeneratingPrompt(true);
    setPromptGenError(null);
    try {
      const res = await fetch("/api/video/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ miniAppId: params.id, hint: promptHint.trim(), imageDataUrl: imageDataUrl ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPromptGenError(data.error ?? "Không tạo được prompt");
        return;
      }
      setInput(data.prompt);
    } catch {
      setPromptGenError("Không kết nối được tới server");
    } finally {
      setGeneratingPrompt(false);
    }
  }

  // Đăng video kết quả thẳng lên kênh YouTube của user (OAuth qua Google) — chỉ áp dụng cho app
  // outputType "video". youtubeStatus null = chưa kiểm tra xong.
  const [youtubeStatus, setYoutubeStatus] = useState<{ connected: boolean; channelTitle: string | null } | null>(null);
  const [showYoutubeForm, setShowYoutubeForm] = useState(false);
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubePublishing, setYoutubePublishing] = useState(false);
  const [youtubePublishedUrl, setYoutubePublishedUrl] = useState<string | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

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

  // Ghép nhạc nền vào video kết quả — thư viện nhạc do admin upload sẵn (đã có bản quyền hợp lệ),
  // user chỉ chọn 1 bài trong danh sách này rồi gọi /api/video/add-music (dùng ffmpeg phía server).
  const [currentVideoJobId, setCurrentVideoJobId] = useState<number | null>(null);
  const [musicTracks, setMusicTracks] = useState<{ id: number; name: string; file_url: string }[]>([]);
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [musicMode, setMusicMode] = useState<"library" | "upload">("library");
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [customAudioDataUrl, setCustomAudioDataUrl] = useState<string | null>(null);
  const [customAudioError, setCustomAudioError] = useState<string | null>(null);
  const [addingMusic, setAddingMusic] = useState(false);
  const [musicAddError, setMusicAddError] = useState<string | null>(null);
  const [musicAddedSuccess, setMusicAddedSuccess] = useState(false);

  // Chia sẻ kết quả + đánh giá nhanh (👍/👎) — chỉ là tương tác phía client, không lưu server.
  const [shareCopied, setShareCopied] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  // "Video đồng nhất nhân vật": 2-4 nhân vật, mỗi người 1 ảnh + 1 lời thoại riêng — upload ảnh thật
  // lên Storage lúc bấm "Chạy ngay" (giống outfit-swap), không upload ngay lúc chọn file.
  const DIALOGUE_MIN_CHARACTERS = 2;
  const DIALOGUE_MAX_CHARACTERS = 4;
  type DialogueCharacter = { image: string | null; error: string | null; line: string };
  const [dialogueCharacters, setDialogueCharacters] = useState<DialogueCharacter[]>([
    { image: null, error: null, line: "" },
    { image: null, error: null, line: "" },
  ]);
  const [dialogueCreditCost, setDialogueCreditCost] = useState<number | null>(null);
  const [dialogueRunning, setDialogueRunning] = useState(false);
  const [dialogueStatusText, setDialogueStatusText] = useState<string | null>(null);
  const [dialogueResult, setDialogueResult] = useState<string | null>(null);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  const dialoguePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // "Video từ ý tưởng truyện": 1-3 ảnh nhân vật + mô tả truyện (dùng chung state `input`) + số phân
  // cảnh (2-8) + chọn model ảnh/video từ catalog nhiều nhà cung cấp — AI tự chia cảnh, không cho
  // khách tự viết từng cảnh.
  const STORY_MIN_SCENES = 1;
  const STORY_MAX_SCENES = 8;
  // Đúng cận trên MAX_STORY_CHARACTERS trong lib/story-video.ts (client component không import được
  // file server đó — sharp/child_process — nên khai lại hằng số ở đây).
  const STORY_MAX_CHARACTERS = 4;
  const [numScenes, setNumScenes] = useState(3);
  const [storyCharacterImages, setStoryCharacterImages] = useState<string[]>([]);
  // Nhân vật #2, #3, #4 (nếu có) — nhân vật #1 vẫn dùng nguyên storyCharacterImages/
  // storySelectedSavedCharacterId ở trên, không đổi gì, để giữ đúng luồng 1-nhân-vật hiện có khi khách
  // không thêm ai — chỉ khi mảng này có phần tử mới coi là job nhiều nhân vật.
  const [storyExtraCharacters, setStoryExtraCharacters] = useState<{ images: string[]; reuseId: number | null; label: string }[]>([]);
  // Tên nhân vật #1 — chỉ cần điền khi có thêm nhân vật khác (job nhiều người), để Agent chia cảnh
  // khớp đúng tên trong Ý tưởng truyện (vd truyện viết "Lan ôm Mai" thì cần đúng tên "Lan" ở đây,
  // không phải để mặc định "Nhân vật 1" — Agent sẽ không biết "Lan" là ai nếu tên không khớp).
  const [storyPrimaryCharacterLabel, setStoryPrimaryCharacterLabel] = useState("");
  // Ảnh THẬT của 1 địa điểm (sân vườn, nhà, cửa hàng...) — tuỳ chọn, dùng chung cho cả job, để ảnh
  // phân cảnh AI vẽ diễn ra đúng tại khung cảnh thật đó thay vì AI tự bịa bối cảnh.
  const [storyLocationReference, setStoryLocationReference] = useState<string | null>(null);
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
  // "Model chat" — LLM thực thi bước chia cảnh (tách biệt với "Agent" = persona/hướng dẫn) — đúng 2
  // lựa chọn admin đang dùng cho app tự tạo dạng text (xem MODEL_OPTIONS trong app/admin/page.tsx).
  const STORY_MODEL_CHAT_OPTIONS = [
    { value: "google/gemini-3-flash-preview", label: "Gemini Flash" },
    { value: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet" },
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
  const [storyRunning, setStoryRunning] = useState(false);
  const [storyContinuing, setStoryContinuing] = useState(false);
  // 2 nút "Tạo ảnh phân cảnh" / "Viết mô tả chuyển động để tạo video" độc lập nhau, nhưng vẫn dùng
  // chung storyRunning để khoá nhau tránh chạy đè job (storyJobId/storyScenes dùng chung 1 chỗ) — cờ
  // này chỉ để nhãn nút hiện đúng "Đang xử lý..." trên nút khách vừa bấm, không hiện nhầm sang nút kia.
  const [storyActiveButton, setStoryActiveButton] = useState<"images" | "video" | null>(null);
  const [storyStatusText, setStoryStatusText] = useState<string | null>(null);
  const [storyStatus, setStoryStatus] = useState<string | null>(null);
  const [storyJobId, setStoryJobId] = useState<number | null>(null);
  const [storyScenes, setStoryScenes] = useState<
    { id: number; position: number; imageUrl: string | null; videoUrl: string | null }[] | null
  >(null);
  const [storyRegeneratingSceneId, setStoryRegeneratingSceneId] = useState<number | null>(null);
  const [storyRegeneratingVideoSceneId, setStoryRegeneratingVideoSceneId] = useState<number | null>(null);
  const [storyResult, setStoryResult] = useState<string | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const storyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storyCharacterPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyScenesPreviewRef = useRef<HTMLDivElement | null>(null);
  const storyResultRef = useRef<HTMLDivElement | null>(null);
  // Khối "Ảnh nhân vật" (điểm neo cuộn về lại khi đóng xem trước) + khối "Xem trước ảnh" dùng chung
  // đúng vị trí/kiểu hiển thị với khối kết quả Character thật (storyCharacterPreviewRef phía dưới) —
  // bấm ảnh nhỏ nào cũng phóng to ở ĐÚNG chỗ đó (không phải phóng to tại chỗ trong khung nhỏ), nên bấm
  // mới cần cuộn hẳn xuống khu vực khác, bấm đóng lại cuộn ngược lên khung "Ảnh nhân vật".
  const storyCharacterCardRef = useRef<HTMLDivElement | null>(null);
  const [storyQuickZoomUrl, setStoryQuickZoomUrl] = useState<string | null>(null);
  const storyQuickZoomRef = useRef<HTMLDivElement | null>(null);
  const storyQuickZoomWasOpenRef = useRef(false);

  // Tự động cuộn xuống khi Character/ảnh phân cảnh xong hoặc video hoàn tất — khách không phải cuộn
  // tay để xem kết quả.
  useEffect(() => {
    if (storyStatus === "character_ready") {
      storyCharacterPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyStatus === "images_ready") {
      storyScenesPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [storyStatus]);
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

  useEffect(() => {
    if (storyQuickZoomUrl) {
      storyQuickZoomRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (storyQuickZoomWasOpenRef.current) {
      storyCharacterCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    storyQuickZoomWasOpenRef.current = !!storyQuickZoomUrl;
  }, [storyQuickZoomUrl]);

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
    if (params.id !== "video-tu-y-tuong" || !user) return;
    loadSavedStoryCharacters(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, user?.id]);

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

  // "Thay trang phục": imageDataUrl dùng chung làm ảnh người mẫu, garmentImages là danh sách trang phục
  // tham chiếu riêng (tối đa 10) — kết quả trả về nhiều ảnh nên dùng state riêng, không dùng chung `result`.
  const [garmentImages, setGarmentImages] = useState<string[]>([]);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  // Loại trang phục cho từng ảnh — người dùng tự khai báo (không để AI đoán, hay bịa sai quần/váy
  // khi ảnh tham chiếu là cả bộ). Song song index với garmentImages, mặc định "tops" (chỉ áo).
  type GarmentCategory = "tops" | "one-pieces";
  const [garmentCategories, setGarmentCategories] = useState<GarmentCategory[]>([]);
  type OutfitSwapModel = {
    key: "generic" | "fashn" | "fashn_max";
    label: string;
    pricePerImage: number;
    hasPrompt: boolean;
    defaultPrompt?: string;
  };
  const [outfitSwapModels, setOutfitSwapModels] = useState<OutfitSwapModel[]>([]);
  const [outfitSwapModelChoice, setOutfitSwapModelChoice] = useState<"generic" | "fashn" | "fashn_max" | null>(null);
  const [outfitSwapResults, setOutfitSwapResults] = useState<string[] | null>(null);
  // URL thật (Storage) của ảnh người mẫu gốc sau khi upload — dùng làm "ảnh trước" khi nối sang
  // app "Video trước/sau" (imageDataUrl vẫn giữ base64 preview, không phù hợp nhét vào query string).
  const [outfitSwapModelImageUrl, setOutfitSwapModelImageUrl] = useState<string | null>(null);
  const [outfitSwapStatusText, setOutfitSwapStatusText] = useState<string | null>(null);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
      if (storyPollRef.current) clearInterval(storyPollRef.current);
    };
  }, []);

  // Đến từ nút "Tạo video từ ảnh này" ở app khác (vd outfit-swap) — ảnh đã là URL thật (fal.media/
  // fashn CDN), Kling nhận thẳng URL nên không cần upload lại, chỉ cần điền sẵn vào state có sẵn.
  useEffect(() => {
    if (app?.inputType === "video-gen") {
      const prefillUrl = searchParams.get("imageUrl");
      if (prefillUrl) setImageDataUrl(prefillUrl);
    }
    if (app?.inputType === "video-transform") {
      const startUrl = searchParams.get("startImageUrl");
      const endUrl = searchParams.get("endImageUrl");
      if (startUrl) setImageDataUrl(startUrl);
      if (endUrl) setEndFrameDataUrl(endUrl);
    }
  }, [app?.inputType, searchParams]);

  // Kiểm tra đã kết nối YouTube chưa (chỉ app tạo video mới cần) + đọc phản hồi từ trang
  // /api/youtube/callback redirect về (?youtube=connected|denied|error).
  useEffect(() => {
    if (app?.outputType !== "video" || !user) return;
    fetch(`/api/youtube/status?userId=${user.id}`)
      .then((res) => res.json())
      .then((data) => setYoutubeStatus(data))
      .catch(() => {});

    const youtubeParam = searchParams.get("youtube");
    if (youtubeParam === "denied") setYoutubeError("Anh đã từ chối cấp quyền YouTube.");
    if (youtubeParam === "error") setYoutubeError("Kết nối YouTube thất bại, thử lại.");
  }, [app?.outputType, user, searchParams]);

  // Danh sách nhạc nền (admin upload sẵn) để user chọn ghép vào video kết quả.
  useEffect(() => {
    if (app?.outputType !== "video") return;
    fetch("/api/background-music")
      .then((res) => res.json())
      .then((data) => setMusicTracks(data.tracks ?? []))
      .catch(() => {});
  }, [app?.outputType]);

  // Tự khôi phục job video gần nhất khi khách quay lại trang (đóng tab/tắt máy giữa chừng rồi mở
  // lại) — tránh mất kết quả đã tạo xong hoặc phải chờ lại từ đầu nếu vẫn đang xử lý. Bỏ qua nếu
  // đến từ nút "Tạo video từ ảnh này" (?imageUrl=) vì đó là ý định tạo video MỚI, không phải tiếp tục.
  useEffect(() => {
    if (app?.outputType !== "video" || !user || !app) return;
    if (searchParams.get("imageUrl")) return;
    fetch(`/api/video/latest?userId=${user.id}&miniAppId=${app.id}`)
      .then((res) => res.json())
      .then((data) => {
        const job = data.job;
        if (!job) return;
        setCurrentVideoJobId(job.id);
        if (job.status === "done" && job.outputUrl) {
          setResult(job.outputUrl);
        } else if (job.status === "pending" || job.status === "processing") {
          setIsRunning(true);
          setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
          pollVideoStatus(job.id);
        }
      })
      .catch(() => {});
  }, [app, user, searchParams]);

  async function handleAddMusic() {
    if (!user || !currentVideoJobId) return;
    if (musicMode === "library" && !selectedTrackId) return;
    if (musicMode === "upload" && !customAudioDataUrl) return;
    setAddingMusic(true);
    setMusicAddError(null);
    setMusicAddedSuccess(false);
    try {
      const res = await fetch("/api/video/add-music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: currentVideoJobId,
          trackId: musicMode === "library" ? selectedTrackId : undefined,
          customAudioDataUrl: musicMode === "upload" ? customAudioDataUrl : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMusicAddError(data.error ?? "Không ghép được nhạc");
        return;
      }
      setResult(data.url);
      setMusicAddedSuccess(true);
    } catch {
      setMusicAddError("Không kết nối được tới server");
    } finally {
      setAddingMusic(false);
    }
  }

  useEffect(() => {
    if (params.id === "thay-trang-phuc") {
      fetch("/api/outfit-swap")
        .then((res) => res.json())
        .then((data) => {
          const models: OutfitSwapModel[] = data.models ?? [];
          setOutfitSwapModels(models);
          // Mặc định FASHN nếu có bật, không thì lấy model còn lại đang bật
          const fashn = models.find((m) => m.key === "fashn");
          const defaultModel = fashn ?? models[0];
          setOutfitSwapModelChoice(defaultModel?.key ?? null);
          if (defaultModel?.defaultPrompt) setInput(defaultModel.defaultPrompt);
        })
        .catch(() => {});
    }
  }, [params.id]);

  // "Video đồng nhất nhân vật": giá tăng theo số nhân vật (2-4 người) — tính lại mỗi khi thêm/bớt.
  useEffect(() => {
    if (params.id !== "video-doi-thoai-nhan-vat") return;
    fetch(`/api/dialogue-video/price?miniAppId=${params.id}&characterCount=${dialogueCharacters.length}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.creditCost === "number") setDialogueCreditCost(data.creditCost);
      })
      .catch(() => {});
  }, [params.id, dialogueCharacters.length]);

  // "Video từ ý tưởng truyện": tải danh sách model ảnh/video từ catalog 1 lần khi vào trang, chọn sẵn
  // model đầu tiên mỗi loại.
  useEffect(() => {
    if (params.id !== "video-tu-y-tuong") return;
    fetch(`/api/story-video/models?miniAppId=${params.id}`)
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
      })
      .catch(() => {});
  }, [params.id]);

  // Từ 2 nhân vật trở lên bắt buộc dùng model hỗ trợ nhiều ảnh tham chiếu (multi_image) — đã kiểm
  // chứng qua test thật chỉ loại model này ghép được nhiều người vào 1 cảnh. Tự chuyển sang model
  // multi_image đầu tiên nếu model đang chọn không hỗ trợ, tránh khách bấm chạy rồi mới bị lỗi. Ảnh
  // Bối cảnh/Địa điểm cũng cần multi_image (thêm 1 ảnh tham chiếu nữa) nên dùng chung điều kiện.
  useEffect(() => {
    if (storyExtraCharacters.length === 0 && !storyLocationReference) return;
    const current = storyImageModels.find((m) => m.key === storyImageModelKey);
    if (current && !current.multi_image) {
      const fallback = storyImageModels.find((m) => m.multi_image);
      if (fallback) setStoryImageModelKey(fallback.key);
    }
  }, [storyExtraCharacters.length, storyLocationReference, storyImageModels, storyImageModelKey]);

  // "Video từ ý tưởng truyện": tự khôi phục job gần nhất còn dở dang khi khách quay lại trang (đóng
  // tab/tắt máy giữa chừng) — trước đây mọi tiến trình chỉ nằm trong state trình duyệt nên tắt đi là
  // mất, dù job vẫn đang chạy/đã hoàn thành phía server. Bao gồm cả "failed" vì job này có 2 lượt trừ
  // credit riêng (ảnh/video) — lỗi ở bước video không có nghĩa ảnh đã tạo (đã trả tiền) cũng mất theo.
  useEffect(() => {
    if (params.id !== "video-tu-y-tuong" || !user || storyJobId) return;
    fetch(`/api/story-video/active?userId=${user.id}`)
      .then((res) => res.json())
      .then(async (data) => {
        const job = data.job;
        if (!job) return;
        setStoryJobId(job.id);
        if (job.storyDescription) setInput(job.storyDescription);
        if (Array.isArray(job.characterImageUrls) && job.characterImageUrls.length > 0) {
          setStoryCharacterImages(job.characterImageUrls);
        }
        if (job.locationReferenceUrl) setStoryLocationReference(job.locationReferenceUrl);
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
          } else if (statusData.status === "failed") {
            setStoryError(statusData.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
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
  }, [params.id, user?.id]);

  // "Video từ ý tưởng truyện": giá tăng theo số phân cảnh (2-8) + model/tỉ lệ/độ phân giải/thời
  // lượng đã chọn — tính lại mỗi khi đổi.
  useEffect(() => {
    if (params.id !== "video-tu-y-tuong" || !storyImageModelKey || !storyVideoModelKey) return;
    const params2 = new URLSearchParams({
      miniAppId: params.id,
      numScenes: String(numScenes),
      imageModelKey: storyImageModelKey,
      videoModelKey: storyVideoModelKey,
    });
    if (storyResolutionKey) params2.set("resolutionKey", storyResolutionKey);
    if (storyDurationKey) params2.set("durationKey", storyDurationKey);
    fetch(`/api/story-video/price?${params2.toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.imageCost === "number") setStoryImageCost(data.imageCost);
        if (typeof data.videoCost === "number") setStoryVideoCost(data.videoCost);
        if (typeof data.characterCost === "number") setStoryCharacterCost(data.characterCost);
      })
      .catch(() => {});
  }, [params.id, numScenes, storyImageModelKey, storyVideoModelKey, storyResolutionKey, storyDurationKey]);

  // Ảnh/video có giá tính động theo chi phí thật + biên lợi nhuận, khác app text (giá cố định)
  useEffect(() => {
    if (params.id) {
      fetch(`/api/mini-app/${params.id}/price`)
        .then((res) => res.json())
        .then((data) => {
          if (data.dynamic) setLiveCreditCost(data.creditCost);
          // Prompt mặc định admin soạn sẵn (nếu có) — chỉ điền khi khách chưa tự gõ gì, vẫn sửa/xoá được.
          if (data.defaultPrompt) setInput((prev) => prev || data.defaultPrompt);
        })
        .catch(() => {});
    }
  }, [params.id]);

  // App có nhiều tier chất lượng (hiện chỉ "Tạo video quảng cáo ngắn") — app khác trả mảng rỗng.
  useEffect(() => {
    if (params.id) {
      fetch(`/api/video/tiers?miniAppId=${params.id}`)
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data.tiers)) setVideoTiers(data.tiers);
        })
        .catch(() => {});
    }
  }, [params.id]);

  if (!app) {
    return <CommunityMiniAppRunner miniAppId={params.id} />;
  }

  const relatedApps = MINI_APPS.filter(
    (item) => item.category === app.category && item.id !== app.id
  ).slice(0, 3);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    // "Thay trang phục" upload ảnh này lên Storage riêng trước khi chạy (xem handleRunOutfitSwap) —
    // cap 3MB thay vì 4MB vì base64 encode phình ~33%, 1 ảnh 4MB có thể tự vượt giới hạn request của Vercel.
    const maxBytes = app?.inputType === "outfit-swap" ? 3 * 1024 * 1024 : 4 * 1024 * 1024;
    if (file.size > maxBytes) {
      setImageError(
        app?.inputType === "outfit-swap"
          ? "Ảnh tối đa 3MB, anh chọn ảnh nhỏ hơn giúp em nhé"
          : "Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé"
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleGarmentFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setGarmentError(null);
    const remainingSlots = 10 - garmentImages.length;
    if (remainingSlots <= 0) {
      setGarmentError("Tối đa 10 ảnh trang phục");
      return;
    }

    const filesToAdd = files.slice(0, remainingSlots);
    filesToAdd.forEach((file) => {
      if (!file.type.startsWith("image/")) {
        setGarmentError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
        return;
      }
      if (file.size > 3 * 1024 * 1024) {
        setGarmentError("Mỗi ảnh tối đa 3MB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setGarmentImages((prev) => [...prev, reader.result as string]);
        setGarmentCategories((prev) => [...prev, "tops"]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeGarmentImage(index: number) {
    setGarmentImages((prev) => prev.filter((_, i) => i !== index));
    setGarmentCategories((prev) => prev.filter((_, i) => i !== index));
  }

  function setGarmentCategoryAt(index: number, category: GarmentCategory) {
    setGarmentCategories((prev) => prev.map((c, i) => (i === index ? category : c)));
  }

  function pollOutfitSwapStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults(data.outputs);
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Thay trang phục thất bại, credit đã được hoàn");
          setIsRunning(false);
          setOutfitSwapStatusText(null);
        } else {
          setOutfitSwapStatusText(`Đang xử lý ${data.doneCount}/${data.totalItems} bộ đồ...`);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
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

  function handleCharFileChange(e: React.ChangeEvent<HTMLInputElement>, index: number) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, error: "Chỉ nhận file ảnh (JPG, PNG, WEBP...)" } : c)));
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, error: "Ảnh tối đa 3MB" } : c)));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, image: dataUrl, error: null } : c)));
    };
    reader.readAsDataURL(file);
  }

  function addDialogueCharacter() {
    setDialogueCharacters((prev) => (prev.length >= DIALOGUE_MAX_CHARACTERS ? prev : [...prev, { image: null, error: null, line: "" }]));
  }

  function removeDialogueCharacter(index: number) {
    setDialogueCharacters((prev) => (prev.length <= DIALOGUE_MIN_CHARACTERS ? prev : prev.filter((_, i) => i !== index)));
  }

  function setDialogueLine(index: number, line: string) {
    setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, line } : c)));
  }

  function pollDialogueVideoStatus(jobId: number) {
    dialoguePollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/dialogue-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
          setDialogueResult(data.outputUrl);
          setDialogueRunning(false);
          setDialogueStatusText(null);
        } else if (data.status === "failed") {
          if (dialoguePollRef.current) clearInterval(dialoguePollRef.current);
          setDialogueError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setDialogueRunning(false);
          setDialogueStatusText(null);
        } else if (data.statusText) {
          setDialogueStatusText(data.statusText);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunDialogueVideo() {
    if (!user || dialogueCharacters.some((c) => !c.image || !c.line.trim())) return;
    setDialogueRunning(true);
    setDialogueResult(null);
    setDialogueError(null);
    setDialogueStatusText("Đang tải ảnh lên...");

    let imageUrls: string[];
    try {
      imageUrls = await Promise.all(dialogueCharacters.map((c) => uploadOutfitSwapImage(c.image!)));
    } catch (err) {
      setDialogueError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setDialogueRunning(false);
      setDialogueStatusText(null);
      return;
    }

    setDialogueStatusText("Đang gửi yêu cầu...");

    try {
      const res = await fetch("/api/dialogue-video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          miniAppId: app!.id,
          characters: dialogueCharacters.map((c, index) => ({ imageUrl: imageUrls[index], line: c.line.trim() })),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setDialogueError(data.error ?? "Có lỗi xảy ra");
        setDialogueRunning(false);
        setDialogueStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setDialogueStatusText(
        `Đang tạo chuyển động cho ${dialogueCharacters.length} nhân vật, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...`
      );
      pollDialogueVideoStatus(data.jobId);
    } catch {
      setDialogueError("Không kết nối được tới server");
      setDialogueRunning(false);
      setDialogueStatusText(null);
    }
  }

  function pollStoryVideoStatus(jobId: number) {
    storyPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/story-video/status?jobId=${jobId}`);
        const data = await res.json();

        if (Array.isArray(data.scenes)) setStoryScenes(data.scenes);
        setStoryStatus(data.status ?? null);
        if (data.characterSheetUrl) setStoryCharacterSheetUrl(data.characterSheetUrl);
        if (data.characterSource) setStoryCharacterSource(data.characterSource);
        setStoryJobCharacters(Array.isArray(data.characters) ? data.characters : null);
        if (data.locationReferenceUrl) setStoryLocationReference(data.locationReferenceUrl);

        if (data.status === "done" && data.outputUrl) {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryResult(data.outputUrl);
          setStoryRunning(false);
          setStoryStatusText(null);
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
        } else if (data.status === "failed") {
          if (storyPollRef.current) clearInterval(storyPollRef.current);
          setStoryError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
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

  async function handleRegenerateSceneVideo(sceneId: number) {
    if (!user || !storyJobId) return;
    setStoryRegeneratingVideoSceneId(sceneId);
    setStoryError(null);
    try {
      const res = await fetch("/api/story-video/regenerate-scene-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, sceneId }),
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
      window.dispatchEvent(new Event("balance-updated"));
      setStoryContinuingScenes(false);
      setStoryRunning(true);
      setStoryStatusText(`Đang tạo ảnh cho ${numScenes} phân cảnh...`);
      pollStoryVideoStatus(storyJobId);
    } catch {
      setStoryError("Không kết nối được tới server");
      setStoryContinuingScenes(false);
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

  async function handleRunStoryVideo() {
    const images = storyCharacterImages;
    const reuseId = storySelectedSavedCharacterId;
    // Bước này thường chỉ tạo Character, chưa cần Ý tưởng truyện — thứ đó bắt buộc ở bước "Tiếp tục
    // chia cảnh" sau. NGOẠI LỆ: khi dùng Character đã lưu từ thư viện (biết chắc 100%, không cần AI
    // kiểm tra lại), server sẽ chạy thẳng 1 lượt luôn tới chia cảnh nếu đã có Ý tưởng truyện — nên bắt
    // buộc nhập trước ở đây để chắc chắn kích hoạt được đường tắt đó (ảnh thường vẫn không cần, vì
    // server không biết trước có phải toàn bộ ảnh đã là sheet hay không).
    const hasMultipleCharacters = storyExtraCharacters.length > 0;
    if (!user || (!reuseId && images.length === 0) || !storyImageModelKey || !storyVideoModelKey) return;
    if (reuseId && !input.trim()) return;
    if (hasMultipleCharacters && storyExtraCharacters.some((s) => !s.reuseId && s.images.length === 0)) {
      setStoryError("Có nhân vật chưa tải ảnh — xoá bớt hoặc tải ảnh cho đủ trước khi chạy");
      return;
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
    if (!reuseId) {
      setStoryStatusText("Đang tải ảnh lên...");
      try {
        // Ảnh đã có URL thật (vd job dở dang được khôi phục) thì dùng thẳng, chỉ upload ảnh base64 mới.
        characterImageUrls = await Promise.all(images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img))));
      } catch (err) {
        setStoryError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }
    }

    // Job nhiều nhân vật — tải thêm ảnh của từng nhân vật phụ (#2, #3, #4) lên, gộp cùng nhân vật #1
    // thành mảng "characters" gửi server. Không đụng gì tới nhánh 1-nhân-vật ở dưới nếu không có ai thêm.
    let characters:
      | { imageUrls: string[]; reuseCharacterId?: number; skipCharacterCreation?: boolean; label?: string }[]
      | undefined;
    if (hasMultipleCharacters) {
      setStoryStatusText("Đang tải ảnh nhân vật lên...");
      try {
        const extraUploaded = await Promise.all(
          storyExtraCharacters.map(async (slot) => ({
            imageUrls: slot.reuseId
              ? []
              : await Promise.all(slot.images.map((img) => (img.startsWith("http") ? img : uploadOutfitSwapImage(img)))),
            reuseCharacterId: slot.reuseId ?? undefined,
            label: slot.label.trim() || undefined,
          }))
        );
        characters = [
          {
            imageUrls: reuseId ? [] : characterImageUrls,
            reuseCharacterId: reuseId ?? undefined,
            skipCharacterCreation: !reuseId && storySkipCharacterCreation,
            label: storyPrimaryCharacterLabel.trim() || undefined,
          },
          ...extraUploaded,
        ];
      } catch (err) {
        setStoryError(err instanceof Error ? err.message : "Không tải được ảnh nhân vật lên, thử lại");
        setStoryRunning(false);
        setStoryStatusText(null);
        return;
      }
    }

    // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — tải lên nếu là ảnh mới (base64), dùng
    // thẳng nếu đã là URL thật (job khôi phục dở dang).
    let locationReferenceUrl: string | undefined;
    if (storyLocationReference) {
      try {
        locationReferenceUrl = storyLocationReference.startsWith("http")
          ? storyLocationReference
          : await uploadOutfitSwapImage(storyLocationReference);
      } catch (err) {
        setStoryError(err instanceof Error ? err.message : "Không tải được ảnh địa điểm lên, thử lại");
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
          numScenes,
          characterImageUrls,
          imageModelKey: storyImageModelKey,
          videoModelKey: storyVideoModelKey,
          autoVideo: storyAutoVideo,
          aspectRatio: storyAspectRatio,
          resolutionKey: storyResolutionKey,
          durationKey: storyDurationKey,
          modelChatKey: storyModelChatKey,
          reuseCharacterId: reuseId ?? undefined,
          skipCharacterCreation: !reuseId && storySkipCharacterCreation,
          genreKey: storyGenreKey !== "default" ? storyGenreKey : undefined,
          characters,
          locationReferenceUrl,
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

  async function handleRunOutfitSwap() {
    if (!user || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice) return;
    setIsRunning(true);
    setOutfitSwapResults(null);
    setRunError(null);
    setOutfitSwapStatusText("Đang tải ảnh lên...");

    // Upload từng ảnh lên Storage TRƯỚC — gửi thẳng base64 gộp 6-7 ảnh trong 1 request chạy AI dễ
    // vượt giới hạn ~4.5MB/request của Vercel, bị chặn 413 (đã xảy ra thật, lặp lại liên tục).
    // Chưa trừ credit ở bước này nên lỗi ở đây luôn an toàn để bấm thử lại.
    let modelImageUrl: string;
    let garmentImageUrls: string[];
    try {
      [modelImageUrl, ...garmentImageUrls] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        ...garmentImages.map(uploadOutfitSwapImage),
      ]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Không tải được ảnh lên, thử lại");
      setIsRunning(false);
      setOutfitSwapStatusText(null);
      return;
    }
    setOutfitSwapModelImageUrl(modelImageUrl);

    setOutfitSwapStatusText("Đang gửi yêu cầu...");

    try {
      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: garmentImageUrls,
          garmentCategories: garmentCategories,
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setOutfitSwapStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setOutfitSwapStatusText(
        `Đang xử lý ${garmentImages.length} bộ đồ, có thể mất khoảng 1-2 phút — anh có thể rời trang, quay lại vẫn thấy kết quả...`
      );
      pollOutfitSwapStatus(data.jobId);
    } catch {
      // Server có thể đã submit job xong (và trừ credit) nhưng phản hồi bị rớt mạng trước khi về
      // tới trình duyệt — không chắc chắn là lượt chạy thất bại, nên không giục chạy lại ngay kẻo
      // bị trừ credit 2 lần cho cùng 1 lượt.
      setRunError(
        "Mất kết nối khi nhận phản hồi từ server. Lượt chạy có thể đã thực hiện thành công — anh kiểm tra /wallet → \"Lịch sử kết quả\" trước khi bấm chạy lại."
      );
      setIsRunning(false);
      setOutfitSwapStatusText(null);
    }
  }

  // Chạy lại riêng 1 ảnh kết quả sai — thay vì bắt chạy lại nguyên cả lượt (tốn thêm credit cho cả
  // những ảnh vốn đã đúng). AI đôi khi ra sai ngẫu nhiên trên cùng 1 ảnh đầu vào, chạy lại có thể ra kết quả khác.
  function pollRetryOutfitSwapStatus(jobId: number, index: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/outfit-swap/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputs?.[0]) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setOutfitSwapResults((prev) => {
            if (!prev) return prev;
            const next = [...prev];
            next[index] = data.outputs[0];
            return next;
          });
          setRetryingIndex(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Chạy lại thất bại, credit đã được hoàn");
          setRetryingIndex(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRetryOutfitSwapItem(index: number) {
    if (!user || !imageDataUrl || !outfitSwapModelChoice || retryingIndex !== null) return;
    const garmentDataUrl = garmentImages[index];
    if (!garmentDataUrl) return;

    setRetryingIndex(index);
    setRunError(null);

    try {
      const [modelImageUrl, garmentImageUrl] = await Promise.all([
        uploadOutfitSwapImage(imageDataUrl),
        uploadOutfitSwapImage(garmentDataUrl),
      ]);

      const res = await fetch("/api/outfit-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          modelImageDataUrl: modelImageUrl,
          garmentImageDataUrls: [garmentImageUrl],
          garmentCategories: [garmentCategories[index] ?? "tops"],
          modelChoice: outfitSwapModelChoice,
          prompt: input,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setRetryingIndex(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      pollRetryOutfitSwapStatus(data.jobId, index);
    } catch {
      setRunError("Không tải được ảnh lên, thử lại");
      setRetryingIndex(null);
    }
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, anh chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleTextFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setTextFileError(null);
    if (!file.type.startsWith("text/") && !file.name.toLowerCase().endsWith(".txt")) {
      setTextFileError("Chỉ nhận file .txt");
      return;
    }
    if (file.size > 1 * 1024 * 1024) {
      setTextFileError("File tối đa 1MB, anh chọn file nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setInput(reader.result as string);
    reader.readAsText(file);
  }

  async function handleRun() {
    if (!user) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${app!.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, userId: user.id, imageDataUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.output);
      window.dispatchEvent(new Event("balance-updated"));
    } catch {
      setRunError("Không kết nối được tới server");
    } finally {
      setIsRunning(false);
    }
  }

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !app) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
          duration: videoTiers.length > 0 ? selectedVideoDuration : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handleReferenceVideoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;

    setEndFrameError(null);
    if (!file.type.startsWith("video/")) {
      setEndFrameError("Chỉ nhận file video (MP4, MOV...)");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setEndFrameError("Video mẫu tối đa 15MB, anh chọn clip ngắn hơn giúp em nhé");
      return;
    }

    setUploadingReferenceVideo(true);
    try {
      const ext = file.name.split(".").pop() || "mp4";
      const filePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabaseBrowser.storage
        .from("motion-transfer-uploads")
        .upload(filePath, file, { contentType: file.type, upsert: true });
      if (uploadError) {
        setEndFrameError(uploadError.message);
        return;
      }
      const { data } = supabaseBrowser.storage.from("motion-transfer-uploads").getPublicUrl(filePath);
      setEndFrameDataUrl(data.publicUrl);
    } catch {
      setEndFrameError("Không tải được video lên, thử lại giúp em");
    } finally {
      setUploadingReferenceVideo(false);
    }
  }

  async function handleRunMotionTransfer() {
    if (!user || !app) return;
    if (!imageDataUrl) {
      setImageError("Anh tải ảnh nhân vật lên giúp em");
      return;
    }
    if (!endFrameDataUrl) {
      setEndFrameError("Anh tải video mẫu chuyển động lên giúp em");
      return;
    }

    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          prompt: "Nhảy theo video mẫu",
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handleRunVideoTransform() {
    if (!user || !app) return;
    if (!imageDataUrl) {
      setImageError("Anh tải ảnh \"trước\" lên giúp em");
      return;
    }
    if (!endFrameDataUrl) {
      setEndFrameError("Anh tải ảnh \"sau\" lên giúp em");
      return;
    }

    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: app.id,
          userId: user.id,
          // Không bắt buộc khách gõ mô tả cho app này — nếu để trống, dùng câu mặc định vì
          // /api/video/submit yêu cầu prompt khác rỗng.
          prompt: input.trim() || "Chuyển cảnh mượt mà từ ảnh đầu sang ảnh cuối, ánh sáng giữ nguyên tự nhiên.",
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
          modelChoice: videoTiers.length > 0 ? selectedVideoTier : undefined,
          duration: videoTiers.length > 0 ? selectedVideoDuration : undefined,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  async function handlePublishYoutube() {
    if (!user || !result || !youtubeTitle.trim()) return;
    setYoutubePublishing(true);
    setYoutubeError(null);
    try {
      const res = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, videoUrl: result, title: youtubeTitle, description: youtubeDescription }),
      });
      const data = await res.json();
      if (!res.ok) {
        setYoutubeError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setYoutubePublishedUrl(data.youtubeUrl);
      setShowYoutubeForm(false);
    } catch {
      setYoutubeError("Không kết nối được tới server");
    } finally {
      setYoutubePublishing(false);
    }
  }

  // Bố cục 2 cột (input trái/kết quả phải, tên app trên header) — thí điểm ở "Tạo video từ ảnh",
  // giờ áp dụng thêm cho 2 app video khác có input đơn giản tương tự (ảnh + mô tả/tier), và
  // "Thay trang phục" (nhiều ảnh trang phục + 1 ảnh người mẫu, kết quả nhiều ảnh — outfitSwapResults).
  // Không áp dụng "Video đồng nhất nhân vật" — UI app đó là danh sách nhân vật động, khác cấu trúc.
  const isTwoColumnLayout = ["video-gen", "video-transform", "motion-transfer", "outfit-swap"].includes(app.inputType);
  // "story-video" có bố cục 2 cột RIÊNG bên trong khối "Thử ngay" (trái: ảnh nhân vật/Agent/mô tả,
  // phải: Cấu hình media) — không dùng chung hệ thống isTwoColumnLayout (vốn là input|kết quả),
  // chỉ mượn cùng độ rộng khung trang để đủ chỗ cho 2 cột.
  const isWideLayout = isTwoColumnLayout || app.inputType === "story-video";

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className={`mx-auto flex items-center justify-between px-6 py-4 ${isWideLayout ? "max-w-6xl" : "max-w-3xl"}`}>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
              ← Quay lại Danh mục
            </Link>
            {isTwoColumnLayout && (
              <span className="hidden text-base font-semibold text-zinc-900 dark:text-zinc-50 sm:inline">
                {app.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main
        className={`mx-auto px-6 ${
          isWideLayout ? "max-w-6xl pt-4 pb-10" : "max-w-3xl py-10"
        } ${app.inputType === "story-video" ? "pb-24" : ""}`}
      >
        {/* Header Mini App — bỏ badge Danh mục/Hot/Mới riêng cho các app video dùng bố cục 2 cột, tên
            app đã chuyển lên thanh Header phía trên rồi nên không cần lặp lại gì ở đây nữa. */}
        {!isTwoColumnLayout && app.inputType !== "story-video" && (
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {CATEGORIES[app.category]}
            </span>
            {app.popular && (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                Hot
              </span>
            )}
            {app.isNew && (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                Mới
              </span>
            )}
          </div>
        )}
        {!isTwoColumnLayout && (
          <>
            <div className={`flex items-center justify-between ${app.inputType === "story-video" ? "mb-4" : "mb-2"}`}>
              <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{app.name}</h1>
              {app.inputType === "story-video" && (
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
              )}
            </div>
            {app.inputType !== "story-video" && (
              <>
                <p className="mb-4 text-zinc-600 dark:text-zinc-400">{app.description}</p>
                <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
                  <span>⭐ {app.rating}/5</span>
                  <span>{app.usageCount.toLocaleString("vi-VN")} lượt đã chạy</span>
                </div>
              </>
            )}
          </>
        )}

        {/* Demo input/output mẫu — Tập 5 mục 1.2: cần thấy ví dụ thật trước khi bỏ credit ra thử.
            Bỏ riêng cho "thay-trang-phuc" — card trang chủ đã có ảnh minh hoạ trực quan hơn rồi, mục
            text ở đây thành thừa/rối cho app này (các app khác vẫn giữ). "video-gen" cũng bỏ theo
            yêu cầu — giao diện app video giờ đã đủ rõ ràng, phần ví dụ text làm rối thêm. */}
        {app.inputType !== "outfit-swap" &&
          app.inputType !== "video-gen" &&
          app.inputType !== "motion-transfer" &&
          app.inputType !== "video-transform" &&
          app.inputType !== "story-video" && (
          <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Ví dụ minh hoạ
            </h2>
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Input mẫu</p>
              <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {app.demoInput}
              </p>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả AI trả về</p>
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-300">
                {app.demoOutput}
              </p>
            </div>
          </section>
        )}

        {/* Khu vực nhập input thật + chạy */}
        <section
          className={`mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 ${
            app.inputType === "story-video" ? "story-video-theme" : ""
          }`}
        >
          {app.inputType !== "story-video" && (
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Thử ngay
            </h2>
          )}
          {/* Bố cục 2 cột (trái = input, phải = kết quả) cho các app video đơn giản (ảnh + mô tả/tier)
              — app khác vẫn giữ nguyên 1 cột như trước, 2 div dưới đây chỉ là wrapper vô hại khi
              không phải grid. */}
          <div className={isTwoColumnLayout ? "grid grid-cols-1 gap-6 lg:grid-cols-2" : undefined}>
          <div className={isTwoColumnLayout ? "flex h-full flex-col" : undefined}>
          {app.inputType !== "outfit-swap" && app.inputType !== "dialogue-video" && app.inputType !== "story-video" && (
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {app.inputLabel}
            </label>
          )}

          {app.inputType === "image" ? (
            <div className="mb-4">
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để chọn ảnh sản phẩm
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : app.inputType === "image-gen" ? (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={3}
                className="mb-3 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Ảnh sản phẩm tham chiếu (không bắt buộc)
              </p>
              {imageDataUrl ? (
                <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageDataUrl}
                    alt="Ảnh sản phẩm tham chiếu đã chọn"
                    className="h-20 w-20 rounded-md object-cover"
                  />
                  <button
                    onClick={() => setImageDataUrl(null)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Xóa ảnh
                  </button>
                </div>
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                  <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Bấm để tải ảnh sản phẩm thật (tuỳ chọn)
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                  <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                </label>
              )}
              {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
            </div>
          ) : app.inputType === "video-gen" ? (
            <div className="mb-4">
              <div className="mb-4 mx-auto max-w-xs">
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh nhân vật (không bắt buộc)</p>
                {imageDataUrl ? (
                  <div className="relative aspect-square w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageDataUrl} alt="Ảnh nhân vật" className="h-full w-full rounded-lg object-cover" />
                    <button
                      onClick={() => setImageDataUrl(null)}
                      className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                    >
                      Xóa
                    </button>
                  </div>
                ) : (
                  <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                )}
                {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
              </div>

              {videoTiers.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} —{" "}
                        {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                    if (!tier?.creditCostByDuration) return null;
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Độ dài video:</p>
                        {Object.keys(tier.creditCostByDuration).map((d) => (
                          <button
                            key={d}
                            onClick={() => setSelectedVideoDuration(d)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              selectedVideoDuration === d
                                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {d} giây — {tier.creditCostByDuration![d]} credit
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              <div className="mb-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Không biết viết mô tả? Gõ gợi ý ngắn, để AI viết giúp
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={promptHint}
                    onChange={(e) => setPromptHint(e.target.value)}
                    placeholder="Ví dụ: video selfie tự nhiên, đang chải tóc"
                    maxLength={300}
                    className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                  <button
                    onClick={handleGeneratePrompt}
                    disabled={generatingPrompt || !promptHint.trim()}
                    className="shrink-0 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    {generatingPrompt ? "Đang viết..." : "✨ AI viết giúp mô tả"}
                  </button>
                </div>
                {promptGenError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{promptGenError}</p>}
              </div>

              <p className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Câu lệnh mô tả (có thể chỉnh sửa)</p>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
                maxLength={VIDEO_PROMPT_MAX_LENGTH}
                className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p
                className={`text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            </div>
          ) : app.inputType === "video-transform" ? (
            <div className="mb-4">
              <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh trước</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh trước" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh sau</p>
                  {endFrameDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh sau" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>

              {videoTiers.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} —{" "}
                        {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                    if (!tier?.creditCostByDuration) return null;
                    return (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Độ dài video:</p>
                        {Object.keys(tier.creditCostByDuration).map((d) => (
                          <button
                            key={d}
                            onClick={() => setSelectedVideoDuration(d)}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              selectedVideoDuration === d
                                ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                            }`}
                          >
                            {d} giây — {tier.creditCostByDuration![d]} credit
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              <p className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Câu lệnh mô tả (không bắt buộc)</p>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ví dụ: chuyển cảnh mượt mà, ánh sáng giữ nguyên tự nhiên"
                rows={3}
                maxLength={VIDEO_PROMPT_MAX_LENGTH}
                className="mb-1 w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <p
                className={`text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            </div>
          ) : app.inputType === "motion-transfer" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh nhân vật</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh nhân vật" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Video mẫu chuyển động</p>
                  {uploadingReferenceVideo ? (
                    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="text-sm text-zinc-500 dark:text-zinc-400">Đang tải video lên...</span>
                    </div>
                  ) : endFrameDataUrl ? (
                    <div className="relative aspect-square w-full">
                      <video src={endFrameDataUrl} controls className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải video</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">MP4, MOV — tối đa 15MB</span>
                      <input type="file" accept="video/*" onChange={handleReferenceVideoFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
                </div>
              </div>

              {videoTiers.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Chất lượng video</p>
                  <div className="flex flex-wrap gap-2">
                    {videoTiers.map((tier) => (
                      <button
                        key={tier.key}
                        onClick={() => {
                          setSelectedVideoTier(tier.key);
                          if (tier.creditCostByDuration) {
                            setSelectedVideoDuration(Object.keys(tier.creditCostByDuration)[0]);
                          }
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                          selectedVideoTier === tier.key
                            ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                            : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        }`}
                      >
                        {tier.label} — {tier.creditCostByDuration ? "từ " : ""}
                        {tierDisplayCost(tier) ?? "?"} credit
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : app.inputType === "outfit-swap" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Ảnh trang phục tham chiếu (tối đa 10)
                  </p>
                  {garmentImages.length > 0 && (
                    <div className="mb-2 grid grid-cols-3 gap-2">
                      {garmentImages.map((url, index) => (
                        <div key={index}>
                          <div className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt={`Trang phục ${index + 1}`} className="aspect-square w-full rounded-md object-cover" />
                            <button
                              onClick={() => removeGarmentImage(index)}
                              aria-label="Xoá ảnh"
                              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                            >
                              ×
                            </button>
                          </div>
                          <div className="mt-1 flex gap-0.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => setGarmentCategoryAt(index, "tops")}
                              className={`flex-1 rounded px-1 py-0.5 font-medium ${
                                (garmentCategories[index] ?? "tops") === "tops"
                                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                              }`}
                            >
                              Áo
                            </button>
                            <button
                              type="button"
                              onClick={() => setGarmentCategoryAt(index, "one-pieces")}
                              className={`flex-1 rounded px-1 py-0.5 font-medium ${
                                garmentCategories[index] === "one-pieces"
                                  ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"
                              }`}
                            >
                              Cả bộ
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {garmentImages.length < 10 && (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                        Bấm để thêm ảnh trang phục ({garmentImages.length}/10)
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — mỗi ảnh tối đa 3MB</span>
                      <input type="file" accept="image/*" multiple onChange={handleGarmentFilesChange} className="hidden" />
                    </label>
                  )}
                  {garmentError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{garmentError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh người mẫu</p>
                  {imageDataUrl ? (
                    <div className="relative aspect-square w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh người mẫu" className="h-full w-full rounded-lg object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        aria-label="Xoá ảnh"
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh người mẫu</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
              </div>

              {outfitSwapModels.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {outfitSwapModels.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setOutfitSwapModelChoice(m.key)}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                        outfitSwapModelChoice === m.key
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                          : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                      }`}
                    >
                      {m.label} — {m.pricePerImage} credit/ảnh
                    </button>
                  ))}
                </div>
              )}

              {outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.hasPrompt && (
                <>
                  <p className="mb-1 mt-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">{app.inputLabel}</p>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                  />
                </>
              )}
            </div>
          ) : app.inputType === "dialogue-video" ? (
            <div className="mb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {dialogueCharacters.map((character, index) => (
                  <div key={index}>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Nhân vật {String.fromCharCode(65 + index)}</p>
                      {dialogueCharacters.length > DIALOGUE_MIN_CHARACTERS && (
                        <button
                          onClick={() => removeDialogueCharacter(index)}
                          className="text-xs text-zinc-400 underline hover:text-red-600 dark:text-zinc-500 dark:hover:text-red-400"
                        >
                          Xoá nhân vật
                        </button>
                      )}
                    </div>
                    {character.image ? (
                      <div className="relative aspect-square w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={character.image}
                          alt={`Nhân vật ${String.fromCharCode(65 + index)}`}
                          className="h-full w-full rounded-lg object-cover"
                        />
                        <button
                          onClick={() =>
                            setDialogueCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, image: null } : c)))
                          }
                          className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white hover:bg-black/80"
                        >
                          Xóa
                        </button>
                      </div>
                    ) : (
                      <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-center dark:border-zinc-700 dark:bg-zinc-800">
                        <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 3MB</span>
                        <input type="file" accept="image/*" onChange={(e) => handleCharFileChange(e, index)} className="hidden" />
                      </label>
                    )}
                    {character.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{character.error}</p>}
                    <textarea
                      value={character.line}
                      onChange={(e) => setDialogueLine(index, e.target.value)}
                      placeholder={`Lời thoại của nhân vật ${String.fromCharCode(65 + index)}...`}
                      rows={2}
                      maxLength={400}
                      className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                    />
                  </div>
                ))}
              </div>

              {dialogueCharacters.length < DIALOGUE_MAX_CHARACTERS && (
                <button
                  onClick={addDialogueCharacter}
                  className="mt-3 rounded-full border border-dashed border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                >
                  + Thêm nhân vật (tối đa {DIALOGUE_MAX_CHARACTERS})
                </button>
              )}

              {dialogueStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{dialogueStatusText}</p>}
              {dialogueError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{dialogueError}</p>}

              {dialogueResult && (
                <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
                  <video src={dialogueResult} controls className="w-full max-w-md rounded-lg" />
                  <div className="mt-3 flex gap-2">
                    <a
                      href={`/api/download?url=${encodeURIComponent(dialogueResult)}&filename=doi-thoai.mp4`}
                      download
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Tải xuống
                    </a>
                    <button
                      onClick={() => {
                        setDialogueResult(null);
                        setDialogueCharacters([
                          { image: null, error: null, line: "" },
                          { image: null, error: null, line: "" },
                        ]);
                      }}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Chạy lại với input khác
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : app.inputType === "story-video" ? (
            <div className="mb-4">
              {/* Hàng 1: Ý tưởng truyện */}
              <div>
                <p className="mb-1 text-base font-medium text-zinc-500 dark:text-zinc-400">Ý tưởng truyện</p>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Mô tả mạch truyện, bối cảnh — AI sẽ chia thành phân cảnh"
                  rows={8}
                  maxLength={2000}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                />

                {storyUseOwnSceneImages ? (
                  <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                    Số phân cảnh: <strong className="text-zinc-900 dark:text-zinc-50">{storySceneImages.length || "0"}</strong> (theo đúng số ảnh đã tải ở khung "Ảnh phân cảnh" phía dưới)
                  </p>
                ) : (
                  <div className="mt-3">
                    <p className="mb-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">Số phân cảnh</p>
                    <div className="flex flex-wrap gap-2">
                      {Array.from({ length: STORY_MAX_SCENES - STORY_MIN_SCENES + 1 }, (_, i) => STORY_MIN_SCENES + i).map((n) => (
                        <button
                          key={n}
                          onClick={() => setNumScenes(n)}
                          className={`rounded-full border px-4 py-1.5 text-sm font-medium ${
                            numScenes === n
                              ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                              : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                          }`}
                        >
                          {n} cảnh
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <label className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <input type="checkbox" checked={storyAutoVideo} onChange={(e) => setStoryAutoVideo(e.target.checked)} />
                  Tự động tạo video luôn (gộp 1 lượt) — mặc định tắt: chỉ tạo ảnh trước, xem ưng ý mới tạo video
                </label>
              </div>

              {/* Hàng 2: Agent xử lý (Thể loại dạng thẻ) + Model chat */}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
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

              {/* Hàng 3: Ảnh nhân vật (full width) */}
              <div ref={storyCharacterCardRef} className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">📷 Ảnh nhân vật</p>

                      {storyExtraCharacters.length > 0 && (
                        <input
                          type="text"
                          value={storyPrimaryCharacterLabel}
                          onChange={(e) => setStoryPrimaryCharacterLabel(e.target.value)}
                          placeholder='Tên nhân vật này (vd "Lan") — dùng đúng tên này trong Ý tưởng truyện để Agent gán đúng người'
                          className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        />
                      )}

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
                                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">@image{index + 1}</span>
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
                                  const reader = new FileReader();
                                  reader.onload = () => {
                                    setStoryCharacterImages((prev) => [...prev, reader.result as string]);
                                    setStoryImageCheckResult(null);
                                  };
                                  reader.readAsDataURL(file);
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
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                      setStoryExtraCharacters((prev) =>
                                        prev.map((s, i) => (i === slotIndex ? { ...s, images: [...s.images, reader.result as string] } : s))
                                      );
                                    };
                                    reader.readAsDataURL(file);
                                  }}
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      ))}

                      {storyExtraCharacters.length < STORY_MAX_CHARACTERS - 1 && (
                        <button
                          onClick={() => setStoryExtraCharacters((prev) => [...prev, { images: [], reuseId: null, label: "" }])}
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

              {/* Hàng 4: Bối cảnh/Địa điểm thật (tuỳ chọn) — full width, độc lập với Ảnh nhân vật */}
              <div className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">📍 Bối cảnh/Địa điểm (tuỳ chọn)</p>
                <p className="mb-3 text-sm text-zinc-400 dark:text-zinc-500">
                  Đưa ảnh thật của 1 địa điểm (sân vườn, nhà, cửa hàng...) để video diễn ra đúng tại khung cảnh đó — không bắt
                  buộc, bỏ trống thì AI tự vẽ bối cảnh theo mô tả truyện.
                </p>
                <div className="grid grid-cols-4 gap-3">
                  {storyLocationReference ? (
                    <div className="relative w-full" style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={storyLocationReference}
                        alt="Bối cảnh/Địa điểm"
                        onClick={() => setStoryQuickZoomUrl(storyLocationReference)}
                        className="h-full w-full cursor-zoom-in rounded-lg object-cover"
                        title="Bấm để xem to"
                      />
                      <button
                        onClick={() => setStoryLocationReference(null)}
                        className="absolute -right-2 -top-2 rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white hover:bg-black/90"
                      >
                        ✕
                      </button>
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
                          const reader = new FileReader();
                          reader.onload = () => setStoryLocationReference(reader.result as string);
                          reader.readAsDataURL(file);
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Hàng 5: Model tạo ảnh phân cảnh + Model tạo video (2 cột) */}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">Model tạo ảnh phân cảnh</p>
                      {storyExtraCharacters.length > 0 && (
                        <p className="mb-2 text-sm text-zinc-400 dark:text-zinc-500">
                          Đang có nhiều nhân vật — chỉ hiện model hỗ trợ nhiều ảnh tham chiếu (ghép nhiều người vào 1 cảnh).
                        </p>
                      )}
                      {(() => {
                        const availableImageModels =
                          storyExtraCharacters.length > 0 ? storyImageModels.filter((m) => m.multi_image) : storyImageModels;
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
                                  if (m?.aspect_ratios && !m.aspect_ratios.includes(storyAspectRatio)) setStoryAspectRatio(m.aspect_ratios[0]);
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
                                }}
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                              >
                                {Array.from(new Set(storyVideoModels.map((m) => m.provider))).map((provider) => (
                                  <optgroup key={provider} label={provider}>
                                    {storyVideoModels
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
                            {selected?.duration_price_vnd && (
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
                    </div>
              </div>

              {/* Hàng 6: Ảnh phân cảnh (full width) */}
              <div ref={storyScenesPreviewRef} className="mt-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-700">
                      <p className="mb-2 text-base font-semibold text-zinc-700 dark:text-zinc-300">🖼️ Ảnh phân cảnh</p>
                      <label className="mb-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                        <input
                          type="checkbox"
                          checked={storyUseOwnSceneImages}
                          onChange={(e) => setStoryUseOwnSceneImages(e.target.checked)}
                        />
                        Đã có sẵn ảnh phân cảnh — tải lên thay vì để AI tạo
                      </label>
                      <>
                          <div className="grid grid-cols-4 gap-3">
                            {storySceneImages.map((img, index) => {
                              const aiScene = !storyUseOwnSceneImages ? storyScenes?.[index] : undefined;
                              const isRegeneratingThis = aiScene && storyRegeneratingSceneId === aiScene.id;
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
                                  {isRegeneratingThis && (
                                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-xs text-white">
                                      Đang tạo lại...
                                    </div>
                                  )}
                                  <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                                    Cảnh {index + 1}
                                  </span>
                                  {aiScene && (
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
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                      setStorySceneImages((prev) => [...prev, reader.result as string]);
                                      setStorySceneHints((prev) => [...prev, ""]);
                                    };
                                    reader.readAsDataURL(file);
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

              {storyStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{storyStatusText}</p>}
              {storyError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{storyError}</p>}

              {storyQuickZoomUrl && (
                <div
                  ref={storyQuickZoomRef}
                  className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Xem trước ảnh</p>
                    <button
                      onClick={() => setStoryQuickZoomUrl(null)}
                      className="text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                      ✕ Đóng
                    </button>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={storyQuickZoomUrl}
                    alt="Xem trước ảnh nhân vật"
                    onClick={() => setStoryQuickZoomUrl(null)}
                    className="w-full max-w-xl cursor-zoom-out rounded-lg"
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

              {storyStatus === "failed" && storyScenes && storyScenes.every((s) => s.imageUrl) && (
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

              {storyScenes && storyScenes.some((s) => s.videoUrl) && (
                <div className="mt-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
                  <p className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">🎬 Video từng cảnh</p>
                  <div className="grid grid-cols-4 gap-3">
                    {storyScenes.map((scene, index) => {
                      const isRegeneratingThisVideo = storyRegeneratingVideoSceneId === scene.id;
                      if (!scene.videoUrl && !isRegeneratingThisVideo) return null;
                      return (
                        <div key={scene.id} className="relative w-full" style={{ aspectRatio: storyAspectRatio.replace(":", " / ") }}>
                          {scene.videoUrl && <video src={scene.videoUrl} controls className="h-full w-full rounded-lg object-cover" />}
                          {isRegeneratingThisVideo && (
                            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-xs text-white">
                              Đang tạo lại...
                            </div>
                          )}
                          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                            Cảnh {index + 1}
                          </span>
                          <button
                            onClick={() => {
                              if (!isRegeneratingThisVideo) handleRegenerateSceneVideo(scene.id);
                            }}
                            disabled={!!storyRegeneratingVideoSceneId}
                            title="Tạo lại đúng video cảnh này (tốn thêm credit như 1 video phân cảnh)"
                            className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 py-1 text-xs text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            🔄
                          </button>
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
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mb-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={app.inputPlaceholder}
                rows={4}
                className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
              />
              <div className="mt-2 flex items-center gap-2">
                <label className="cursor-pointer text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Hoặc tải file .txt lên
                  <input type="file" accept=".txt,text/plain" onChange={handleTextFileChange} className="hidden" />
                </label>
                {textFileError && <p className="text-xs text-red-600 dark:text-red-400">{textFileError}</p>}
              </div>
            </div>
          )}

          {(app.inputType === "outfit-swap" || app.inputType === "dialogue-video" || app.inputType === "story-video") && !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : app.inputType === "dialogue-video" ? (
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">{dialogueCreditCost ?? app.creditCost} credit</strong>{" "}
                ({dialogueCharacters.length} nhân vật)
              </span>
              <button
                onClick={handleRunDialogueVideo}
                disabled={dialogueRunning || dialogueCharacters.some((c) => !c.image || !c.line.trim())}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {dialogueRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          ) : app.inputType === "story-video" ? (
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
                      (!storySelectedSavedCharacterId && storyCharacterImages.length === 0) ||
                      (!!storySelectedSavedCharacterId && !input.trim())
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
          ) : app.inputType === "outfit-swap" ? (
            <div className={`flex items-center justify-between ${isTwoColumnLayout ? "mt-auto pt-4" : ""}`}>
              <span className={isTwoColumnLayout ? "text-base text-zinc-600 dark:text-zinc-400" : "text-sm text-zinc-600 dark:text-zinc-400"}>
                {(() => {
                  const pricePerImage = outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? 0;
                  return (
                    <>
                      Thao tác này sẽ trừ{" "}
                      <strong className="text-zinc-900 dark:text-zinc-50">
                        {pricePerImage * garmentImages.length} credit
                      </strong>{" "}
                      ({garmentImages.length} × {pricePerImage} credit)
                    </>
                  );
                })()}
              </span>
              <button
                onClick={handleRunOutfitSwap}
                disabled={isRunning || garmentImages.length === 0 || !imageDataUrl || !outfitSwapModelChoice}
                className={
                  isTwoColumnLayout
                    ? "rounded-full bg-zinc-900 px-5 py-2 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    : "rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          ) : !user ? (
            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Cần đăng nhập để chạy Mini App</span>
              <Link href="/login" className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
                Đăng nhập
              </Link>
            </div>
          ) : (
            <div
              className={`flex items-center justify-between ${isTwoColumnLayout ? "mt-auto pt-4" : ""}`}
            >
              <span
                className={
                  isTwoColumnLayout
                    ? "text-base text-zinc-600 dark:text-zinc-400"
                    : "text-sm text-zinc-600 dark:text-zinc-400"
                }
              >
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">
                  {(() => {
                    if (videoTiers.length > 0) {
                      const tier = videoTiers.find((t) => t.key === selectedVideoTier);
                      return tier?.creditCost ?? tier?.creditCostByDuration?.[selectedVideoDuration] ?? app.creditCost;
                    }
                    return liveCreditCost ?? app.creditCost;
                  })()}{" "}
                  credit
                </strong>
              </span>
              <button
                onClick={
                  app.inputType === "video-gen"
                    ? handleRunVideo
                    : app.inputType === "motion-transfer"
                    ? handleRunMotionTransfer
                    : app.inputType === "video-transform"
                    ? handleRunVideoTransform
                    : handleRun
                }
                disabled={
                  isRunning ||
                  (app.inputType === "image"
                    ? !imageDataUrl
                    : app.inputType === "motion-transfer"
                    ? !imageDataUrl || !endFrameDataUrl || uploadingReferenceVideo
                    : app.inputType === "video-transform"
                    ? !imageDataUrl || !endFrameDataUrl
                    : input.trim() === "")
                }
                className={
                  isTwoColumnLayout
                    ? "rounded-full bg-zinc-900 px-5 py-2 text-base font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    : "rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>
          )}

          {outfitSwapStatusText && (
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{outfitSwapStatusText}</p>
          )}

          {runError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>
          )}
          </div>
          <div className={isTwoColumnLayout ? "flex h-full flex-col" : undefined}>

          {isTwoColumnLayout && !result && !outfitSwapResults && (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
              <p className="text-sm font-medium text-zinc-400 dark:text-zinc-500">
                {isRunning ? "Đang xử lý..." : "Kết quả sẽ hiển thị ở đây"}
              </p>
              {!isRunning && (
                <p className="text-xs text-zinc-400 dark:text-zinc-600">Bấm &quot;Chạy ngay&quot; để bắt đầu</p>
              )}
            </div>
          )}

          {outfitSwapResults && (
            <div
              className={`mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800 ${
                isTwoColumnLayout ? "flex flex-1 flex-col" : ""
              }`}
            >
              <p className="mb-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Kết quả từ AI ({outfitSwapResults.length} ảnh)
              </p>
              <div
                className={
                  outfitSwapResults.length === 1
                    ? isTwoColumnLayout
                      ? "flex flex-1 flex-col items-center justify-center"
                      : "flex justify-center"
                    : "grid gap-3"
                }
                style={outfitSwapResults.length === 1 ? undefined : { gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
              >
                {outfitSwapResults.map((url, index) => (
                  <div key={index} className={outfitSwapResults.length === 1 ? "w-full max-w-md" : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Kết quả ${index + 1}`}
                      className={
                        outfitSwapResults.length === 1
                          ? `w-full rounded-lg object-contain ${isTwoColumnLayout ? "max-h-[55vh]" : ""}`
                          : "aspect-square w-full rounded-lg object-cover"
                      }
                    />
                    <div className="mt-1 flex items-center justify-center gap-2">
                      <a
                        href={`/api/download?url=${encodeURIComponent(url)}&filename=ket-qua-${index + 1}.jpg`}
                        download
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        Tải xuống
                      </a>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <button
                        onClick={() => handleRetryOutfitSwapItem(index)}
                        disabled={retryingIndex !== null}
                        title={`Chạy lại ảnh này (trừ thêm ${outfitSwapModels.find((m) => m.key === outfitSwapModelChoice)?.pricePerImage ?? ""} credit)`}
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        {retryingIndex === index ? "Đang chạy lại..." : "Chạy lại ảnh này"}
                      </button>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <Link
                        href={`/mini-app/video-truoc-sau?startImageUrl=${encodeURIComponent(
                          outfitSwapModelImageUrl ?? ""
                        )}&endImageUrl=${encodeURIComponent(url)}`}
                        className="text-center text-xs font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        Tạo video từ ảnh này
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setOutfitSwapResults(null);
                  setGarmentImages([]);
                  setImageDataUrl(null);
                }}
                className={`rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300 ${
                  isTwoColumnLayout ? "mt-auto pt-3" : "mt-3"
                }`}
              >
                Chạy lại với ảnh khác
              </button>
            </div>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {app.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={result}
                  alt="Ảnh do AI tạo"
                  className={`w-full max-w-md rounded-lg ${isTwoColumnLayout ? "max-h-[50vh] object-contain" : ""}`}
                />
              ) : app.outputType === "video" ? (
                <video
                  src={result}
                  controls
                  className={`w-full max-w-md rounded-lg ${isTwoColumnLayout ? "max-h-[50vh] object-contain" : ""}`}
                />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <p className="mt-4 text-sm font-bold text-zinc-800 dark:text-zinc-200">Bạn muốn làm gì tiếp theo?</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {app.outputType === "image" || app.outputType === "video" ? (
                  <a
                    href={`/api/download?url=${encodeURIComponent(result)}&filename=ket-qua.${app.outputType === "video" ? "mp4" : "jpg"}`}
                    download
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Tải xuống
                  </a>
                ) : (
                  <button className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                    Tải xuống
                  </button>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setInput("");
                    setImageDataUrl(null);
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
                    setFeedbackRating(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
                <button
                  onClick={handleShareResult}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  {shareCopied ? "Đã sao chép liên kết!" : "Chia sẻ"}
                </button>
                {app.outputType === "video" && currentVideoJobId && (
                  <button
                    onClick={() => setShowMusicPicker((v) => !v)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Thêm âm thanh
                  </button>
                )}
                {app.outputType === "video" &&
                  (youtubePublishedUrl ? (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400">
                      Đã đăng lên YouTube:{" "}
                      <a href={youtubePublishedUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        {youtubePublishedUrl}
                      </a>
                    </p>
                  ) : !youtubeStatus?.connected ? (
                    <a
                      href={`/api/youtube/authorize?userId=${user?.id ?? ""}`}
                      className="inline-block rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Kết nối YouTube để đăng video
                    </a>
                  ) : (
                    <button
                      onClick={() => setShowYoutubeForm((v) => !v)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Đăng lên YouTube ({youtubeStatus.channelTitle})
                    </button>
                  ))}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setFeedbackRating((v) => (v === "up" ? null : "up"))}
                  title="Kết quả tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "up"
                      ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👍
                </button>
                <button
                  onClick={() => setFeedbackRating((v) => (v === "down" ? null : "down"))}
                  title="Kết quả chưa tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "down"
                      ? "border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👎
                </button>
                {feedbackRating && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Cảm ơn phản hồi của bạn!</span>
                )}
              </div>

              {app.outputType === "video" && (showMusicPicker || showYoutubeForm || youtubeError) && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                  {showMusicPicker && currentVideoJobId && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setMusicMode("library")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "library"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Từ thư viện
                        </button>
                        <button
                          onClick={() => setMusicMode("upload")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "upload"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Tải nhạc từ máy
                        </button>
                      </div>

                      {musicMode === "library" ? (
                        musicTracks.length === 0 ? (
                          <p className="text-xs text-zinc-400 dark:text-zinc-500">Thư viện chưa có bài nhạc nào.</p>
                        ) : (
                          <select
                            value={selectedTrackId ?? ""}
                            onChange={(e) => setSelectedTrackId(e.target.value ? Number(e.target.value) : null)}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                          >
                            <option value="">Chọn bài nhạc...</option>
                            {musicTracks.map((track) => (
                              <option key={track.id} value={track.id}>
                                {track.name}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <div>
                          <label className="inline-block cursor-pointer rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                            {customAudioDataUrl ? "Đã chọn file — bấm để đổi" : "Chọn file nhạc (mp3/wav/m4a, tối đa 10MB)"}
                            <input
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                setCustomAudioError(null);
                                if (!file.type.startsWith("audio/")) {
                                  setCustomAudioError("Chỉ nhận file nhạc (mp3/wav/m4a)");
                                  return;
                                }
                                if (file.size > 10 * 1024 * 1024) {
                                  setCustomAudioError("File nhạc tối đa 10MB");
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => setCustomAudioDataUrl(reader.result as string);
                                reader.readAsDataURL(file);
                              }}
                            />
                          </label>
                          {customAudioError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{customAudioError}</p>}
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Nhạc do anh tự chọn — anh tự chịu trách nhiệm về bản quyền file này.
                          </p>
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Chưa có nhạc?{" "}
                            <a href="https://www.youtube.com/audiolibrary" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              YouTube Audio Library
                            </a>
                            ,{" "}
                            <a href="https://pixabay.com/music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Pixabay Music
                            </a>{" "}
                            hoặc{" "}
                            <a href="https://mixkit.co/free-stock-music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Mixkit
                            </a>{" "}
                            có nhạc miễn phí dùng thương mại được, tải về rồi upload lại đây.
                          </p>
                        </div>
                      )}

                      <button
                        onClick={handleAddMusic}
                        disabled={(musicMode === "library" ? !selectedTrackId : !customAudioDataUrl) || addingMusic}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {addingMusic ? "Đang ghép nhạc..." : "Ghép nhạc"}
                      </button>
                      {musicAddError && <p className="text-xs text-red-600 dark:text-red-400">{musicAddError}</p>}
                      {musicAddedSuccess && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">✓ Đã ghép nhạc thành công — xem thử video ở trên trước khi đăng.</p>
                      )}
                    </div>
                  )}

                  {showYoutubeForm && youtubeStatus?.connected && !youtubePublishedUrl && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Đăng lên kênh: <strong>{youtubeStatus.channelTitle ?? "YouTube"}</strong>
                      </p>
                      <input
                        type="text"
                        value={youtubeTitle}
                        onChange={(e) => setYoutubeTitle(e.target.value)}
                        placeholder="Tiêu đề video"
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                      <textarea
                        value={youtubeDescription}
                        onChange={(e) => setYoutubeDescription(e.target.value)}
                        placeholder="Mô tả (không bắt buộc)"
                        rows={2}
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handlePublishYoutube}
                          disabled={youtubePublishing || !youtubeTitle.trim()}
                          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {youtubePublishing ? "Đang đăng..." : "Đăng lên YouTube"}
                        </button>
                        <button
                          onClick={() => setShowYoutubeForm(false)}
                          className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                        >
                          Huỷ
                        </button>
                      </div>
                    </div>
                  )}
                  {youtubeError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{youtubeError}</p>}
                </div>
              )}
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
    </div>
  );
}

type CommunityAppInfo = {
  id: string;
  name: string;
  description: string;
  category: string;
  creditCost: number;
  developerName: string | null;
  outputType: "text" | "image" | "video";
};

function CommunityMiniAppRunner({ miniAppId }: { miniAppId: string }) {
  const { user } = useAuth();
  const [appInfo, setAppInfo] = useState<CommunityAppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [endFrameDataUrl, setEndFrameDataUrl] = useState<string | null>(null);
  const [endFrameError, setEndFrameError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [currentVideoJobId, setCurrentVideoJobId] = useState<number | null>(null);
  const [musicTracks, setMusicTracks] = useState<{ id: number; name: string; file_url: string }[]>([]);
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [musicMode, setMusicMode] = useState<"library" | "upload">("library");
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [customAudioDataUrl, setCustomAudioDataUrl] = useState<string | null>(null);
  const [customAudioError, setCustomAudioError] = useState<string | null>(null);
  const [addingMusic, setAddingMusic] = useState(false);
  const [musicAddError, setMusicAddError] = useState<string | null>(null);
  const [musicAddedSuccess, setMusicAddedSuccess] = useState(false);

  const [shareCopied, setShareCopied] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<"up" | "down" | null>(null);

  // "Lịch sử" riêng của đúng app cộng đồng này — lọc theo miniAppId, không lẫn kết quả app khác.
  type HistoryItem = { id: number; outputType: string; outputUrl: string; createdAt: string };
  const [appHistory, setAppHistory] = useState<HistoryItem[]>([]);
  useEffect(() => {
    if (!user) return;
    fetch(`/api/history?userId=${user.id}&miniAppId=${miniAppId}`)
      .then((res) => res.json())
      .then((data) => setAppHistory(data.items ?? []))
      .catch(() => {});
  }, [user, miniAppId]);
  async function handleDeleteAppHistory(id: number) {
    if (!user) return;
    setAppHistory((items) => items.filter((item) => item.id !== id));
    await fetch(`/api/history/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    }).catch(() => {});
  }

  async function handleShareResult() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  }

  useEffect(() => {
    fetch(`/api/mini-apps/community/${miniAppId}`)
      .then((res) => res.json())
      .then((data) => setAppInfo(data.app ?? null))
      .finally(() => setLoading(false));
  }, [miniAppId]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (appInfo?.outputType !== "video") return;
    fetch("/api/background-music")
      .then((res) => res.json())
      .then((data) => setMusicTracks(data.tracks ?? []))
      .catch(() => {});
  }, [appInfo?.outputType]);

  // Tự khôi phục job video gần nhất khi khách quay lại trang (đóng tab/tắt máy giữa chừng rồi mở lại).
  useEffect(() => {
    if (appInfo?.outputType !== "video" || !user) return;
    fetch(`/api/video/latest?userId=${user.id}&miniAppId=${miniAppId}`)
      .then((res) => res.json())
      .then((data) => {
        const job = data.job;
        if (!job) return;
        setCurrentVideoJobId(job.id);
        if (job.status === "done" && job.outputUrl) {
          setResult(job.outputUrl);
        } else if (job.status === "pending" || job.status === "processing") {
          setIsRunning(true);
          setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
          pollVideoStatus(job.id);
        }
      })
      .catch(() => {});
  }, [appInfo?.outputType, user, miniAppId]);

  async function handleAddMusic() {
    if (!user || !currentVideoJobId) return;
    if (musicMode === "library" && !selectedTrackId) return;
    if (musicMode === "upload" && !customAudioDataUrl) return;
    setAddingMusic(true);
    setMusicAddError(null);
    setMusicAddedSuccess(false);
    try {
      const res = await fetch("/api/video/add-music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          jobId: currentVideoJobId,
          trackId: musicMode === "library" ? selectedTrackId : undefined,
          customAudioDataUrl: musicMode === "upload" ? customAudioDataUrl : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMusicAddError(data.error ?? "Không ghép được nhạc");
        return;
      }
      setResult(data.url);
      setMusicAddedSuccess(true);
    } catch {
      setMusicAddError("Không kết nối được tới server");
    } finally {
      setAddingMusic(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setImageError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setEndFrameError(null);
    if (!file.type.startsWith("image/")) {
      setEndFrameError("Chỉ nhận file ảnh (JPG, PNG, WEBP...)");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setEndFrameError("Ảnh tối đa 4MB, chọn ảnh nhỏ hơn giúp em nhé");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setEndFrameDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleRun() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);

    try {
      const res = await fetch(`/api/run/${appInfo.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, userId: user.id, imageDataUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        return;
      }
      setResult(data.output);
      window.dispatchEvent(new Event("balance-updated"));
    } catch {
      setRunError("Không kết nối được tới server");
    } finally {
      setIsRunning(false);
    }
  }

  function pollVideoStatus(jobId: number) {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/status?jobId=${jobId}`);
        const data = await res.json();

        if (data.status === "done" && data.outputUrl) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.outputUrl);
          setIsRunning(false);
          setVideoStatusText(null);
        } else if (data.status === "failed") {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setRunError(data.errorMessage ?? "Tạo video thất bại, credit đã được hoàn");
          setIsRunning(false);
          setVideoStatusText(null);
        }
      } catch {
        // bỏ qua lỗi mạng tạm thời, vòng poll tiếp theo sẽ thử lại
      }
    }, 4000);
  }

  async function handleRunVideo() {
    if (!user || !appInfo) return;
    setIsRunning(true);
    setResult(null);
    setRunError(null);
    setVideoStatusText("Đang gửi yêu cầu tạo video...");

    try {
      const res = await fetch("/api/video/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          miniAppId: appInfo.id,
          userId: user.id,
          prompt: input,
          startFrameDataUrl: imageDataUrl,
          endFrameDataUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setRunError(data.error ?? "Có lỗi xảy ra");
        setIsRunning(false);
        setVideoStatusText(null);
        return;
      }

      window.dispatchEvent(new Event("balance-updated"));
      setVideoStatusText("Đang xử lý video, có thể mất vài phút — anh có thể rời trang, quay lại vẫn thấy kết quả...");
      setCurrentVideoJobId(data.jobId);
      setShowMusicPicker(false);
      setSelectedTrackId(null);
      setCustomAudioDataUrl(null);
      setCustomAudioError(null);
      setMusicAddError(null);
      setMusicAddedSuccess(false);
      pollVideoStatus(data.jobId);
    } catch {
      setRunError("Không kết nối được tới server");
      setIsRunning(false);
      setVideoStatusText(null);
    }
  }

  if (loading) {
    return <div className="min-h-full bg-zinc-50 dark:bg-black" />;
  }

  if (!appInfo) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-zinc-600 dark:text-zinc-400">Không tìm thấy Mini App này.</p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium underline">
          Quay lại Danh mục
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50">
            ← Quay lại Danh mục
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <BalanceBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {CATEGORIES[appInfo.category as keyof typeof CATEGORIES] ?? appInfo.category}
          </span>
          {appInfo.developerName && (
            <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-400">
              Cộng đồng
            </span>
          )}
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{appInfo.name}</h1>
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">{appInfo.description}</p>
        <div className="mb-8 flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
          {appInfo.developerName && <span>Tạo bởi {appInfo.developerName}</span>}
        </div>

        <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Thử ngay
          </h2>
          <div className="mb-4">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={appInfo.outputType === "text" ? "Nhập nội dung..." : "Mô tả bối cảnh/nội dung muốn tạo..."}
              rows={appInfo.outputType === "text" ? 4 : 3}
              maxLength={appInfo.outputType === "video" ? VIDEO_PROMPT_MAX_LENGTH : undefined}
              className={`w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 ${
                appInfo.outputType === "video" ? "mb-1" : "mb-3"
              }`}
            />
            {appInfo.outputType === "video" && (
              <p
                className={`mb-3 text-right text-xs ${
                  input.length > VIDEO_PROMPT_MAX_LENGTH - 100 ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {input.length}/{VIDEO_PROMPT_MAX_LENGTH} ký tự — mô tả quá dài AI sẽ từ chối xử lý
              </p>
            )}

            {appInfo.outputType === "image" && (
              <>
                <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Ảnh tham chiếu (không bắt buộc)
                </p>
                {imageDataUrl ? (
                  <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageDataUrl} alt="Ảnh tham chiếu đã chọn" className="h-20 w-20 rounded-md object-cover" />
                    <button
                      onClick={() => setImageDataUrl(null)}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                    >
                      Xóa ảnh
                    </button>
                  </div>
                ) : (
                  <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-6 text-center dark:border-zinc-700 dark:bg-zinc-800">
                    <span className="mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh tham chiếu</span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">JPG, PNG, WEBP — tối đa 4MB</span>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                  </label>
                )}
                {imageError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{imageError}</p>}
              </>
            )}

            {appInfo.outputType === "video" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình đầu (không bắt buộc)</p>
                  {imageDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageDataUrl} alt="Ảnh khung hình đầu" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setImageDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                    </label>
                  )}
                  {imageError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{imageError}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Ảnh khung hình cuối (không bắt buộc)</p>
                  {endFrameDataUrl ? (
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={endFrameDataUrl} alt="Ảnh khung hình cuối" className="h-16 w-16 rounded-md object-cover" />
                      <button
                        onClick={() => setEndFrameDataUrl(null)}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-5 text-center dark:border-zinc-700 dark:bg-zinc-800">
                      <span className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Bấm để tải ảnh</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">tối đa 4MB</span>
                      <input type="file" accept="image/*" onChange={handleEndFrameFileChange} className="hidden" />
                    </label>
                  )}
                  {endFrameError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{endFrameError}</p>}
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
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Thao tác này sẽ trừ{" "}
                <strong className="text-zinc-900 dark:text-zinc-50">{appInfo.creditCost} credit</strong>
              </span>
              <button
                onClick={appInfo.outputType === "video" ? handleRunVideo : handleRun}
                disabled={isRunning || input.trim() === ""}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {isRunning ? "Đang xử lý..." : "Chạy ngay"}
              </button>
            </div>
          )}

          {videoStatusText && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{videoStatusText}</p>}

          {runError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{runError}</p>}

          {result && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800">
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Kết quả từ AI</p>
              {appInfo.outputType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result} alt="Ảnh do AI tạo" className="w-full max-w-md rounded-lg" />
              ) : appInfo.outputType === "video" ? (
                <video src={result} controls className="w-full max-w-md rounded-lg" />
              ) : (
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{result}</p>
              )}
              <p className="mt-4 text-sm font-bold text-zinc-800 dark:text-zinc-200">Bạn muốn làm gì tiếp theo?</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {appInfo.outputType === "image" || appInfo.outputType === "video" ? (
                  <a
                    href={`/api/download?url=${encodeURIComponent(result)}&filename=ket-qua.${appInfo.outputType === "video" ? "mp4" : "jpg"}`}
                    download
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Tải xuống
                  </a>
                ) : (
                  <button className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                    Tải xuống
                  </button>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setInput("");
                    setImageDataUrl(null);
                    setEndFrameDataUrl(null);
                    setVideoStatusText(null);
                    setFeedbackRating(null);
                  }}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  Chạy lại với input khác
                </button>
                <button
                  onClick={handleShareResult}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                >
                  {shareCopied ? "Đã sao chép liên kết!" : "Chia sẻ"}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setFeedbackRating((v) => (v === "up" ? null : "up"))}
                  title="Kết quả tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "up"
                      ? "border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👍
                </button>
                <button
                  onClick={() => setFeedbackRating((v) => (v === "down" ? null : "down"))}
                  title="Kết quả chưa tốt"
                  className={`rounded-full border px-2.5 py-1 text-sm ${
                    feedbackRating === "down"
                      ? "border-red-400 bg-red-50 dark:border-red-600 dark:bg-red-900/30"
                      : "border-zinc-300 dark:border-zinc-600"
                  }`}
                >
                  👎
                </button>
                {feedbackRating && (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Cảm ơn phản hồi của bạn!</span>
                )}
              </div>

              {appInfo.outputType === "video" && currentVideoJobId && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                  <button
                    onClick={() => setShowMusicPicker((v) => !v)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                  >
                    Thêm âm thanh
                  </button>

                  {showMusicPicker && (
                    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setMusicMode("library")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "library"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Từ thư viện
                        </button>
                        <button
                          onClick={() => setMusicMode("upload")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            musicMode === "upload"
                              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                              : "border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300"
                          }`}
                        >
                          Tải nhạc từ máy
                        </button>
                      </div>

                      {musicMode === "library" ? (
                        musicTracks.length === 0 ? (
                          <p className="text-xs text-zinc-400 dark:text-zinc-500">Thư viện chưa có bài nhạc nào.</p>
                        ) : (
                          <select
                            value={selectedTrackId ?? ""}
                            onChange={(e) => setSelectedTrackId(e.target.value ? Number(e.target.value) : null)}
                            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                          >
                            <option value="">Chọn bài nhạc...</option>
                            {musicTracks.map((track) => (
                              <option key={track.id} value={track.id}>
                                {track.name}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <div>
                          <label className="inline-block cursor-pointer rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-600 dark:text-zinc-300">
                            {customAudioDataUrl ? "Đã chọn file — bấm để đổi" : "Chọn file nhạc (mp3/wav/m4a, tối đa 10MB)"}
                            <input
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                setCustomAudioError(null);
                                if (!file.type.startsWith("audio/")) {
                                  setCustomAudioError("Chỉ nhận file nhạc (mp3/wav/m4a)");
                                  return;
                                }
                                if (file.size > 10 * 1024 * 1024) {
                                  setCustomAudioError("File nhạc tối đa 10MB");
                                  return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => setCustomAudioDataUrl(reader.result as string);
                                reader.readAsDataURL(file);
                              }}
                            />
                          </label>
                          {customAudioError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{customAudioError}</p>}
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Nhạc do anh tự chọn — anh tự chịu trách nhiệm về bản quyền file này.
                          </p>
                          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                            Chưa có nhạc?{" "}
                            <a href="https://www.youtube.com/audiolibrary" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              YouTube Audio Library
                            </a>
                            ,{" "}
                            <a href="https://pixabay.com/music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Pixabay Music
                            </a>{" "}
                            hoặc{" "}
                            <a href="https://mixkit.co/free-stock-music/" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
                              Mixkit
                            </a>{" "}
                            có nhạc miễn phí dùng thương mại được, tải về rồi upload lại đây.
                          </p>
                        </div>
                      )}

                      <button
                        onClick={handleAddMusic}
                        disabled={(musicMode === "library" ? !selectedTrackId : !customAudioDataUrl) || addingMusic}
                        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-300"
                      >
                        {addingMusic ? "Đang ghép nhạc..." : "Ghép nhạc"}
                      </button>
                      {musicAddError && <p className="text-xs text-red-600 dark:text-red-400">{musicAddError}</p>}
                      {musicAddedSuccess && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">✓ Đã ghép nhạc thành công — xem thử video ở trên trước khi đăng.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
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
      </main>
      <Footer />
    </div>
  );
}
