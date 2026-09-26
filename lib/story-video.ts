// Pipeline "Video từ ý tưởng truyện" — 1-3 ảnh nhân vật + 1 ý tưởng truyện, AI chia 2-8 phân cảnh
// rồi với mỗi cảnh: (1) model ảnh (khách chọn từ catalog nhiều nhà cung cấp) tạo ảnh giữ đúng nhân
// vật -> (2) model video (khách chọn từ catalog) động hoá ảnh đó -> (3) ffmpeg ghép N clip lại theo
// đúng thứ tự thành 1 video hoàn chỉnh. Mỗi cảnh là 1 hàng trong story_video_scenes, xử lý song song,
// chờ đủ cả N hàng mới sang bước kế tiếp — cùng khuôn với lib/dialogue-video.ts.
//
// Chia 3 nấc: submitStoryVideoJob() xử lý bước "Tạo Character" trước tiên rồi DỪNG ở "character_ready"
// (chỉ trừ credit nếu thực sự phải tạo Character mới) — khách xem/duyệt ảnh Character, ưng mới gọi
// continueStoryVideoToSceneStage() (trừ credit phần ảnh, chạy chia cảnh + tạo ảnh từng cảnh dùng
// Character làm tham chiếu) rồi DỪNG ở "images_ready" — khách xem ảnh từng cảnh, ưng mới gọi
// continueStoryVideoToVideoStage() (trừ credit phần video) để chạy tiếp video + ghép. Nếu khách chọn
// "tự động tạo video luôn" (autoVideo=true) thì continueStoryVideoToSceneStage trừ gộp cả ảnh+video và
// tự chạy hết tới cuối, không dừng ở images_ready.

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { chmodSync } from "fs";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { getSupabaseAdmin } from "@/lib/supabase";
import { deductCredit, refundCredit, getCreditBalance, InsufficientCreditError } from "@/lib/credit-system";
import { callOpenRouter, recordGenerationHistory } from "@/lib/ai-router";
import { computeDynamicCreditCost, getMediaPricingSettings } from "@/lib/pricing";
import { generateVietnameseSpeech, CHARACTER_VOICE_IDS } from "@/lib/elevenlabs";

const execFileAsync = promisify(execFile);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://ai-platform-marketplace.vercel.app";

export const MIN_SCENES = 1;
export const MAX_SCENES = 8;
// Catalog key của các model video mà API Fal.ai BẮT BUỘC cả ảnh đầu lẫn ảnh cuối (không tuỳ chọn như
// Kling O1) — chọn 1 trong các key này thì continuousMotion phải luôn = true, không phụ thuộc checkbox
// người dùng. Dùng ở app/api/story-video/submit + price route để tự ép, tránh submit thiếu last_frame.
export const REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS = new Set(["veo31-lite-flf"]);
export const MIN_CHARACTER_IMAGES = 1;
// Không giới hạn số ảnh nhân vật theo yêu cầu — chỉ giữ 1 trần an toàn kỹ thuật (tránh payload quá
// lớn/timeout, và một số model multi-image như Nano Banana Pro tự giới hạn tối đa 14 ảnh ở phía Fal.ai).
export const MAX_CHARACTER_IMAGES = 20;
// Nhiều nhân vật cùng xuất hiện chung 1 khung hình (vd tuần trăng mật, cầu hôn) — cận trên giống đúng
// MAX_CHARACTERS của lib/dialogue-video.ts để nhất quán, dù đây là 2 tính năng khác nhau.
export const MAX_STORY_CHARACTERS = 4;
// Vật phẩm riêng của 1 nhân vật (vd vừa giày vừa túi xách cùng lúc) — cận trên giữ nhỏ vì mỗi vật
// phẩm tốn thêm đúng 1 ảnh tham chiếu, cộng dồn với ảnh mặt/thân/địa điểm đã có sẵn trong cùng 1 lượt
// gọi model ảnh (một số model multi-image có giới hạn tổng số ảnh tham chiếu).
export const MAX_ITEM_REFERENCES = 3;

export type MultiCharacterInput = {
  imageUrls: string[];
  reuseCharacterId?: number;
  skipCharacterCreation?: boolean;
  label?: string;
  // Ảnh THẬT của (tối đa MAX_ITEM_REFERENCES) vật phẩm riêng của nhân vật này (vd đôi giày, túi xách,
  // đồng hồ...) — tuỳ chọn, để AI vẽ đúng y hệt món đó khi truyện tả nhân vật mặc/mang/cầm nó, thay vì
  // tự bịa kiểu dáng khác. Mỗi nhân vật có vật phẩm riêng (khác location_reference_url dùng chung cho
  // cả job).
  itemReferenceUrls?: string[];
  // Chế độ "Mô tả bằng chữ" cho ĐÚNG nhân vật này (không có ảnh thật) — mirror
  // characterAppearanceDescription ở luồng 1 nhân vật, xem buildCharacterSheetTextPrompt(). Mỗi nhân
  // vật trong job có thể độc lập dùng ảnh thật HOẶC mô tả chữ, không bắt buộc cả job cùng 1 kiểu.
  appearanceDescription?: string;
};

// Lọc bỏ chuỗi rỗng + cắt về đúng cận trên MAX_ITEM_REFERENCES — dùng chung mọi nơi nhận mảng vật
// phẩm từ client (không tin số lượng/nội dung client tự gửi). Trả null khi rỗng (khớp cột DB nullable).
function normalizeItemReferenceUrls(urls?: (string | null | undefined)[] | null): string[] | null {
  const filtered = (urls ?? []).filter((u): u is string => typeof u === "string" && u.trim().length > 0);
  return filtered.length > 0 ? filtered.slice(0, MAX_ITEM_REFERENCES) : null;
}

// Skill "story-extractor" — chạy TRƯỚC story-planner, viết lại ý tưởng thô của khách (có thể lủng
// củng/thiếu chi tiết) thành 1 đoạn mô tả rõ ràng, giữ NGUYÊN mọi tình tiết — không tóm tắt, không bịa
// thêm. Chỉ dùng làm input NỘI BỘ cho bước chia cảnh, KHÔNG ghi đè story_description gốc hiển thị cho
// khách (khách vẫn thấy đúng nguyên văn mình đã gõ).
const STORY_EXTRACTOR_DEFAULT_PROMPT = `Bạn nhận 1 ý tưởng truyện ngắn do khách hàng tự viết, có thể lủng củng, thiếu chủ ngữ, hoặc viết tắt.
Nhiệm vụ: viết lại thành 1 đoạn văn RÕ RÀNG, MẠCH LẠC, giữ NGUYÊN VẸN mọi tình tiết/hành động/địa điểm/nhân vật đã có — không thêm tình tiết mới, không bỏ sót tình tiết nào, không tóm tắt ngắn lại.
Giữ nguyên ngôn ngữ gốc (nếu khách viết tiếng Việt thì trả lời tiếng Việt).
Chỉ trả về đoạn văn đã viết lại, không giải thích, không thêm tiêu đề.`;

// Skill "story-validator" — chạy SAU khi story-planner chia cảnh xong, kiểm tra xem N cảnh có phản
// ánh đúng/đủ truyện gốc không trước khi tạo ảnh (tốn credit). Không chặn cứng job nếu vẫn lỗi sau 1
// lần thử lại — chỉ là lưới an toàn thêm, không phải cổng chặn tuyệt đối (tránh false-positive chặn oan).
const STORY_VALIDATOR_DEFAULT_PROMPT = `Bạn kiểm tra chất lượng 1 bản chia cảnh cho video. Bạn sẽ nhận truyện gốc + danh sách các cảnh đã chia.
Trả lời ĐÚNG 1 dòng JSON, không thêm chữ nào khác:
{"ok": true} nếu các cảnh phản ánh đúng trình tự và đầy đủ những tình tiết CHÍNH của truyện gốc, hoặc
{"ok": false, "issue": "<mô tả ngắn gọn tiếng Việt vấn đề tìm thấy>"} nếu phát hiện: bỏ sót hẳn 1 tình tiết chính, thứ tự bị đảo lộn vô lý, hoặc cảnh nào đó mâu thuẫn với truyện gốc.
Không bắt lỗi vì thiếu chi tiết nhỏ/phong cách hành văn — chỉ báo lỗi khi thực sự ảnh hưởng tới việc kể đúng câu chuyện.`;

// Cỡ cảnh (shot size) + góc máy (camera angle) + chuyển động máy (camera movement) — HOÀN TOÀN KHÁC
// "camera_view" (hướng NHÂN VẬT quay mặt so với máy quay). Đây là 3 trục mô tả chính MÁY QUAY: khoảng
// cách/cỡ khung hình, độ cao/góc nghiêng, và máy có di chuyển hay không trong lúc quay — theo đúng
// thuật ngữ điện ảnh chuẩn (tra cứu StudioBinder "types-of-camera-shots-sizes-in-film" +
// nitromediagroup "different-types-of-camera-angles-in-filmmaking-explained"). Dùng chung cho cả 4
// luồng chia cảnh (mặc định + "Tạo kịch bản", 1 nhân vật + nhiều nhân vật).
export const SHOT_SIZE_LABELS = ["close_up", "medium_close_up", "medium_shot", "full_shot", "wide_shot"] as const;
export type ShotSize = (typeof SHOT_SIZE_LABELS)[number];
export const CAMERA_ANGLE_LABELS = ["eye_level", "low_angle", "high_angle", "dutch_angle"] as const;
export type CameraAngleKey = (typeof CAMERA_ANGLE_LABELS)[number];
export const CAMERA_MOVEMENT_LABELS = ["static", "pan", "dolly_in", "dolly_out", "tracking"] as const;
export type CameraMovement = (typeof CAMERA_MOVEMENT_LABELS)[number];

const CAMERA_FRAMING_INSTRUCTION = `Với MỖI cảnh, xác định thêm 3 khoá về khung hình/chuyển động MÁY QUAY (bắt buộc, khác hẳn "camera_view" — camera_view là hướng NHÂN VẬT quay mặt, còn 3 khoá này là vị trí/khoảng cách/chuyển động của CHÍNH máy quay):
- "shot_size" (cỡ cảnh, chọn ĐÚNG 1 trong 5 giá trị, viết y hệt): "close_up" (cận mặt/đầu-vai, đặc tả cảm xúc/chi tiết nhỏ), "medium_close_up" (từ ngực trở lên), "medium_shot" (từ thắt lưng trở lên, thấy 1 phần bối cảnh), "full_shot" (toàn thân, thấy rõ bối cảnh xung quanh), "wide_shot" (toàn cảnh rộng, nhấn không gian/bối cảnh hơn nhân vật). Đa dạng cỡ cảnh qua các cảnh giống phim thật (vd cảnh mở đầu dùng "wide_shot" giới thiệu bối cảnh, cảnh cảm xúc dùng "close_up") — KHÔNG lặp lại đúng 1 cỡ cảnh cho toàn bộ truyện trừ khi truyện chỉ có 1-2 cảnh.
- "camera_angle" (góc máy, chọn ĐÚNG 1 trong 4 giá trị, viết y hệt): "eye_level" (ngang tầm mắt, trung tính — mặc định cho đa số cảnh), "low_angle" (máy đặt thấp chĩa lên — nhân vật trông mạnh mẽ/uy nghi/chiến thắng, dùng cho khoảnh khắc tự tin), "high_angle" (máy đặt cao chĩa xuống — nhân vật trông nhỏ bé/yếu thế/cô đơn, dùng cho khoảnh khắc dễ tổn thương), "dutch_angle" (máy nghiêng — tạo cảm giác bất ổn/căng thẳng, CHỈ dùng khi truyện có tình huống căng thẳng/bất an rõ rệt, không dùng tuỳ tiện).
- "camera_movement" (chuyển động máy, chọn ĐÚNG 1 trong 5 giá trị, viết y hệt): "static" (máy đứng yên hoàn toàn — mặc định cho đa số cảnh, nhất là cảnh tĩnh/đối thoại), "pan" (máy lia ngang tại chỗ theo hành động, dùng khi nhân vật di chuyển ngang qua khung hình), "dolly_in" (máy tiến lại gần dần trong lúc quay — tăng cảm giác thân mật/căng thẳng, dùng cho khoảnh khắc cảm xúc cao trào), "dolly_out" (máy lùi ra xa dần — mở rộng bối cảnh/tạo khoảng cách, dùng khi nhân vật rời đi hoặc kết thúc 1 đoạn), "tracking" (máy di chuyển song song theo nhân vật, dùng khi nhân vật đi bộ/chạy 1 quãng dài). Chỉ chọn khác "static" khi hành động trong cảnh thực sự cần — không tự thêm chuyển động máy không cần thiết.
Ưu tiên tuyệt đối: nếu ý tưởng gốc có yêu cầu RÕ RÀNG về góc máy/cỡ cảnh/chuyển động máy (ví dụ "quay từ trên cao chĩa xuống", "góc nhìn từ trên xuống như flycam", "cận mặt", "máy lùi ra xa", "zoom cận"), PHẢI chọn đúng giá trị khớp với yêu cầu đó — chỉ dùng các gợi ý theo cảm xúc/tình huống ở trên khi ý tưởng gốc KHÔNG nói gì cụ thể về máy quay.`;

// Validate mềm (không hard-fail cả job chỉ vì 3 field mới này) — Agent thiếu/trả sai thì rơi về mặc
// định an toàn (trung tính/đứng yên), KHÔNG được để lỗi 3 field này chặn cả job như location/end_pose.
function resolveShotSize(v: unknown): ShotSize {
  return typeof v === "string" && (SHOT_SIZE_LABELS as readonly string[]).includes(v) ? (v as ShotSize) : "medium_shot";
}
function resolveCameraAngleKey(v: unknown): CameraAngleKey {
  return typeof v === "string" && (CAMERA_ANGLE_LABELS as readonly string[]).includes(v) ? (v as CameraAngleKey) : "eye_level";
}
function resolveCameraMovement(v: unknown): CameraMovement {
  return typeof v === "string" && (CAMERA_MOVEMENT_LABELS as readonly string[]).includes(v) ? (v as CameraMovement) : "static";
}

// Câu tả bằng tiếng Anh cho từng camera_movement — tiêm thẳng vào prompt tạo VIDEO bằng code (không
// qua Agent viết motion_prompt, tránh phải sửa hệt system prompt riêng) khi khác "static".
const CAMERA_MOVEMENT_PROMPT_TEXT: Record<CameraMovement, string> = {
  static: "",
  pan: " The camera pans smoothly to follow the action, staying in the same fixed position.",
  dolly_in: " The camera slowly pushes in toward the subject as the action unfolds.",
  dolly_out: " The camera slowly pulls back away from the subject as the action unfolds, revealing more of the surroundings.",
  tracking: " The camera tracks alongside the subject, moving in parallel with their motion.",
};

// Câu tả cỡ cảnh + góc máy bằng tiếng Anh — tiêm vào prompt tạo ẢNH phân cảnh (khung hình bắt đầu),
// dùng chung cho cả luồng 1 nhân vật và nhiều nhân vật.
const SHOT_SIZE_PROMPT_TEXT: Record<ShotSize, string> = {
  close_up: "a close-up shot, framing the face and head/shoulders",
  medium_close_up: "a medium close-up shot, framing from the chest up",
  medium_shot: "a medium shot, framing from the waist up",
  full_shot: "a full shot, showing the entire body with some surrounding background",
  wide_shot: "a wide shot, emphasizing the surrounding space and environment",
};
const CAMERA_ANGLE_PROMPT_TEXT: Record<CameraAngleKey, string> = {
  eye_level: "at eye level, a neutral straight-on angle",
  low_angle: "from a low angle looking up, making the subject appear powerful and commanding",
  high_angle: "from a high angle looking down, making the subject appear small and vulnerable",
  dutch_angle: "with a tilted, canted dutch angle, creating a sense of unease and tension",
};
function buildCameraFramingClause(shotSize: string | null, cameraAngle: string | null): string {
  const shot = SHOT_SIZE_PROMPT_TEXT[resolveShotSize(shotSize)];
  const angle = CAMERA_ANGLE_PROMPT_TEXT[resolveCameraAngleKey(cameraAngle)];
  return ` Camera framing: ${shot}, shot ${angle}.`;
}

const SCENE_SPLIT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (nhân vật đang làm gì, ở đâu, bối cảnh gì), giữ nguyên nhân vật chính xuyên suốt các cảnh.
Với MỖI cảnh, xác định thêm góc camera đang nhìn thấy nhân vật rõ nhất, chỉ được chọn ĐÚNG 1 trong 6 giá trị sau (viết y hệt, chữ thường): "front" (chính diện), "three_quarter_left" (nghiêng 3/4 trái), "three_quarter_right" (nghiêng 3/4 phải), "side" (nhìn ngang hẳn 1 bên), "back" (quay lưng lại camera), "face" (cận mặt).
Quy tắc khi mô tả không nói rõ góc quay: nếu không nói gì đặc biệt về hướng, mặc định "front". Nếu chỉ nói "quay đầu"/"nhìn sang" (không nói "quay người"/"quay lưng"), coi là góc "three_quarter_left" hoặc "three_quarter_right" tương ứng hướng nhìn, KHÔNG phải "back". Chỉ chọn "back" khi mô tả rõ ràng nhân vật quay LƯNG/CẢ NGƯỜI lại camera.
${CAMERA_FRAMING_INSTRUCTION}
Khi viết "description" (tiếng Anh): viết như 1 đạo diễn hình ảnh thật sự — có thể thêm chi tiết điện ảnh phù hợp với bối cảnh gốc (ánh sáng, loại khung hình/shot size, không khí, chất liệu/kết cấu môi trường xung quanh) để ảnh tạo ra sống động hơn, nhưng KHÔNG bịa thêm tình tiết, hành động, hay địa điểm không có trong ý tưởng gốc.
Rào chắn giữ đúng danh tính nhân vật (bắt buộc, không được vi phạm dù thêm chi tiết điện ảnh): giữ nguyên giới tính, độ tuổi, kiểu tóc, màu tóc của nhân vật chính xuyên suốt mọi cảnh (đây là phần KHÔNG BAO GIỜ được đổi); không tự thêm nhân vật phụ mới nếu ý tưởng gốc không nhắc; nếu ý tưởng gốc mô tả 1 địa điểm liên tục thì không tự đổi bối cảnh giữa các cảnh.
Trang phục — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu sắc/kiểu dáng/chất liệu trang phục trong "description" (ví dụ KHÔNG viết "a white blouse", "a red dress"...) trừ đúng lúc dùng "outfit_override" (xem mục "Đổi trang phục" bên dưới). Lý do: bạn KHÔNG nhìn thấy ảnh nhân vật thật — tự bịa màu/kiểu trang phục sẽ mâu thuẫn với trang phục thật trong ảnh tham chiếu, khiến ảnh tạo ra sai hẳn bộ đồ. Nếu cần nhắc tới trang phục để giữ liên tục giữa các cảnh (theo mục "Trạng thái liên tục" bên dưới), chỉ viết chung chung kiểu "wearing the same outfit as before" — KHÔNG bịa thêm chi tiết màu/kiểu.
Trạng thái liên tục giữa các cảnh (quan trọng): MỖI cảnh được gửi cho model tạo ảnh RIÊNG BIỆT, độc lập — model đó KHÔNG thấy ảnh của cảnh trước, chỉ thấy đúng "description" của cảnh đang xét. Vì vậy mỗi "description" phải TỰ ĐẦY ĐỦ ngữ cảnh (self-contained): nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 địa điểm kế thừa từ cảnh trước, PHẢI nhắc lại rõ địa điểm/bối cảnh đó trong CHÍNH cảnh đang viết (không được viết cụt lủn kiểu chỉ nối tiếp hành động, ví dụ SAI: "she turns and smiles" — thiếu ngữ cảnh; ĐÚNG: "still sitting at the same coffee shop table by the window, she turns and smiles"). Riêng trang phục thì áp dụng đúng quy tắc ở mục "Trang phục" bên trên — không tự bịa màu/kiểu cụ thể dù là để giữ liên tục.
Tư thế/hành động nối tiếp (quan trọng, áp dụng cho MỌI cảnh không phải cảnh đầu tiên): "description" của cảnh này PHẢI bắt đầu đúng từ tư thế/hành động mà "end_pose" của cảnh NGAY TRƯỚC nó vừa mô tả — viết liền thành 1 câu tự nhiên, như đó là trạng thái nhân vật NGAY LÚC NÀY (thì hiện tại, 1 khoảnh khắc duy nhất), TUYỆT ĐỐI không viết theo kiểu kể lại 2 mốc thời gian nối nhau (SAI, sẽ bị hiểu nhầm là vẽ 2 khung hình trong 1 ảnh: "she was smiling, and now she stands up"; ĐÚNG, 1 khoảnh khắc: "still smiling as she stands up from the table"). Không được tự ý đặt nhân vật về lại tư thế mặc định/trung tính nếu không có căn cứ nhân vật đã di chuyển hay đổi tư thế giữa 2 cảnh.
Không được bỏ sót hành động đổi tư thế lớn (bắt buộc): nếu ý tưởng gốc có 1 hành động đổi tư thế/trạng thái lớn (đứng dậy, ngồi xuống, quay người, bắt đầu di chuyển, dừng lại...), hành động đó PHẢI được thể hiện rõ trong "description" hoặc "end_pose" của ĐÚNG 1 cảnh cụ thể — TUYỆT ĐỐI không được để 2 cảnh liền kề nhảy thẳng từ tư thế này sang tư thế khác (vd cảnh trước còn đang ngồi, cảnh sau đã đứng hẳn) mà không cảnh nào thể hiện lúc đang chuyển. Khi số cảnh (N) ít hơn số hành động trong ý tưởng gốc, buộc phải gộp bớt một số hành động lại — ưu tiên gộp các hành động KHÔNG đổi tư thế lớn (vd "nhìn điện thoại" + "mỉm cười" có thể gộp), tuyệt đối không gộp/bỏ qua đúng hành động CÓ đổi tư thế lớn.
Khung hình/bố cục camera nhất quán (bắt buộc, khi nhiều cảnh liên tiếp cùng 1 địa điểm): vị trí các vật thể cố định trong khung hình (bàn, cửa sổ, cửa ra vào, đồ nội thất...) và mức độ zoom/cỡ cảnh (cận/trung/toàn) PHẢI giữ nguyên qua các cảnh đó — ví dụ nếu cảnh trước cửa sổ nằm bên phải khung hình thì cảnh sau cũng phải vậy, không được tự đổi bố cục coi như đang quay từ góc khác. Chỉ được đổi khung hình/cỡ cảnh khi ý tưởng gốc có lý do rõ ràng (nhân vật di chuyển sang vị trí khác, hoặc mô tả rõ máy quay lùi ra/tiến lại gần).
Đổi trang phục (chỉ áp dụng khi ý tưởng gốc NÓI RÕ, ví dụ "mặc đồ ngủ ở nhà, sau đó ra ngoài khoác áo len"): với cảnh ĐẦU TIÊN xuất hiện bộ đồ mới, thêm khoá "outfit_override" (chuỗi tiếng Anh mô tả NGẮN GỌN bộ đồ mới, ví dụ "a beige knit cardigan over a white t-shirt") — mọi cảnh SAU ĐÓ vẫn mặc bộ đồ này thì PHẢI lặp lại ĐÚNG y hệt "outfit_override" đó (không đổi cách viết) cho đến khi truyện lại nói đổi đồ tiếp; các cảnh mặc đồ gốc (chưa đổi) thì KHÔNG có khoá "outfit_override" (bỏ hẳn khoá này, không để rỗng/null). Khuôn mặt, kiểu tóc, dáng người vẫn phải giữ y hệt dù đổi đồ.
Thân người và mặt/ánh nhìn lệch hướng nhau (chỉ áp dụng khi ý tưởng gốc NÓI RÕ 2 hướng khác nhau, ví dụ "thân quay sang phải nhưng mắt vẫn nhìn thẳng camera"): "camera_view" LUÔN đại diện cho hướng THÂN NGƯỜI như bình thường; nếu mặt/ánh nhìn của nhân vật đang hướng KHÁC với thân, thêm khoá "face_view" (1 trong 6 giá trị góc như "camera_view", đại diện cho hướng MẶT) — ví dụ thân quay "three_quarter_right" nhưng mặt nhìn thẳng thì "camera_view": "three_quarter_right", "face_view": "front". Nếu mặt và thân cùng hướng (đa số trường hợp — mặc định), KHÔNG thêm khoá "face_view" (bỏ hẳn khoá này). Không tự suy diễn thêm hướng nhìn nếu ý tưởng gốc không nói.
Không tự bịa chi tiết không có trong ý tưởng gốc: nếu ý tưởng gốc không nhắc phụ kiện (túi, kính, mũ...) thì không tự thêm; nếu không nhắc biểu cảm thì giữ biểu cảm trung tính tự nhiên theo hành động, không tự thêm "cười"/"buồn" nếu không có căn cứ.
Lời thoại (chỉ áp dụng khi ý tưởng gốc CÓ trích dẫn/thể hiện rõ ràng nhân vật đang NÓI THÀNH LỜI ở đúng cảnh đó, ví dụ có dấu ngoặc kép hoặc "X nói:"): thêm khoá "dialogue" (chuỗi tiếng Việt, giữ NGUYÊN VĂN đúng câu nhân vật nói, KHÔNG dịch/diễn giải lại, dưới khoảng 15 từ để vừa thời lượng clip ngắn của 1 cảnh — nếu câu gốc dài hơn thì rút gọn nhưng giữ đúng ý chính). Cảnh nào truyện gốc không thể hiện lời nói thì KHÔNG thêm khoá "dialogue" (bỏ hẳn khoá này, không để rỗng/null). Không tự bịa thêm lời thoại không có trong ý tưởng gốc.
Bối cảnh vật lý (bắt buộc, MỌI cảnh): thêm khoá "location" (chuỗi tiếng Anh NGẮN GỌN, ví dụ "a cozy coffee shop interior, window table, soft morning light") mô tả nơi cảnh đang diễn ra, BAO GỒM cả ánh sáng/thời điểm trong ngày (sáng/trưa/chiều/tối, nắng/âm u...). QUAN TRỌNG: nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 chỗ, "location" của những cảnh đó PHẢI viết Y HỆT NHAU, ĐÚNG TỪNG CHỮ (không diễn đạt lại khác đi dù cùng ý nghĩa) — áp dụng đúng quy tắc như "outfit_override": chỉ đổi "location" (kể cả phần ánh sáng) khi ý tưởng gốc nói RÕ RÀNG nhân vật di chuyển sang nơi khác hoặc thời gian trôi qua rõ rệt (vd "trời tối dần", "đến chiều"). TUYỆT ĐỐI không tự đổi tông sáng/thời điểm trong ngày để tạo kịch tính (vd tự thêm "hoàng hôn ấm áp" cho cảnh chia tay/rời đi) nếu truyện gốc không nói tới — kể cả khi nhân vật chuẩn bị đứng dậy/rời khỏi chỗ đó, ánh sáng vẫn phải giữ nguyên như các cảnh trước đó tại cùng địa điểm.
Trạng thái kết thúc cảnh (bắt buộc, MỌI cảnh): thêm khoá "end_pose" (chuỗi tiếng Anh NGẮN GỌN, ví dụ "she has just turned to look out the window, smiling") mô tả tư thế/hành động của nhân vật ở khoảnh khắc KẾT THÚC cảnh đó (sau khi hành động trong "description" đã diễn ra) — dùng làm điểm nối sang cảnh kế tiếp.
Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ gồm đúng N phần tử, mỗi phần tử là 1 object có khoá "description" (chuỗi tiếng Anh mô tả cảnh, dùng để tạo ảnh AI), "camera_view" (1 trong 6 giá trị ở trên), "shot_size" (bắt buộc), "camera_angle" (bắt buộc), "camera_movement" (bắt buộc), "outfit_override" (tuỳ chọn), "face_view" (tuỳ chọn), "dialogue" (tuỳ chọn), "location" (bắt buộc) và "end_pose" (bắt buộc) như hướng dẫn trên — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích (comment) nào trong JSON.
Ví dụ format: [{"description": "a young woman walking into a coffee shop, morning light", "camera_view": "front", "shot_size": "wide_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a cozy coffee shop interior, window table", "end_pose": "she has just sat down and is looking around"}, {"description": "still at the coffee shop, she turns her head and looks outside the window, smiling", "camera_view": "three_quarter_left", "shot_size": "close_up", "camera_angle": "eye_level", "camera_movement": "static", "dialogue": "Quán này đẹp thật đấy", "location": "a cozy coffee shop interior, window table", "end_pose": "she is smiling, looking out the window"}, {"description": "later, standing by her front door at home, about to head out", "camera_view": "front", "shot_size": "medium_shot", "camera_angle": "eye_level", "camera_movement": "static", "outfit_override": "a beige knit cardigan over a white t-shirt", "location": "the front door of her home, entryway", "end_pose": "she is about to open the door and step outside"}]`;

// Tính năng THỬ NGHIỆM, mặc định TẮT — bật qua model_config.allow_scene_padding (đổi trực tiếp trong
// Supabase, không cần deploy lại code). Ngoại lệ CÓ PHẠM VI cho quy tắc "không bịa thêm tình tiết" ở
// trên: khi khách chỉ gợi ý ngắn (ít hành động thật) nhưng chọn N cảnh nhiều hơn số hành động đó, Agent
// hiện tại buộc phải lặp/kéo dài 1 hành động qua nhiều cảnh giống nhau (đúng nguyên nhân "3 cảnh giống
// nhau" đã phát hiện) — ngoại lệ này cho phép tự thêm khoảnh khắc CHUYỂN TIẾP hợp lý để lấp đủ N cảnh,
// nhưng vẫn giữ chặt không cho bịa THÊM tình tiết/địa điểm/nhân vật mới.
const SCENE_PADDING_INSTRUCTION =
  'Ngoại lệ CÓ PHẠM VI cho quy tắc "không bịa thêm tình tiết/hành động" ở trên: CHỈ khi số cảnh (N) NHIỀU HƠN số hành động/khoảnh khắc riêng biệt thực sự có trong ý tưởng gốc, được phép tự thêm các khoảnh khắc CHUYỂN TIẾP/TRUNG GIAN hợp lý giữa 2 hành động đã có (ví dụ: đang bước đi giữa 2 điểm, đang dừng lại quan sát, đang chuẩn bị trước khi làm hành động tiếp theo) để lấp đủ N cảnh cho mượt — đây KHÔNG được tính là "hành động mới", chỉ là chia nhỏ khoảng thời gian giữa các hành động đã có sẵn. TUYỆT ĐỐI không được: thêm tình tiết cốt truyện mới, thêm địa điểm mới, thêm nhân vật mới, đổi kết quả/diễn biến câu chuyện. Nếu N đã đủ hoặc ít hơn số hành động, KHÔNG áp dụng ngoại lệ này — vẫn tuân thủ đúng quy tắc "không bịa thêm" như bình thường.';

// Bước "Tạo Character" — chạy trước khi chia cảnh: biến (các) ảnh gốc khách tải lên (thường 1 góc,
// ánh sáng/nền lộn xộn) thành 1 ảnh sheet nhiều góc chuẩn (chính diện/3-4 trái/3-4 phải/nghiêng/sau
// lưng/cận mặt), dùng LÀM tham chiếu chung cho mọi lần gọi model ảnh phân cảnh sau đó — giúp nhân vật
// đồng nhất qua các cảnh tốt hơn nhiều so với dùng thẳng ảnh gốc lộn xộn mỗi lần. Cố định GPT Image 2
// (đã kiểm chứng qua nghiên cứu: model này dựng được bố cục nhiều-panel-trong-1-ảnh khá tin cậy qua 1
// lần gọi duy nhất — tính giá theo ĐỘ PHÂN GIẢI OUTPUT, không theo số panel trong ảnh).
const CHARACTER_SHEET_MODEL = "fal-ai/gpt-image-2/edit";
// Giá GPT Image 2 @1024px đã tra fal.ai (xem migration-story-video-gpt-image2-resolution.sql) — cố
// định 1 mức giá, không cho khách chọn độ phân giải riêng cho bước này (giữ đơn giản, đủ dùng làm
// ảnh tham chiếu nội bộ, không phải ảnh xuất bản cuối cùng).
export const CHARACTER_PROVIDER_COST_VND = 5700;
const CHARACTER_SHEET_PROMPT =
  "You are given one or more reference images of the SAME person — they may be ordinary photos and/or an existing multi-panel character sheet. Do NOT simply copy, crop, or pass through any single input image as-is, even if one of them already looks like a finished sheet. Always render a brand-new single image from scratch: one wide landscape canvas on a neutral light-gray studio background, divided into 6 equal panels labeled 1) FRONT VIEW (full body), 2) 3/4 LEFT VIEW (full body), 3) 3/4 RIGHT VIEW (full body), 4) SIDE VIEW (full body), 5) BACK VIEW (full body), 6) FACE CLOSE-UP. Extract the person's face, hairstyle, outfit, and body proportions by combining evidence from ALL provided reference images equally, and keep them identical and consistent across all six panels — do not invent a different person. Even, soft studio lighting, photorealistic, sharp focus.";

// Chế độ "Mô tả bằng chữ" (không có ảnh tham chiếu thật) — dùng bản TEXT-TO-IMAGE thuần của cùng GPT
// Image 2 (không có hậu tố "/edit", đã tra fal.ai/models/fal-ai/gpt-image-2 xác nhận nhận "prompt" +
// "image_size" + "quality", KHÔNG nhận image_url(s)) thay vì bản edit ở trên. Giữ NGUYÊN bố cục 6 ô 3x2
// y hệt CHARACTER_SHEET_PROMPT (chỉ đổi "extract từ ảnh" thành "tự bịa từ mô tả") để
// cropCharacterSheetIntoAngles() cắt góc đúng như sheet tạo từ ảnh thật, không cần sửa gì ở bước cắt.
const CHARACTER_TEXT_TO_IMAGE_MODEL = "fal-ai/gpt-image-2";
function buildCharacterSheetTextPrompt(description: string): string {
  return `Create a brand-new fictional character based ONLY on this text description (no reference photo exists) — invent a consistent, photorealistic appearance matching: "${description}". Render ONE wide landscape canvas on a neutral light-gray studio background, divided into 6 equal panels labeled 1) FRONT VIEW (full body), 2) 3/4 LEFT VIEW (full body), 3) 3/4 RIGHT VIEW (full body), 4) SIDE VIEW (full body), 5) BACK VIEW (full body), 6) FACE CLOSE-UP. Keep the SAME face, hairstyle, outfit, and body proportions perfectly identical and consistent across all six panels. Even, soft studio lighting, photorealistic, sharp focus, real photograph — not illustration, painting, or anime.`;
}

// Phân loại ảnh khách vừa tải lên: đã là 1 sheet nhiều góc (không cần tạo lại, dùng thẳng) hay chỉ là
// 1 ảnh chụp thường (cần chạy bước Tạo Character). Dùng Gemini Flash (đã có sẵn qua callOpenRouter,
// chi phí ~18đ/lần — rẻ hơn ảnh Character ~300 lần) thay vì đoán bằng heuristic không đáng tin.
const CHARACTER_CLASSIFY_SYSTEM_PROMPT = `Bạn là trợ lý phân loại ảnh. Nhìn ảnh được cung cấp và trả lời DUY NHẤT 1 từ, không giải thích, không thêm chữ nào khác:
- "SHEET" nếu ảnh là 1 tấm ghép nhiều ô/panel thể hiện nhiều góc nhìn khác nhau (chính diện, nghiêng, sau lưng...) của CÙNG một người.
- "PHOTO" nếu ảnh chỉ là 1 bức ảnh chụp thường (1 người, 1 góc, không chia ô).`;

export async function classifyCharacterImage(imageUrl: string): Promise<boolean> {
  try {
    const { output } = await callOpenRouter(
      "google/gemini-3-flash-preview",
      300,
      CHARACTER_CLASSIFY_SYSTEM_PROMPT,
      "Phân loại ảnh này.",
      imageUrl
    );
    // maxTokens nhỏ trước đây (10 -> 30) vẫn có thể bị cắt cụt: xác nhận thật qua job #156, model trả về
    // đúng "SHE" (thiếu "ET") -> rơi về coi như ảnh thường dù ảnh khách tải lên ĐÃ LÀ sheet thật, khiến
    // job chạy nhầm bước Tạo Character (tốn credit, có lúc còn lỗi 422 luôn). Model này ("thinking" model)
    // tốn 1 phần token cho suy nghĩ nội bộ TRƯỚC khi ra chữ trả lời -- max_tokens quá chật ăn hết vào phần
    // suy nghĩ, cắt cụt luôn câu trả lời thật. Nới hẳn lên 300 (không tốn thêm phí nếu model trả lời gọn
    // như bình thường, chỉ để không bị cắt cụt khi cần vài token suy nghĩ) + so khớp bằng includes (không
    // chỉ startsWith) để không bỏ lỡ khi model có thêm chữ thừa dù đã yêu cầu trả đúng 1 từ.
    const cleaned = output.trim().toUpperCase();
    const isSheet = cleaned.includes("SHEET");
    if (!isSheet && !cleaned.includes("PHOTO")) {
      console.error(`[classifyCharacterImage] Phản hồi không rõ ràng, coi như ảnh thường: "${output}"`);
    }
    return isSheet;
  } catch (err) {
    // Lỗi gọi AI phân loại -> coi như ảnh thường, chạy bước Tạo Character cho chắc (an toàn hơn bỏ qua).
    console.error("[classifyCharacterImage] Lỗi gọi AI phân loại:", err);
    return false;
  }
}

// Dò TẤT CẢ ảnh khách tải lên (không chỉ ảnh đầu) — khách có thể tải nhiều ảnh, trong đó 1 ảnh nào đó
// (không nhất thiết ảnh đầu tiên) đã là sheet nhiều góc sẵn. Trả về URL ảnh sheet đầu tiên tìm được,
// hoặc null nếu không ảnh nào là sheet (cần chạy bước Tạo Character từ toàn bộ ảnh).
export async function findExistingCharacterSheet(imageUrls: string[]): Promise<string | null> {
  for (const url of imageUrls) {
    if (await classifyCharacterImage(url)) return url;
  }
  return null;
}

// Kiểm tra TOÀN BỘ ảnh vừa tải lên (không chỉ 1 ảnh) — chỉ true khi TẤT CẢ đều đã là sheet nhiều góc
// sẵn (không có ảnh thường lẫn vào). Dùng để quyết định có thể bỏ qua bước tạo Character MỚI hay
// không, khác với findExistingCharacterSheet (chỉ cần tìm thấy 1 ảnh là sheet, dùng cho nút "Kiểm tra
// ảnh" xem trước).
export async function classifyAllAreSheets(imageUrls: string[]): Promise<boolean> {
  for (const url of imageUrls) {
    if (!(await classifyCharacterImage(url))) return false;
  }
  return true;
}

type SceneQcResult = { ok: boolean; issue?: string };

function parseSceneQcResponse(output: string): SceneQcResult {
  const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (typeof parsed?.ok !== "boolean") throw new Error("Phản hồi AI không hợp lệ");
  return { ok: parsed.ok, issue: typeof parsed.issue === "string" ? parsed.issue : undefined };
}

const SCENE_ANATOMY_CHECK_PROMPT = `Bạn là chuyên gia kiểm tra ảnh do AI tạo ra để phát hiện lỗi. Xem kỹ bức ảnh và trả lời ĐÚNG 1 dòng JSON duy nhất, không thêm chữ nào khác:
{"ok": true} nếu ảnh không có lỗi rõ ràng, hoặc
{"ok": false, "issue": "<mô tả ngắn gọn bằng tiếng Việt lỗi tìm thấy>"} nếu có ít nhất 1 trong các lỗi sau:
- Thiếu tay/chân, thừa/thiếu ngón tay, chi thể bị biến dạng bất thường
- Khuôn mặt bị lỗi, nhân đôi, hoặc mờ chồng lên nhau (ghosting)
- Có chữ, số, nhãn, watermark xuất hiện trong ảnh
- Có nhiều hơn 1 người trong ảnh (kể cả 1 người mờ/khuất trong nền)
Chỉ báo lỗi khi THẬT SỰ rõ ràng nhìn thấy được — không đoán hoặc báo lỗi vì lý do thẩm mỹ (dáng hơi gượng, ánh sáng chưa đẹp...), những điểm đó KHÔNG tính là lỗi.`;

// "Kiểm tra thiếu chi thể" — nút thủ công, khách tự bấm khi nghi ngờ ảnh phân cảnh bị lỗi (không trừ
// credit, cùng tiền lệ classifyCharacterImage: Gemini Flash rẻ, ~18đ/lượt). Xem chú thích
// checkSceneContinuity() bên dưới cho loại kiểm tra thứ 2 (lệch ảnh đầu/cuối).
export async function checkSceneAnatomy(imageUrl: string, miniAppId?: string): Promise<SceneQcResult> {
  const override = await resolveSkillOverride(miniAppId, "continuity_checker_prompt");
  const systemPrompt = override ? `${SCENE_ANATOMY_CHECK_PROMPT}\n\nGhi chú thêm từ admin: ${override}` : SCENE_ANATOMY_CHECK_PROMPT;
  const { output } = await callOpenRouter("google/gemini-3-flash-preview", 200, systemPrompt, "Kiểm tra ảnh này.", imageUrl);
  return parseSceneQcResponse(output);
}

const SCENE_CONTINUITY_CHECK_PROMPT = `Bạn là chuyên gia kiểm tra ảnh do AI tạo ra. Bạn được xem 2 ảnh: ảnh THỨ NHẤT là khung hình ĐẦU của 1 cảnh quay, ảnh THỨ HAI là khung hình CUỐI của CHÍNH cảnh đó (2 khung hình cách nhau vài giây trong cùng 1 cú máy quay liên tục, không cắt cảnh). Kiểm tra xem 2 ảnh có thể hiện ĐÚNG cùng 1 vị trí/không gian không — cùng đồ nội thất (giường/sofa/bàn/ghế...), cùng bố cục phòng, cùng góc máy/khung hình. Trả lời ĐÚNG 1 dòng JSON duy nhất, không thêm chữ nào khác:
{"ok": true} nếu 2 ảnh khớp nhau về không gian/đồ nội thất/góc máy, hoặc
{"ok": false, "issue": "<mô tả ngắn gọn tiếng Việt điểm khác biệt bất thường>"} nếu phát hiện khác biệt rõ ràng (vd đồ nội thất đổi khác, phòng khác hẳn, góc máy nhảy cóc).
Chỉ báo lỗi khi khác biệt THẬT RÕ RÀNG — thay đổi nhỏ về ánh sáng/tư thế nhân vật KHÔNG tính là lỗi.`;

// "Kiểm tra lệch ảnh đầu/cuối" — chỉ áp dụng cho job bật chuyển động liên tục (mỗi cảnh có cả
// image_url và end_image_url). Gửi CẢ 2 ảnh trong 1 lượt gọi (callOpenRouter đã hỗ trợ mảng ảnh).
export async function checkSceneContinuity(startImageUrl: string, endImageUrl: string, miniAppId?: string): Promise<SceneQcResult> {
  const override = await resolveSkillOverride(miniAppId, "continuity_checker_prompt");
  const systemPrompt = override ? `${SCENE_CONTINUITY_CHECK_PROMPT}\n\nGhi chú thêm từ admin: ${override}` : SCENE_CONTINUITY_CHECK_PROMPT;
  const { output } = await callOpenRouter("google/gemini-3-flash-preview", 200, systemPrompt, "Kiểm tra 2 ảnh này.", [
    startImageUrl,
    endImageUrl,
  ]);
  return parseSceneQcResponse(output);
}

const SCENE_BLANK_CHECK_PROMPT = `Bạn kiểm tra xem ảnh này có phải là ảnh THẬT có nội dung hay không. Trả lời ĐÚNG 1 dòng JSON, không thêm chữ nào khác:
{"ok": true} nếu ảnh có nội dung thật (nhìn thấy người/cảnh vật rõ ràng), hoặc
{"ok": false, "issue": "<mô tả ngắn gọn tiếng Việt>"} nếu ảnh là 1 màu đồng nhất (đen/xám/trắng toàn bộ), bị hỏng, hoặc trống rỗng không có nội dung gì.`;

// Fal.ai đôi khi trả về "thành công" (có URL ảnh thật, không phải lỗi) nhưng nội dung ảnh là 1 màu đen
// đồng nhất — thường do bộ lọc nội dung nội bộ của model chặn ngầm mà không báo lỗi rõ ràng qua API.
// Code cũ chỉ coi là lỗi khi Fal.ai trả status ERROR — ảnh đen "thành công giả" này lọt qua hoàn toàn,
// job cứ thế đi tiếp dùng ảnh hỏng làm nền cho video (xác nhận qua ảnh chụp màn hình thật của khách,
// job story-100: "Cảnh 1" hiện ảnh đen thui, nhưng job vẫn tự tạo video hoàn chỉnh với các cảnh sau).
async function checkImageNotBlank(imageUrl: string): Promise<SceneQcResult> {
  const { output } = await callOpenRouter("google/gemini-3-flash-preview", 100, SCENE_BLANK_CHECK_PROMPT, "Kiểm tra ảnh này.", imageUrl);
  return parseSceneQcResponse(output);
}

// Siết khắt khe hơn bản gốc (xác nhận thật qua Frame-chain + H3 Max: bản cũ cho "ok:true" dù mặt đã
// lệch rõ khi so sánh trực tiếp 2 khung hình đầu/cuối chuỗi — quá dễ dãi, thiên về chấp nhận trừ khi
// "thật sự rõ ràng khác người"). Đổi hướng: mặc định NGHI NGỜ, chỉ chấp nhận khi cấu trúc khuôn mặt
// (không phải biểu cảm/góc chụp) khớp rõ ràng — không chắc thì báo sai để hệ thống tự vẽ lại, thà tốn
// thêm 1 lượt vẽ còn hơn để lọt mặt khác người.
const SCENE_IDENTITY_CHECK_PROMPT = `Bạn kiểm tra xem 2 ảnh có phải CÙNG 1 người hay không, với tiêu chuẩn NGHIÊM NGẶT. Ảnh THỨ NHẤT là ảnh gốc chuẩn của nhân vật, ảnh THỨ HAI là ảnh AI vừa vẽ ra cho 1 cảnh khác (khác tư thế/góc máy/ánh sáng/biểu cảm).

So sánh KỸ từng đặc điểm cấu trúc khuôn mặt — không bị ảnh hưởng bởi biểu cảm nhất thời (cười/không cười), góc chụp, hay ánh sáng:
- Hình dáng tổng thể khuôn mặt (tròn/oval/vuông/trái xoan/thon dài)
- Hình dáng và khoảng cách 2 mắt
- Sống mũi và đầu mũi
- Hình dáng môi
- Đường chân mày
- Cấu trúc gò má/quai hàm

Trả lời ĐÚNG 1 dòng JSON, không thêm chữ nào khác:
{"ok": true} CHỈ khi các đặc điểm cấu trúc trên khớp nhau rõ ràng, hoặc
{"ok": false, "issue": "<mô tả ngắn gọn tiếng Việt đặc điểm nào khác biệt>"} nếu BẤT KỲ đặc điểm cấu trúc nào (dáng mặt/mắt/mũi/môi/chân mày/gò má) khác biệt đáng kể — "trông tổng thể có vẻ giống" (cùng kiểu tóc, cùng tông da, cùng phong cách) KHÔNG ĐỦ để coi là cùng 1 người nếu cấu trúc khuôn mặt lệch.

Ưu tiên AN TOÀN: nếu không chắc chắn rõ ràng là cùng 1 người, chọn {"ok": false} — thà vẽ lại dư 1 lần còn hơn để lọt sai người.`;

// Frame-chaining — lưới an toàn lớp 2 (bên cạnh việc luôn kèm ảnh Character trong prompt ở lớp 1): so
// ảnh vừa vẽ với ĐÚNG ảnh Character gốc (không phải khung hình chain cảnh trước) để phát hiện trôi danh
// tính qua nhiều cảnh liên tiếp — xem applyFrameChainImageResult().
async function checkSceneIdentityMatch(characterReferenceUrl: string, newImageUrl: string, miniAppId?: string): Promise<SceneQcResult> {
  const override = await resolveSkillOverride(miniAppId, "continuity_checker_prompt");
  const systemPrompt = override ? `${SCENE_IDENTITY_CHECK_PROMPT}\n\nGhi chú thêm từ admin: ${override}` : SCENE_IDENTITY_CHECK_PROMPT;
  const { output } = await callOpenRouter("google/gemini-3-flash-preview", 200, systemPrompt, "So sánh 2 ảnh này.", [
    characterReferenceUrl,
    newImageUrl,
  ]);
  return parseSceneQcResponse(output);
}

// count > 1 dùng cho job nhiều nhân vật — chỉ tính phí đúng số người THẬT SỰ cần AI tạo Character mới
// (bỏ qua người tái dùng thư viện/đã là sheet sẵn), mặc định 1 giữ nguyên hành vi cho mọi chỗ gọi cũ.
export async function computeCharacterCreditCost(count = 1): Promise<{ providerCostVnd: number; creditCost: number }> {
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const providerCostVnd = CHARACTER_PROVIDER_COST_VND * count;
  const creditCost = computeDynamicCreditCost(providerCostVnd, marginPercent, vndPerCredit);
  return { providerCostVnd, creditCost };
}

export type ImageModelEntry = {
  key: string;
  provider: string;
  label: string;
  model: string;
  provider_cost_vnd: number;
  multi_image: boolean;
  enabled: boolean;
  aspect_ratios?: string[];
  // Có thì frontend hiện dropdown "Độ phân giải", giá đổi theo lựa chọn — model không có field này
  // (vd Flux Kontext) chỉ dùng 1 giá cố định provider_cost_vnd, không hiện dropdown.
  resolution_price_vnd?: Record<string, number>;
};

export type VideoModelEntry = {
  key: string;
  provider: string;
  label: string;
  model: string;
  provider_cost_vnd: number;
  enabled: boolean;
  aspect_ratios?: string[];
  // Có thì frontend hiện dropdown "Thời lượng", giá đổi theo lựa chọn — cùng khuôn
  // provider_cost_vnd_by_duration đã dùng cho app "Tạo video quảng cáo ngắn" (lib/ai-router.ts).
  duration_price_vnd?: Record<string, number>;
  // true = model video này CHẤP NHẬN gửi kèm ảnh Character (mặt/góc) làm "nguyên liệu nền" ngay lúc
  // TẠO VIDEO, không chỉ dựa vào đúng 1 ảnh bắt đầu cảnh (xem fal-ai/kling-video/o1/reference-to-video
  // và fal-ai/veo3.1/reference-to-video — đã kiểm chứng thật qua API, khác hẳn các model video khác
  // trong catalog vốn chỉ nhận đúng 1 image_url). Đây chính là điểm khắc phục lỗi "khuôn mặt đổi khi
  // nhân vật quay lại camera" — model có ảnh mặt Character làm căn cứ xuyên suốt, không phải tự bịa.
  character_reference?: boolean;
};

export type SceneRow = {
  id: number;
  job_id: number;
  position: number;
  scene_description: string | null;
  end_description: string | null;
  camera_view: string | null;
  shot_size: string | null;
  camera_angle: string | null;
  camera_movement: string | null;
  outfit_override: string | null;
  face_view: string | null;
  motion_prompt: string | null;
  motion_duration_key: string | null;
  natural_duration_seconds: number | null;
  pace: string | null;
  rotation_degrees: number | null;
  location: string | null;
  end_pose: string | null;
  character_positions: number[] | null;
  image_fal_request_id: string | null;
  image_url: string | null;
  end_image_url: string | null;
  end_image_fal_request_id: string | null;
  video_fal_request_id: string | null;
  video_url: string | null;
  dialogue_line: string | null;
  dialogue_speaker_position: number | null;
  dialogue_audio_url: string | null;
  lipsync_fal_request_id: string | null;
  lipsync_url: string | null;
  last_frame_url: string | null;
};

// Vị trí đứng chính xác (mask) khi cảnh có NHIỀU nhân vật cùng chung 1 ảnh Bối cảnh — mỗi zone gán
// đúng 1 nhân vật (theo "position" trong story_video_job_characters) với toạ độ chuẩn hoá 0..1 của
// vùng khách khoanh (relative to ảnh gốc). Xem giải thích đầy đủ tại JobRow.location_reference_mask_zones.
export type LocationMaskZone = { position: number; xPct: number; yPct: number; wPct: number; hPct: number };

type JobRow = {
  id: number;
  user_id: string;
  mini_app_id: string;
  status: string;
  updated_at: string;
  auto_video: boolean;
  image_credit_tx_id: number | null;
  video_credit_tx_id: number | null;
  character_credit_tx_id: number | null;
  lipsync_credit_tx_id: number | null;
  image_provider_cost_vnd_per_scene: number | null;
  video_provider_cost_vnd_per_scene: number | null;
  num_scenes: number;
  story_description: string;
  character_image_urls: string[];
  // Chế độ "Mô tả bằng chữ" (không có ảnh tham chiếu thật) — lưu lại mô tả để regenerateCharacter()
  // dùng lại đúng mô tả cũ, không bắt khách gõ lại. Null khi job dùng ảnh thật/thư viện như bình thường.
  character_appearance_description: string | null;
  character_sheet_url: string | null;
  character_fal_request_id: string | null;
  image_model: string | null;
  video_model: string | null;
  aspect_ratio: string | null;
  image_resolution_key: string | null;
  video_duration_key: string | null;
  character_angle_urls: CharacterAngleUrls | null;
  genre_key: string | null;
  location_reference_url: string | null;
  // Vị trí đứng chính xác trong ảnh location_reference_url — ảnh mask cùng kích thước (trắng = đặt nhân
  // vật vào đây, đen = giữ nguyên) do khách khoanh vùng ở frontend. Chỉ có tác dụng khi image_model là
  // "fal-ai/gpt-image-2/edit" (model duy nhất hỗ trợ mask_url, xem buildImageRequestBody).
  location_reference_mask_url: string | null;
  // Nhiều nhân vật, nhiều vị trí trong CÙNG 1 ảnh Bối cảnh — mỗi phần tử là 1 vùng (toạ độ chuẩn hoá
  // 0..1) khách đã gán cho đúng 1 "position" (chỉ số nhân vật trong story_video_job_characters). Chỉ
  // dùng ở nhánh nhiều nhân vật (submitMultiCharacterSceneImageForRow) — location_reference_mask_url
  // vẫn là ẢNH MASK DUY NHẤT gộp tất cả vùng trắng lại (mask_url không tự phân biệt vùng nào cho ai),
  // mảng này chỉ để BIẾT vùng nào ứng với nhân vật nào, dùng viết chỉ dẫn văn bản mô tả từng vùng theo
  // vị trí tương đối (trái/phải/giữa...) trong prompt — xem describeMaskZonePosition().
  location_reference_mask_zones: LocationMaskZone[] | null;
  item_reference_url: string | null;
  item_reference_urls: string[] | null;
  continuous_motion: boolean;
  frame_chain_mode: boolean;
  // Bước "Tạo kịch bản" — lưu lại mảng "actions" khách đã xác nhận lúc submit, để continueStoryVideoToSceneStage
  // (khi Character phải tạo mới, chạy sau qua webhook) vẫn dùng lại đúng kịch bản đã hiện giá cho khách,
  // không phải chia cảnh lại từ đầu bằng splitStoryIntoScenes (LLM cũ).
  preplanned_actions: ScriptSceneResult[] | null;
};

async function getMiniAppModelConfig(miniAppId: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("mini_apps").select("credit_cost, model_config").eq("id", miniAppId).single();
  if (!data) throw new Error("Không tìm thấy Mini App");
  return data as {
    credit_cost: number;
    model_config: {
      image_models: ImageModelEntry[];
      video_models: VideoModelEntry[];
      prompt_helper_instructions?: string;
      character_prompt?: string;
      genre_style_guides?: Record<string, string>;
      lipsync_model?: string;
      lipsync_provider_cost_vnd?: number;
      // 7-skill architecture — mỗi field dưới đây là "nội dung skill" 1 bước AI riêng, admin sửa qua
      // /admin, rỗng thì hàm tương ứng tự dùng bản mặc định hardcode. 2 skill còn lại (story-planner,
      // character-manager) dùng lại 2 field phía trên (prompt_helper_instructions, character_prompt).
      story_extractor_prompt?: string;
      story_validator_prompt?: string;
      scene_image_prompt?: string;
      motion_planner_prompt?: string;
      continuity_checker_prompt?: string;
      // Thử nghiệm, mặc định TẮT — xem chú thích tại SCENE_PADDING_INSTRUCTION. Bật qua Supabase
      // (update mini_apps set model_config = model_config || '{"allow_scene_padding": true}'::jsonb
      // where id = 'video-tu-y-tuong';), không cần deploy lại code.
      allow_scene_padding?: boolean;
    };
  };
}

// Prompt tạo Character — admin sửa được qua /admin (model_config.character_prompt), rỗng thì dùng bản
// mặc định 6 góc (CHARACTER_SHEET_PROMPT).
async function resolveCharacterPrompt(miniAppId: string): Promise<string> {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const override = miniApp.model_config.character_prompt;
  return override?.trim() ? override.trim() : CHARACTER_SHEET_PROMPT;
}

// 3 skill còn lại (scene-image, motion-planner, continuity-checker) — admin ghi thêm ghi chú qua
// /admin, rỗng thì bỏ qua hoàn toàn (không đổi hành vi mặc định). Không throw nếu thiếu miniAppId
// (continuity-checker gọi từ nút thủ công, có thể chưa luôn có).
async function resolveSkillOverride(
  miniAppId: string | undefined,
  field:
    | "scene_image_prompt"
    | "motion_planner_prompt"
    | "continuity_checker_prompt"
    | "story_extractor_prompt"
    | "story_validator_prompt"
): Promise<string | undefined> {
  if (!miniAppId) return undefined;
  const miniApp = await getMiniAppModelConfig(miniAppId);
  return miniApp.model_config[field]?.trim() || undefined;
}

// Skill "story-extractor" — viết lại ý tưởng thô thành bản rõ ràng hơn CHỈ để dùng nội bộ khi chia
// cảnh (không ghi đè story_description gốc lưu trong job, khách vẫn thấy đúng nguyên văn đã gõ). Lỗi
// gì cũng rơi về dùng nguyên văn gốc — bước này chỉ là cải thiện chất lượng, không phải bắt buộc.
async function extractStoryEssentials(storyDescription: string, miniAppId: string, modelChatKey?: string): Promise<string> {
  try {
    const override = await resolveSkillOverride(miniAppId, "story_extractor_prompt");
    const systemPrompt = override ? `${STORY_EXTRACTOR_DEFAULT_PROMPT}\n\nGhi chú thêm từ admin: ${override}` : STORY_EXTRACTOR_DEFAULT_PROMPT;
    const { output } = await callOpenRouter(modelChatKey || "google/gemini-3-flash-preview", 500, systemPrompt, storyDescription);
    return output.trim() || storyDescription;
  } catch (err) {
    console.error("[story-video] Lỗi story-extractor, dùng nguyên văn gốc:", err);
    return storyDescription;
  }
}

// Skill "story-validator" — kiểm tra bản chia cảnh có phản ánh đúng truyện gốc không. Lỗi gì cũng coi
// như PASS (không chặn job vì 1 bước kiểm tra thêm bị lỗi kỹ thuật).
async function validateSceneSplit(
  storyDescription: string,
  scenes: { description: string }[],
  miniAppId: string,
  modelChatKey?: string
): Promise<SceneQcResult> {
  try {
    const override = await resolveSkillOverride(miniAppId, "story_validator_prompt");
    const systemPrompt = override ? `${STORY_VALIDATOR_DEFAULT_PROMPT}\n\nGhi chú thêm từ admin: ${override}` : STORY_VALIDATOR_DEFAULT_PROMPT;
    const scenesText = scenes.map((s, i) => `Cảnh ${i + 1}: ${s.description}`).join("\n");
    const { output } = await callOpenRouter(
      modelChatKey || "google/gemini-3-flash-preview",
      200,
      systemPrompt,
      `Truyện gốc:\n${storyDescription}\n\nCác cảnh đã chia:\n${scenesText}`
    );
    return parseSceneQcResponse(output);
  } catch (err) {
    console.error("[story-video] Lỗi story-validator, coi như đạt:", err);
    return { ok: true };
  }
}

// Chọn đúng entry theo key nếu còn bật (enabled) — key thiếu/sai/bị tắt thì rơi về entry bật đầu
// tiên trong catalog (giữ app luôn chạy được kể cả khi admin vừa tắt model khách đang chọn dở).
function resolveModelEntry<T extends { key: string; enabled: boolean }>(entries: T[], key: string | undefined): T {
  const found = key ? entries.find((e) => e.key === key && e.enabled) : undefined;
  const fallback = found ?? entries.find((e) => e.enabled);
  if (!fallback) throw new Error("Không có model nào đang bật trong catalog");
  return fallback;
}

// Chọn key trong 1 bảng giá theo lựa chọn/độ phân giải/thời lượng — key thiếu/sai thì rơi về key
// đầu tiên trong bảng (giữ app luôn tính được giá kể cả khi frontend gửi key cũ không còn tồn tại).
function resolvePricedKey(priceMap: Record<string, number>, key: string | undefined): { key: string; costVnd: number } {
  const resolvedKey = key && priceMap[key] !== undefined ? key : Object.keys(priceMap)[0];
  return { key: resolvedKey, costVnd: priceMap[resolvedKey] };
}

async function resolveCosts(
  miniAppId: string,
  numScenes: number,
  imageModelKey?: string,
  videoModelKey?: string,
  resolutionKey?: string,
  durationKey?: string,
  continuousMotion?: boolean
) {
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const imageEntry = resolveModelEntry(miniApp.model_config.image_models, imageModelKey);
  const videoEntry = resolveModelEntry(miniApp.model_config.video_models, videoModelKey);

  let imageProviderCostVnd = imageEntry.provider_cost_vnd;
  let resolvedResolutionKey: string | undefined;
  if (imageEntry.resolution_price_vnd) {
    const resolved = resolvePricedKey(imageEntry.resolution_price_vnd, resolutionKey);
    resolvedResolutionKey = resolved.key;
    imageProviderCostVnd = resolved.costVnd;
  }

  let videoProviderCostVnd = videoEntry.provider_cost_vnd;
  let resolvedDurationKey: string | undefined;
  if (videoEntry.duration_price_vnd) {
    const resolved = resolvePricedKey(videoEntry.duration_price_vnd, durationKey);
    resolvedDurationKey = resolved.key;
    videoProviderCostVnd = resolved.costVnd;
  }

  // Chế độ chuyển động liên tục: chuỗi N+1 ảnh cho N cảnh (ảnh cuối cảnh N = ảnh đầu cảnh N+1, không
  // phải 2N ảnh) — xem lib này, runSceneStage/applyImageStageResult.
  const imageCallCount = continuousMotion ? numScenes + 1 : numScenes;

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const imageCost = computeDynamicCreditCost(imageProviderCostVnd * imageCallCount, marginPercent, vndPerCredit);
  const videoCost = computeDynamicCreditCost(videoProviderCostVnd * numScenes, marginPercent, vndPerCredit);
  return {
    imageEntry,
    videoEntry,
    imageCost,
    videoCost,
    totalCost: imageCost + videoCost,
    imageProviderCostVnd,
    videoProviderCostVnd,
    resolvedResolutionKey,
    resolvedDurationKey,
    promptHelperInstructions: miniApp.model_config.prompt_helper_instructions,
  };
}

export async function computeStoryVideoCreditCost(
  miniAppId: string,
  numScenes: number,
  imageModelKey?: string,
  videoModelKey?: string,
  resolutionKey?: string,
  durationKey?: string,
  continuousMotion?: boolean
): Promise<{ imageCost: number; videoCost: number; totalCost: number }> {
  const { imageCost, videoCost, totalCost } = await resolveCosts(
    miniAppId,
    numScenes,
    imageModelKey,
    videoModelKey,
    resolutionKey,
    durationKey,
    continuousMotion
  );
  return { imageCost, videoCost, totalCost };
}

// Body request Fal.ai theo model ảnh — mỗi model có field tên khác nhau đã tra kỹ docs thật (tránh
// lặp lỗi 422 do gửi sai tên field từng gặp với LTX):
// - GPT Image 2 edit: image_size — đã tra lại schema thật (fal.ai openapi), field này CÓ hỗ trợ theo
//   tỉ lệ qua preset chuỗi ("landscape_16_9"/"portrait_16_9"/"square_hd") hoặc object {width,height}
//   tự do — không phải chỉ "auto"/"square_hd"/{3840x2160} cố định như trước (bug cũ bỏ qua aspectRatio
//   hoàn toàn). Preset "4K" dùng object width/height để giữ đúng cả tỉ lệ lẫn mức giá đã tính theo
//   tổng pixel; mức "1024" dùng preset chuỗi theo đúng tỉ lệ.
// - Nano Banana Pro edit: resolution nhận "1K"/"2K"/"4K".
// - Còn lại (Flux Kontext...): aspect_ratio thường.
function buildImageRequestBody(
  model: string,
  prompt: string | null,
  characterImageUrls: string[],
  multiImage: boolean,
  aspectRatio: string,
  resolutionKey?: string,
  // Vị trí đứng chính xác trong ảnh Bối cảnh/Địa điểm (xem resolveCharacterPhotoDirectlyUrl-style chú
  // thích ở nơi gọi) — CHỈ có tác dụng thật với "fal-ai/gpt-image-2/edit" (model DUY NHẤT trong catalog
  // hỗ trợ tham số mask_url theo tài liệu fal.ai đã tra: vùng TRẮNG = được sửa/đặt nhân vật vào, vùng
  // ĐEN = giữ nguyên pixel gốc, mask phải cùng kích thước ảnh gốc). Model khác im lặng bỏ qua tham số
  // này (không throw lỗi) — nơi gọi đã tự kiểm tra đúng model trước khi truyền vào.
  maskUrl?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt };
  if (multiImage) body.image_urls = characterImageUrls;
  else body.image_url = characterImageUrls[0];

  if (model === "fal-ai/gpt-image-2/edit") {
    if (maskUrl) body.mask_url = maskUrl;
    if (resolutionKey === "4K") {
      if (aspectRatio === "16:9") body.image_size = { width: 3840, height: 2160 };
      else if (aspectRatio === "9:16") body.image_size = { width: 2160, height: 3840 };
      else body.image_size = { width: 2880, height: 2880 };
    } else if (resolutionKey === "1024") {
      if (aspectRatio === "16:9") body.image_size = "landscape_16_9";
      else if (aspectRatio === "9:16") body.image_size = "portrait_16_9";
      else body.image_size = "square_hd";
    } else {
      body.image_size = "auto";
    }
    return body;
  }
  body.aspect_ratio = aspectRatio;
  if (resolutionKey) body.resolution = resolutionKey;
  return body;
}

// Ảnh Character dùng làm "nguyên liệu nền" khi tạo VIDEO (khác hẳn ảnh Character dùng lúc tạo ẢNH TĨNH
// — selectReferenceImagesForScene chọn theo camera_view riêng từng cảnh). Ở đây luôn dùng CỐ ĐỊNH đúng
// 1 bộ ảnh (mặt + 1-2 góc khác) cho MỌI cảnh trong job, không đổi theo camera_view của từng cảnh — vì
// mục đích là cho model video có sẵn ảnh mặt làm căn cứ xuyên suốt, bất kể ảnh bắt đầu cảnh đó đang quay
// hướng nào (đây chính là thông tin còn thiếu gây lỗi "khuôn mặt đổi khi quay lại camera").
type VideoCharacterReference = { frontal: string; extras: string[] };

function selectCharacterReferenceImages(
  angleUrls: CharacterAngleUrls | null,
  sheetUrl: string | null
): VideoCharacterReference | undefined {
  if (!sheetUrl) return undefined;
  // Xác nhận qua lỗi 422 THẬT lần 2 trên production ("elementReferList: size must be between 1 and 3"):
  // khác với suy đoán ban đầu, Kling KHÔNG coi "reference_image_urls" là tuỳ chọn thật — bỏ hẳn key này
  // (mảng 0 phần tử) vẫn bị từ chối, dù tài liệu ghi optional. Luôn phải có ÍT NHẤT 1 ảnh trong đó. Khi
  // job không có character_angle_urls (chưa cắt góc riêng), dùng lại chính ảnh sheet Character GỐC (bố
  // cục 6 ô) làm ảnh tham chiếu phụ — vẫn là 1 ảnh THẬT KHÁC nội dung, không phải lặp lại đúng ảnh mặt.
  if (!angleUrls) return { frontal: sheetUrl, extras: [sheetUrl] };
  const frontal = angleUrls.face ?? angleUrls.front ?? sheetUrl;
  const extras = [angleUrls.front, angleUrls.three_quarter_left, angleUrls.three_quarter_right].filter(
    (url): url is string => !!url && url !== frontal
  );
  if (extras.length === 0) extras.push(sheetUrl);
  return { frontal, extras };
}

// Body request Fal.ai theo model video — VEO cần hậu tố "s" cho duration ("6s", không phải "6"),
// Hailuo cố định resolution "768P" để khớp đúng giá đã nghiên cứu, còn lại theo mẫu Kling/LTX sẵn có.
// characterReference chỉ có giá trị khi model đang chọn có "character_reference: true" trong catalog
// (xem selectCharacterReferenceImages) — model không hỗ trợ thì tham số này luôn undefined, bỏ qua.
function buildVideoRequestBody(
  model: string,
  prompt: string | null,
  imageUrl: string,
  aspectRatio: string,
  durationKey?: string,
  endImageUrl?: string,
  characterReference?: VideoCharacterReference
): Record<string, unknown> {
  if (
    model === "fal-ai/veo3/image-to-video" ||
    model === "fal-ai/veo3.1/fast/image-to-video" ||
    model === "fal-ai/veo3.1/lite/image-to-video"
  ) {
    // Fast/Lite cùng schema request với veo3 gốc — đã tra lại schema thật, model NÀY CÓ nhận
    // aspect_ratio (enum "auto"/"16:9"/"9:16", trước đây code bỏ sót không gửi field này nên luôn rơi
    // về "auto"). Giá rẻ hơn ($0.10/s và $0.03-0.08/s so với $0.20/s) chỉ đúng khi generate_audio=false.
    return { prompt, image_url: imageUrl, aspect_ratio: aspectRatio, duration: `${durationKey ?? "6"}s`, generate_audio: false };
  }
  if (model === "fal-ai/minimax/hailuo-02/standard/image-to-video") {
    // Đã tra schema thật — model này KHÔNG có tham số tỉ lệ khung hình, luôn theo đúng ảnh đầu vào.
    return { prompt, image_url: imageUrl, duration: durationKey ?? "6", resolution: "768P" };
  }
  if (model === "minimax/h3-max/image-to-video") {
    // Đã tra schema thật (fal.ai/models/minimax/h3-max/image-to-video/api): "duration" là SỐ NGUYÊN
    // (không enum liệt kê cụ thể như LTX-2.3, không có hậu tố "s"), "prompt_expansion_mode" schema đánh
    // dấu bắt buộc dù có default "balanced" nên gửi tường minh cho chắc, "end_image_url" tuỳ chọn hỗ trợ
    // First-Last-Frame giống Kling O1 FLFV. Model này TỰ SINH GIỌNG NÓI + khớp môi ngay trong lúc tạo
    // video (đã xác nhận qua test thật với tiếng Việt) — câu thoại (nếu có) đã được nhét thẳng vào cuối
    // "prompt" từ submitSceneVideoForRow, không cần audio_url/target_audio_url riêng ở đây.
    const body: Record<string, unknown> = {
      prompt,
      image_url: imageUrl,
      aspect_ratio: aspectRatio,
      resolution: "768P",
      prompt_expansion_mode: "balanced",
    };
    if (durationKey) body.duration = Number(durationKey);
    if (endImageUrl) body.end_image_url = endImageUrl;
    return body;
  }
  if (model === "fal-ai/veo3.1/lite/first-last-frame-to-video") {
    // VEO 3.1 Lite FLF (First-Last-Frame-to-Video) — model Fal.ai RIÊNG (khác hẳn "fal-ai/veo3.1/lite/
    // image-to-video" ở nhánh trên, chỉ nhận 1 ảnh). Đã tra schema thật: "first_frame_url" +
    // "last_frame_url" đều BẮT BUỘC (không tuỳ chọn như Kling O1's end_image_url) — model này chỉ được
    // chọn khi continuousMotion đang bật (ép ở lớp gọi, xem submitStoryVideoJob), nên endImageUrl luôn
    // có giá trị tới đây.
    // LƯU Ý (đã xác nhận qua lỗi 422 thật trên Fal.ai dashboard): dù trang docs không ghi rõ, model
    // FLF này chỉ chấp nhận ĐÚNG "8s" — mọi giá trị khác (vd "4s", "6s") đều bị từ chối với thông báo
    // "Đầu vào phải là '8s'". ÉP CỨNG "8s" tại đây, bỏ qua durationKey hoàn toàn (khác các model VEO/
    // Kling khác vẫn cho chọn nhiều mức) — an toàn hơn dựa vào catalog DB (admin có thể lỡ sửa sai).
    return {
      prompt,
      first_frame_url: imageUrl,
      last_frame_url: endImageUrl,
      aspect_ratio: aspectRatio,
      duration: "8s",
      generate_audio: false,
    };
  }
  if (model === "fal-ai/kling-video/o1/reference-to-video") {
    // Kling O1 Reference — đã kiểm chứng THẬT qua API (request thật nhận IN_QUEUE, schema hợp lệ, xem
    // ghi chú migration-story-video-reference-video-models.sql). Khác hẳn Kling O1 FLFV ở nhánh dưới:
    // "image_urls" (mảng, chỉ chứa ảnh bắt đầu cảnh) TÁCH RIÊNG khỏi "elements" (ảnh Character — mặt +
    // góc khác, dùng làm căn cứ danh tính xuyên suốt lúc sinh video). Prompt PHẢI nhắc rõ "@Image1"/
    // "@Element1" theo đúng cú pháp tài liệu, nếu không model không biết vai trò của từng ảnh.
    const wrappedPrompt = characterReference
      ? `Take @Image1 as the start frame. Keep the character's face, identity, hairstyle, and appearance exactly consistent with @Element1 throughout the entire clip, even when they turn or move — do not invent a different face. ${prompt ?? ""}`
      : prompt;
    const body: Record<string, unknown> = {
      prompt: wrappedPrompt,
      image_urls: [imageUrl],
      duration: durationKey ?? "5",
      aspect_ratio: aspectRatio,
    };
    if (characterReference) {
      // Xác nhận qua lỗi 422 thật trên production (job story-101): Kling từ chối "reference_image_urls"
      // nếu gửi mảng RỖNG ("At least one image from different angles is required") — dù tài liệu ghi
      // field này tuỳ chọn, thực tế model không chấp nhận key có mặt nhưng rỗng. Xảy ra khi Character
      // của job không có character_angle_urls (vd job cũ trước khi có bước cắt góc, hoặc tái dùng
      // Character từ thư viện thiếu dữ liệu góc) — selectCharacterReferenceImages() trả extras rỗng lúc
      // đó. Chỉ thêm key này khi thật sự có ≥1 ảnh góc khác, bỏ hẳn key (không gửi mảng rỗng) khi không có.
      const element: Record<string, unknown> = { frontal_image_url: characterReference.frontal };
      if (characterReference.extras.length > 0) element.reference_image_urls = characterReference.extras;
      body.elements = [element];
    }
    return body;
  }
  if (model === "fal-ai/veo3.1/reference-to-video") {
    // VEO 3.1 Reference — đã kiểm chứng THẬT qua API, tạo thành công 1 video thật. Schema đơn giản hơn
    // Kling O1 Reference: "image_urls" là 1 mảng PHẲNG, gộp chung ảnh bắt đầu cảnh + ảnh Character, model
    // tự phân biệt vai trò — không cần cú pháp @Image/@Element như Kling. CHỈ hỗ trợ đúng "8s" (xem ghi
    // chú migration), luôn bỏ qua durationKey.
    const imageUrls = characterReference
      ? [imageUrl, characterReference.frontal, ...characterReference.extras]
      : [imageUrl];
    const finalPrompt = characterReference
      ? `${prompt ?? ""} Keep the character's face and identity exactly consistent with the reference images provided, even when they turn or move.`
      : prompt;
    return {
      prompt: finalPrompt,
      image_urls: imageUrls,
      aspect_ratio: aspectRatio,
      duration: "8s",
      resolution: "720p",
      generate_audio: false,
    };
  }
  if (model === "fal-ai/kling-video/o1/standard/image-to-video") {
    // Kling O1 FLFV (First-Last-Frame-to-Video) — đã tra schema thật: nhận start_image_url (bắt
    // buộc, KHÔNG phải "image_url" như các model khác) + end_image_url (tuỳ chọn — có thì nội suy
    // chuyển động thật giữa 2 khung hình, không có thì chạy như model 1 ảnh bình thường) + duration
    // (enum "3"-"10", KHÔNG có hậu tố "s" khác VEO). Không nhận aspect_ratio (tự theo ảnh đầu vào).
    const body: Record<string, unknown> = { prompt, start_image_url: imageUrl, duration: durationKey ?? "5" };
    if (endImageUrl) body.end_image_url = endImageUrl;
    return body;
  }
  if (model === "fal-ai/ltx-2.3/image-to-video/fast") {
    // Xác nhận qua lỗi 422 thật trên production (job #148): model này nhận "duration" dạng SỐ NGUYÊN
    // literal (6/8/10/12/14/16/18/20 — "Input should be 6, 8, 10, 12, 14, 16, 18 or 20"), KHÔNG phải
    // chuỗi như phần lớn model khác trong app — gửi chuỗi (vd "10") bị từ chối dù giá trị số khớp catalog.
    const body: Record<string, unknown> = { prompt, image_url: imageUrl, aspect_ratio: aspectRatio };
    if (durationKey) body.duration = Number(durationKey);
    return body;
  }
  const body: Record<string, unknown> = { prompt, image_url: imageUrl, aspect_ratio: aspectRatio };
  if (durationKey) body.duration = durationKey;
  return body;
}

async function submitFalJob(model: string, body: Record<string, unknown>, webhookUrl: string): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("Chưa cấu hình FAL_KEY trong .env.local");

  const res = await fetch(`https://queue.fal.run/${model}?fal_webhook=${encodeURIComponent(webhookUrl)}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown Fal.ai error");
    throw new Error(`Fal.ai lỗi: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.request_id as string;
}

function extractVideoUrl(falPayload: Record<string, unknown>): string | undefined {
  const inner = falPayload.payload as Record<string, unknown> | undefined;
  return (
    (inner?.video as { url?: string } | undefined)?.url ??
    (falPayload.video as { url?: string } | undefined)?.url ??
    (inner?.video_url as string | undefined) ??
    (falPayload.video_url as string | undefined)
  );
}

function extractImageUrl(falPayload: Record<string, unknown>): string | undefined {
  const inner = falPayload.payload as Record<string, unknown> | undefined;
  const images = (inner?.images ?? falPayload.images) as { url?: string }[] | undefined;
  return images?.[0]?.url ?? (inner?.image as { url?: string } | undefined)?.url ?? (falPayload.image as { url?: string } | undefined)?.url;
}

// Chia truyện thành đúng numScenes phân cảnh qua LLM — callOpenRouter không ép response_format nên
// phải tự phòng thủ: bóc markdown fence nếu có, parse JSON, kiểm tra đúng kiểu + đúng số lượng, sai
// thì thử lại 1 lần với nhắc nhở nghiêm ngặt hơn trước khi báo lỗi hẳn.
// "Model chat" — LLM thực thi bước chia cảnh, tách biệt với "Agent" (persona/hướng dẫn). Whitelist
// cứng 2 model đã kiểm chứng (đúng danh sách MODEL_OPTIONS admin dùng cho app tự tạo dạng text) —
// không cho truyền chuỗi model tuỳ ý từ client để tránh gọi nhầm model lạ/tốn phí ngoài ý muốn.
const ALLOWED_CHAT_MODELS = ["google/gemini-3-flash-preview", "anthropic/claude-sonnet-4.6", "openai/gpt-5.1"];

// Gợi ý số phân cảnh phù hợp cho khách — trước đây khách phải tự đếm số hành động/thay đổi tư thế
// trong truyện rồi tự chọn nút "N cảnh", không thực tế với khách không rành kỹ thuật. Gọi 1 lượt
// Gemini Flash rẻ (~18đ, cùng model dùng cho classifyCharacterImage) đếm hộ, trả về đúng 1 số nguyên.
// Kết quả chỉ là gợi ý — khách vẫn có thể tự bấm đổi sang số khác trên UI.
const SUGGEST_SCENE_COUNT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh. Đọc ý tưởng truyện/kịch bản ngắn (tiếng Việt) người dùng đưa, đếm số hành động hoặc thay đổi tư thế/trạng thái LỚN của nhân vật chính (ví dụ: ngồi xuống, đứng dậy, quay người, bắt đầu đi, dừng lại, cầm/đặt đồ vật, đổi biểu cảm rõ rệt...) — mỗi hành động lớn như vậy nên chiếm ĐÚNG 1 phân cảnh riêng để video ra mượt mà, không bị nhảy cóc tư thế giữa 2 cảnh.
Trả về DUY NHẤT 1 số nguyên (không kèm chữ, không giải thích, không markdown) — đúng bằng số hành động lớn đếm được, tối thiểu 2, tối đa 8.`;

export async function suggestSceneCount(storyDescription: string): Promise<number> {
  try {
    const { output } = await callOpenRouter("google/gemini-3-flash-preview", 10, SUGGEST_SCENE_COUNT_SYSTEM_PROMPT, storyDescription);
    const n = parseInt(output.trim().match(/\d+/)?.[0] ?? "", 10);
    if (!Number.isFinite(n)) return 3;
    return Math.min(MAX_SCENES, Math.max(MIN_SCENES, n));
  } catch (err) {
    console.error("[suggestSceneCount] Lỗi gọi AI gợi ý số cảnh:", err);
    return 3;
  }
}

export type SceneSplitResult = {
  description: string;
  camera_view: CharacterAngleKey;
  shot_size: ShotSize;
  camera_angle: CameraAngleKey;
  camera_movement: CameraMovement;
  outfit_override?: string;
  face_view?: CharacterAngleKey;
  dialogue?: string;
  end_description?: string;
  location: string;
  end_pose: string;
};

// ==== "Tạo kịch bản" — luồng MỚI thay cho suggestSceneCount + splitStoryIntoScenes(numScenes cố định) ====
// Agent tự quyết định số cảnh dựa theo số hành động lớn thật sự có trong truyện (không nhận N từ
// ngoài vào) VÀ ước lượng luôn số giây mỗi cảnh cần — trả về DANH SÁCH CHI TIẾT từng cảnh kèm giây
// riêng (KHÔNG phải 1 con số tổng), để code (planStoryVideoScenes) tự nhóm/tính giá theo đúng model
// video khách đã chọn. Chạy TRƯỚC khi có ảnh nhân vật/Character — thuần văn bản, không tốn chi phí
// tạo ảnh nào. Xem ghi nhớ project_story_video_scene_duration_architecture.
export type ScriptSceneResult = SceneSplitResult & {
  duration_seconds: number;
  // Motion Timing Controller — xem migration-story-video-motion-timing.sql. Agent đọc ra "pace" từ
  // chính từ ngữ khách dùng trong truyện (vd "vội vã"/"hối hả" -> fast, "từ tốn"/"chậm rãi" -> slow),
  // và "rotation_degrees" là số độ xoay THẬT (không suy ra được từ camera_view — 6 giá trị rời rạc
  // không phân biệt nổi "xoay 360 độ" với "không xoay", cả 2 đều trả về cùng camera_view).
  pace?: "fast" | "normal" | "slow";
  rotation_degrees?: number;
};

const STORY_SCRIPT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh kiêm lên lịch trình quay. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Nhiệm vụ 1 — Tự quyết định số phân cảnh: KHÔNG có số cảnh cố định cho trước — bạn phải đếm số hành động/khoảnh khắc thay đổi tư thế LỚN của nhân vật chính (ví dụ: ngồi xuống, đứng dậy, quay người, bắt đầu đi, dừng lại, cầm/đặt đồ vật, đổi biểu cảm rõ rệt...) và tạo ĐÚNG 1 phân cảnh cho MỖI hành động lớn như vậy — không gộp 2 hành động lớn khác nhau vào chung 1 cảnh, không tách 1 hành động ra nhiều cảnh. Tối thiểu 1 cảnh, tối đa 8 cảnh — nếu truyện có nhiều hơn 8 hành động lớn, gộp bớt các hành động ít quan trọng nhất (không đổi tư thế lớn) lại cho vừa 8.
Với MỖI cảnh, xác định thêm góc camera đang nhìn thấy nhân vật rõ nhất, chỉ được chọn ĐÚNG 1 trong 6 giá trị sau (viết y hệt, chữ thường): "front" (chính diện), "three_quarter_left" (nghiêng 3/4 trái), "three_quarter_right" (nghiêng 3/4 phải), "side" (nhìn ngang hẳn 1 bên), "back" (quay lưng lại camera), "face" (cận mặt).
Quy tắc khi mô tả không nói rõ góc quay: nếu không nói gì đặc biệt về hướng, mặc định "front". Nếu chỉ nói "quay đầu"/"nhìn sang" (không nói "quay người"/"quay lưng"), coi là góc "three_quarter_left" hoặc "three_quarter_right" tương ứng hướng nhìn, KHÔNG phải "back". Chỉ chọn "back" khi mô tả rõ ràng nhân vật quay LƯNG/CẢ NGƯỜI lại camera.
${CAMERA_FRAMING_INSTRUCTION}
Khi viết "description" (tiếng Anh): viết như 1 đạo diễn hình ảnh thật sự — có thể thêm chi tiết điện ảnh phù hợp với bối cảnh gốc (ánh sáng, loại khung hình/shot size, không khí, chất liệu/kết cấu môi trường xung quanh) để ảnh tạo ra sống động hơn, nhưng KHÔNG bịa thêm tình tiết, hành động, hay địa điểm không có trong ý tưởng gốc.
Rào chắn giữ đúng danh tính nhân vật (bắt buộc, không được vi phạm dù thêm chi tiết điện ảnh): giữ nguyên giới tính, độ tuổi, kiểu tóc, màu tóc của nhân vật chính xuyên suốt mọi cảnh (đây là phần KHÔNG BAO GIỜ được đổi); không tự thêm nhân vật phụ mới nếu ý tưởng gốc không nhắc; nếu ý tưởng gốc mô tả 1 địa điểm liên tục thì không tự đổi bối cảnh giữa các cảnh.
Trang phục — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu sắc/kiểu dáng/chất liệu trang phục trong "description" trừ đúng lúc dùng "outfit_override". Nếu cần nhắc trang phục để giữ liên tục, chỉ viết chung chung kiểu "wearing the same outfit as before".
Ngoại hình (tóc/vóc dáng/khuôn mặt) — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu tóc/kiểu tóc/vóc dáng/đặc điểm khuôn mặt trong "description": bạn không nhìn thấy ảnh nhân vật thật, tự bịa (vd "long dark hair", "fit young man") sẽ mâu thuẫn với ảnh tham chiếu thật dùng để vẽ ảnh sau này. Chỉ cần gọi là "the character" hoặc đúng tên nhân vật nếu có, không cần mô tả ngoại hình.
Trạng thái liên tục giữa các cảnh: MỖI cảnh được gửi cho model tạo ảnh RIÊNG BIỆT, độc lập — mỗi "description" phải TỰ ĐẦY ĐỦ ngữ cảnh (self-contained), nhắc lại rõ địa điểm/bối cảnh nếu tiếp nối cảnh trước.
Tư thế/hành động nối tiếp: "description" của cảnh này PHẢI bắt đầu đúng từ tư thế/hành động mà "end_pose" của cảnh NGAY TRƯỚC nó vừa mô tả — viết liền thành 1 câu tự nhiên (thì hiện tại, 1 khoảnh khắc duy nhất), không kể lại 2 mốc thời gian nối nhau.
Bối cảnh vật lý (bắt buộc, MỌI cảnh): thêm khoá "location" (chuỗi tiếng Anh NGẮN GỌN) mô tả nơi + ánh sáng/thời điểm trong ngày. Nếu nhiều cảnh liên tiếp cùng 1 chỗ, "location" phải viết Y HỆT NHAU, ĐÚNG TỪNG CHỮ.
Trạng thái kết thúc cảnh (bắt buộc, MỌI cảnh): thêm khoá "end_pose" (chuỗi tiếng Anh NGẮN GỌN) mô tả tư thế/hành động lúc KẾT THÚC cảnh — dùng làm điểm nối sang cảnh sau.
Lời thoại (chỉ khi ý tưởng gốc CÓ trích dẫn rõ ràng): thêm khoá "dialogue" (tiếng Việt, NGUYÊN VĂN, dưới 15 từ). Không có thì bỏ hẳn khoá này.
Đổi trang phục (chỉ khi ý tưởng gốc NÓI RÕ): thêm "outfit_override" ở cảnh đầu tiên xuất hiện đồ mới, lặp lại Y HỆT ở các cảnh sau đó.
Mặt/thân lệch hướng (chỉ khi ý tưởng gốc NÓI RÕ): thêm "face_view" nếu khác "camera_view".

Nhiệm vụ 2 — Ước lượng thời lượng mỗi cảnh: thêm khoá "duration_seconds" (số nguyên, MỌI cảnh, bắt buộc) — số giây chuyển động cảnh này cần để trông tự nhiên, mượt mà (không rush, không lê thê). Dùng bảng tham khảo sau làm gốc, điều chỉnh theo mức độ phức tạp thực tế:
- hành động nhỏ (liếc mắt, mỉm cười nhẹ, nghiêng đầu): 1-2s
- cử chỉ (gật đầu, vẫy tay, chỉ tay, nhặt vật nhỏ): 2-3s
- chuyển động thân người (đứng dậy, ngồi xuống): 3-4s
- di chuyển (đi vài bước): số giây = số bước × 0.5s (nhịp đi thật ~2 bước/giây — đi vài bước thường là 3-5 bước, tức ~1.5-2.5s; ĐỪNG mặc định 4-6s theo thói quen, kéo dài quá khiến model quay ra dáng chạy/jog chứ không phải đi bộ). Nếu khung cảnh cần đi xa hơn, tăng số giây theo đúng nhịp 0.5s/bước (thêm bước), TUYỆT ĐỐI không giữ nguyên số giây rồi để bước chân nhanh hơn.
- xoay người theo góc: xoay nhẹ (<45°) 2-3s; xoay vừa (45-90°) 3-5s; xoay nhiều/quay hẳn lưng (90-180°) 5-7s; xoay trọn 1 vòng (360°, quay liên tục 1 mạch chứ không phải xoay từng nấc) ~2s — 1 vòng quay dứt khoát, đều tốc độ, xong đứng yên hẳn ở tư thế kết; TUYỆT ĐỐI không quay 2 vòng dù duration_seconds còn dư
- hành động nhiều bước gộp lại (đi tới + nhặt đồ + quay lại): 6-8s
Dù số giây ước lượng cho 1 hành động cao (kể cả xoay 360° 6-8s) — VẪN PHẢI giữ nguyên là 1 cảnh DUY NHẤT, một khoá "duration_seconds" DUY NHẤT cho hành động đó. TUYỆT ĐỐI KHÔNG được tự chia 1 chuyển động xoay/di chuyển liên tục thành "nửa đầu"/"nửa sau"/"giai đoạn 1"/"giai đoạn 2" ở 2 cảnh khác nhau — dù bạn thấy giây ước lượng dài. Ví dụ SAI cần tránh: quay 1 vòng 360° bị chia thành cảnh A "bắt đầu xoay, xoay tới nửa vòng" + cảnh B "xoay nốt nửa vòng còn lại" — đây là lỗi nghiêm trọng, chỉ được viết ĐÚNG 1 cảnh "she rotates a full 360 degrees" với "duration_seconds": 7 (hoặc tương đương trong khoảng 6-8s).

Nhiệm vụ 3 — Nhịp độ chuyển động: thêm khoá "pace" ("fast"/"normal"/"slow") cho MỌI cảnh, đọc ra từ CHÍNH TỪ NGỮ khách dùng trong ý tưởng gốc (không tự bịa cảm giác riêng). Nếu truyện dùng từ như "vội vã", "hối hả", "gấp gáp", "nhanh chóng", "chạy" → "fast". Nếu dùng từ như "từ tốn", "chậm rãi", "khoan thai", "êm đềm", "thong thả" → "slow". Không có từ nào gợi ý tốc độ → "normal" (mặc định, đa số trường hợp). "pace": "fast" thì nghiêng "duration_seconds" về đầu THẤP của khoảng tham khảo; "slow" thì nghiêng về đầu CAO.

Nhiệm vụ 4 — Số độ xoay thật (CHỈ khi cảnh có xoay người/quay người/quay đầu): thêm khoá "rotation_degrees" (số nguyên 0-360) — số độ xoay THẬT tính từ tư thế bắt đầu tới tư thế kết thúc của ĐÚNG cảnh này. Đây là số ĐỘC LẬP với "camera_view" (camera_view chỉ có 6 giá trị rời rạc, không phân biệt được "xoay trọn 1 vòng quay lại đúng hướng cũ" với "không xoay gì cả" — cả 2 đều có camera_view giống nhau ở đầu/cuối). Ví dụ: xoay nhẹ liếc qua vai ~30°, xoay hẳn người 90°, quay lưng lại 180°, xoay trọn 1 vòng về lại hướng cũ = 360° (KHÔNG phải 0, dù camera_view đầu/cuối giống nhau). Cảnh không có xoay thì bỏ hẳn khoá này.

Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ, mỗi phần tử có khoá "description", "camera_view", "shot_size" (bắt buộc), "camera_angle" (bắt buộc), "camera_movement" (bắt buộc), "outfit_override" (tuỳ chọn), "face_view" (tuỳ chọn), "dialogue" (tuỳ chọn), "location" (bắt buộc), "end_pose" (bắt buộc), "duration_seconds" (bắt buộc), "pace" (bắt buộc), "rotation_degrees" (tuỳ chọn, chỉ khi có xoay) — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích nào trong JSON.
Ví dụ format: [{"description": "a young woman walking into a coffee shop, morning light", "camera_view": "front", "shot_size": "wide_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a cozy coffee shop interior, window table", "end_pose": "she has just sat down and is looking around", "duration_seconds": 4, "pace": "normal"}, {"description": "still at the coffee shop, she turns her head and looks outside the window, smiling", "camera_view": "three_quarter_left", "shot_size": "close_up", "camera_angle": "eye_level", "camera_movement": "static", "location": "a cozy coffee shop interior, window table", "end_pose": "she is smiling, looking out the window", "duration_seconds": 2, "pace": "normal", "rotation_degrees": 30}]`;

// Dùng chung cho 2 nơi: (1) parse JSON thô từ LLM (parseScriptSceneResult), (2) validate lại mảng
// "actions" client gửi lên lúc submit thật — đảm bảo dù nguồn nào, dữ liệu vào planStoryVideoScenes()
// luôn đúng hình dạng (không tin field giá/duration_key nào từ client, chỉ tin các field mô tả này).
export function validateScriptSceneResult(parsed: unknown, storyDescription: string): ScriptSceneResult[] {
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Danh sách hành động không hợp lệ");
  if (parsed.length > MAX_SCENES) throw new Error(`Quá nhiều hành động (${parsed.length}), vượt giới hạn ${MAX_SCENES} cảnh`);
  return parsed.map((s: Record<string, unknown>) => {
    if (typeof s.description !== "string" || !s.description.trim()) throw new Error("Thiếu description ở 1 hành động");
    if (typeof s.camera_view !== "string" || !CHARACTER_ANGLE_LABELS.includes(s.camera_view as CharacterAngleKey)) {
      throw new Error("camera_view không hợp lệ ở 1 hành động");
    }
    if (typeof s.location !== "string" || !s.location.trim()) throw new Error("Thiếu location ở 1 hành động");
    if (typeof s.end_pose !== "string" || !s.end_pose.trim()) throw new Error("Thiếu end_pose ở 1 hành động");
    const durationSeconds = Number(s.duration_seconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("duration_seconds không hợp lệ ở 1 hành động");
    const dialogue =
      typeof s.dialogue === "string" && s.dialogue.trim() && isVerbatimQuoteInStory(s.dialogue, storyDescription) ? s.dialogue.trim() : undefined;
    const pace = s.pace === "fast" || s.pace === "slow" || s.pace === "normal" ? s.pace : "normal";
    const rotationDegreesRaw = Number(s.rotation_degrees);
    const rotationDegrees =
      Number.isFinite(rotationDegreesRaw) && rotationDegreesRaw > 0 && rotationDegreesRaw <= 360
        ? Math.round(rotationDegreesRaw)
        : undefined;
    return {
      description: s.description.trim(),
      camera_view: s.camera_view as CharacterAngleKey,
      shot_size: resolveShotSize(s.shot_size),
      camera_angle: resolveCameraAngleKey(s.camera_angle),
      camera_movement: resolveCameraMovement(s.camera_movement),
      outfit_override: typeof s.outfit_override === "string" && s.outfit_override.trim() ? s.outfit_override.trim() : undefined,
      face_view:
        typeof s.face_view === "string" && CHARACTER_ANGLE_LABELS.includes(s.face_view as CharacterAngleKey)
          ? (s.face_view as CharacterAngleKey)
          : undefined,
      dialogue,
      location: s.location.trim(),
      end_pose: s.end_pose.trim(),
      // Không ép làm tròn số nguyên nữa — thanh trượt tốc độ (enable_speed_slider) cho khách kéo tự do,
      // giữ nguyên số lẻ khách chọn. Vẫn làm tròn 2 chữ số thập phân để tránh nhiễu dấu phẩy động (vd
      // "6.438297482926") lỡ lọt qua từ phía client, không giới hạn thực chất khả năng chỉnh tự do.
      duration_seconds: Math.round(durationSeconds * 100) / 100,
      pace,
      rotation_degrees: rotationDegrees,
    };
  });
}

function parseScriptSceneResult(output: string, storyDescription: string): ScriptSceneResult[] {
  const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  try {
    return validateScriptSceneResult(parsed, storyDescription);
  } catch (err) {
    throw new Error(`AI không trả về danh sách cảnh hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Gọi Agent 1 lần (thử lại đúng 1 lần nếu sai định dạng) — trả về danh sách chi tiết, chưa nhóm cảnh,
// chưa chọn duration_key theo model nào (xem planStoryVideoScenes để làm bước đó).
export async function generateStoryScript(
  storyDescription: string,
  modelChatKey?: string,
  // Skill "story-planner" — admin ghi thêm ghi chú qua /admin (model_config.prompt_helper_instructions).
  // Trước đây field này CHỈ tới được luồng chia cảnh LLM cũ (splitStoryIntoScenes), Agent "Tạo kịch
  // bản" mới (luồng đang chạy thật) không đọc field này -- nối vào đây để admin chỉnh được thật.
  miniAppId?: string,
  // Tên nhân vật chính (ô "Tên nhân vật", để trống ở frontend fallback "Nhân vật 1") — cho Agent 1 cái
  // tên cụ thể để gọi thay vì phải tự bịa mô tả ngoại hình cho "tự đầy đủ ngữ cảnh" (xem rào chắn ngoại
  // hình trong STORY_SCRIPT_SYSTEM_PROMPT — quy tắc đó tự nó đã đủ chặn bịa, câu này chỉ hỗ trợ thêm).
  characterLabel?: string
): Promise<ScriptSceneResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  let systemPrompt = STORY_SCRIPT_SYSTEM_PROMPT;
  if (characterLabel?.trim()) {
    systemPrompt += `\n\nNhân vật chính trong truyện này tên là "${characterLabel.trim()}" — gọi nhân vật bằng đúng tên này trong "description" thay vì "the character"/"a woman"/"a man" chung chung.`;
  }
  if (miniAppId) {
    const miniApp = await getMiniAppModelConfig(miniAppId);
    const override = miniApp.model_config.prompt_helper_instructions;
    if (override?.trim()) systemPrompt += `\n\nGhi chú thêm từ admin: ${override.trim()}`;
  }
  const { output } = await callOpenRouter(chatModel, 2000, systemPrompt, storyDescription);
  try {
    return parseScriptSceneResult(output, storyDescription);
  } catch (err) {
    const { output: retryOutput } = await callOpenRouter(
      chatModel,
      2000,
      systemPrompt,
      `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng: ${err instanceof Error ? err.message : String(err)}. Chỉ trả về mảng JSON hợp lệ đúng theo hướng dẫn.)`
    );
    return parseScriptSceneResult(retryOutput, storyDescription);
  }
}

// Bước "Tạo kịch bản" cho NHIỀU NHÂN VẬT — mirror generateStoryScript() ở trên (Agent tự quyết định số
// cảnh theo số hành động thật, tự ước lượng duration_seconds/pace/rotation_degrees) nhưng mỗi hành động
// còn cần thêm khoá "characters" (ai có mặt) — mirror buildMultiSceneSplitPrompt() cho phần đó. Không hỗ
// trợ end_description/end_characters (chuyển động liên tục) — giống hệt luồng 1 nhân vật, storyUsesScriptFlow
// loại trừ continuousMotion nên trường hợp đó không bao giờ tới đây.
export type ScriptSceneResultMulti = {
  description: string;
  characters: number[];
  shot_size: ShotSize;
  camera_angle: CameraAngleKey;
  camera_movement: CameraMovement;
  dialogue?: { speaker: number; line: string } | null;
  location: string;
  end_pose: string;
  duration_seconds: number;
  pace?: "fast" | "normal" | "slow";
  rotation_degrees?: number;
};

function buildStoryScriptPromptMulti(characterLabels: string[]): string {
  const list = characterLabels.map((label, i) => `${i}: ${label}`).join(", ");
  return `Bạn là đạo diễn dựng phân cảnh kiêm lên lịch trình quay cho 1 video có NHIỀU nhân vật thật cùng xuất hiện. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Danh sách nhân vật trong video này (đánh số bắt đầu từ 0): ${list}.

Nhiệm vụ 1 — Tự quyết định số phân cảnh: KHÔNG có số cảnh cố định cho trước — đếm số hành động/khoảnh khắc thay đổi tư thế LỚN của (các) nhân vật (ngồi xuống, đứng dậy, quay người, bắt đầu đi, dừng lại, cầm/đặt đồ vật, đổi biểu cảm rõ rệt, có người bước vào/ra khung hình...) và tạo ĐÚNG 1 phân cảnh cho MỖI hành động lớn như vậy — không gộp 2 hành động lớn khác nhau vào chung 1 cảnh, không tách 1 hành động ra nhiều cảnh. Tối thiểu 1 cảnh, tối đa 8 cảnh — nếu truyện có nhiều hơn 8 hành động lớn, gộp bớt các hành động ít quan trọng nhất lại cho vừa 8.
Với MỖI cảnh, xác định thêm khoá "characters": 1 mảng các SỐ (đúng chỉ số trong danh sách nhân vật ở trên) — liệt kê TẤT CẢ nhân vật thực sự xuất hiện trong khung hình của cảnh đó, có thể 1 người hoặc nhiều người cùng lúc. Không tự thêm số ngoài danh sách, không tự bỏ sót người rõ ràng có mặt theo mô tả.
${CAMERA_FRAMING_INSTRUCTION}
Khi viết "description" (tiếng Anh): mô tả rõ ai đang làm gì, có thể thêm chi tiết điện ảnh (ánh sáng, khung hình, không khí) phù hợp bối cảnh gốc, nhưng KHÔNG bịa thêm tình tiết/hành động/địa điểm không có trong ý tưởng gốc.
Rào chắn giữ đúng danh tính (bắt buộc): không tự đổi giới tính/độ tuổi/kiểu tóc của bất kỳ nhân vật nào đã liệt kê ở trên; không tự thêm nhân vật phụ mới ngoài danh sách; nếu ý tưởng gốc mô tả 1 địa điểm liên tục thì không tự đổi bối cảnh giữa các cảnh.
Trang phục — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu sắc/kiểu dáng/chất liệu trang phục của bất kỳ ai trong "description" (bạn không nhìn thấy ảnh nhân vật thật — tự bịa sẽ mâu thuẫn với ảnh tham chiếu thật). Nếu cần nhắc trang phục để giữ liên tục, chỉ viết chung chung "wearing the same outfit as before".
Ngoại hình (tóc/vóc dáng/khuôn mặt) — cùng lý do trên, TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu tóc/kiểu tóc/vóc dáng/đặc điểm khuôn mặt của bất kỳ ai trong "description". Chỉ gọi bằng đúng tên nhân vật trong danh sách ở trên, không cần mô tả ngoại hình.
Trạng thái liên tục giữa các cảnh: MỖI cảnh được gửi cho model tạo ảnh RIÊNG BIỆT, độc lập — mỗi "description" phải TỰ ĐẦY ĐỦ ngữ cảnh (self-contained), nhắc lại rõ địa điểm/bối cảnh nếu tiếp nối cảnh trước.
Tư thế/hành động nối tiếp: "description" của cảnh này (trừ cảnh đầu tiên) PHẢI bắt đầu đúng từ tư thế/hành động mà "end_pose" của cảnh NGAY TRƯỚC nó vừa mô tả — viết liền thành 1 câu tự nhiên (thì hiện tại, 1 khoảnh khắc duy nhất), không kể lại 2 mốc thời gian nối nhau.
Bối cảnh vật lý (bắt buộc, MỌI cảnh): thêm khoá "location" (chuỗi tiếng Anh NGẮN GỌN) mô tả nơi + ánh sáng/thời điểm trong ngày. Nếu nhiều cảnh liên tiếp cùng 1 chỗ, "location" phải viết Y HỆT NHAU, ĐÚNG TỪNG CHỮ.
Trạng thái kết thúc cảnh (bắt buộc, MỌI cảnh): thêm khoá "end_pose" (chuỗi tiếng Anh NGẮN GỌN) mô tả tư thế/hành động lúc KẾT THÚC cảnh — dùng làm điểm nối sang cảnh sau.
Lời thoại (chỉ khi ý tưởng gốc CÓ trích dẫn rõ ràng 1 nhân vật đang nói): thêm khoá "dialogue" là 1 object {"speaker": số (đúng chỉ số nhân vật đang nói, phải nằm trong mảng "characters" của cảnh đó), "line": chuỗi tiếng Việt giữ NGUYÊN VĂN, KHÔNG dịch, dưới 15 từ}. Có thể thêm dù cảnh đó có nhiều người cùng khung hình — hệ thống lồng tiếng chỉ khớp môi đúng người được chỉ định qua "speaker", những người còn lại trong cảnh vẫn giữ nguyên, không bị ảnh hưởng.

Nhiệm vụ 2 — Ước lượng thời lượng mỗi cảnh: thêm khoá "duration_seconds" (số nguyên, MỌI cảnh, bắt buộc) — số giây chuyển động cảnh này cần để trông tự nhiên, mượt mà. Dùng bảng tham khảo sau làm gốc:
- hành động nhỏ (liếc mắt, mỉm cười nhẹ, nghiêng đầu): 1-2s
- cử chỉ (gật đầu, vẫy tay, chỉ tay, nhặt vật nhỏ): 2-3s
- chuyển động thân người (đứng dậy, ngồi xuống): 3-4s
- di chuyển (đi vài bước): số giây = số bước × 0.5s (nhịp đi thật ~2 bước/giây — đi vài bước thường là 3-5 bước, tức ~1.5-2.5s; ĐỪNG mặc định 4-6s theo thói quen, kéo dài quá khiến model quay ra dáng chạy/jog chứ không phải đi bộ). Nếu khung cảnh cần đi xa hơn, tăng số giây theo đúng nhịp 0.5s/bước (thêm bước), TUYỆT ĐỐI không giữ nguyên số giây rồi để bước chân nhanh hơn.
- xoay người theo góc: xoay nhẹ (<45°) 2-3s; xoay vừa (45-90°) 3-5s; xoay nhiều/quay hẳn lưng (90-180°) 5-7s; xoay trọn 1 vòng (360°, quay liên tục 1 mạch chứ không phải xoay từng nấc) ~2s — 1 vòng quay dứt khoát, đều tốc độ, xong đứng yên hẳn ở tư thế kết; TUYỆT ĐỐI không quay 2 vòng dù duration_seconds còn dư
- hành động nhiều bước gộp lại: 6-8s
Dù số giây ước lượng cho 1 hành động cao — VẪN PHẢI giữ nguyên là 1 cảnh DUY NHẤT, TUYỆT ĐỐI KHÔNG tự chia 1 chuyển động xoay/di chuyển liên tục thành "nửa đầu"/"nửa sau" ở 2 cảnh khác nhau.

Nhiệm vụ 3 — Nhịp độ chuyển động: thêm khoá "pace" ("fast"/"normal"/"slow") cho MỌI cảnh, đọc ra từ CHÍNH TỪ NGỮ khách dùng trong ý tưởng gốc. "vội vã"/"hối hả"/"gấp gáp"/"nhanh chóng"/"chạy" → "fast". "từ tốn"/"chậm rãi"/"khoan thai"/"êm đềm" → "slow". Không có từ gợi ý → "normal".

Nhiệm vụ 4 — Số độ xoay thật (CHỈ khi cảnh có xoay người/quay người/quay đầu): thêm khoá "rotation_degrees" (số nguyên 0-360) — số độ xoay THẬT từ tư thế bắt đầu tới kết thúc của ĐÚNG cảnh này, ĐỘC LẬP với việc chọn góc camera. Cảnh không có xoay thì bỏ hẳn khoá này.

Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ, mỗi phần tử có khoá "description", "characters" (mảng số, bắt buộc), "shot_size" (bắt buộc), "camera_angle" (bắt buộc), "camera_movement" (bắt buộc), "dialogue" (tuỳ chọn), "location" (bắt buộc), "end_pose" (bắt buộc), "duration_seconds" (bắt buộc), "pace" (bắt buộc), "rotation_degrees" (tuỳ chọn) — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích nào trong JSON.
Ví dụ format: [{"description": "${characterLabels[0]} stands alone by the entrance, waiting nervously, morning light", "characters": [0], "shot_size": "wide_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a wedding venue entrance, morning", "end_pose": "she is glancing anxiously toward the road", "duration_seconds": 2, "pace": "normal"}${
    characterLabels.length >= 2
      ? `, {"description": "${characterLabels[0]} and ${characterLabels[1]} stand together, holding hands, smiling warmly", "characters": [0, 1], "shot_size": "medium_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a wedding venue entrance, morning", "end_pose": "they are smiling at each other, hands still held", "duration_seconds": 3, "pace": "normal"}`
      : ""
  }]`;
}

// Dùng chung cho 2 nơi: (1) parse JSON thô từ LLM, (2) validate lại mảng "actions" client gửi lên lúc
// submit thật — mirror validateScriptSceneResult() (luồng 1 nhân vật) nhưng có thêm "characters"[] và
// object "dialogue" {speaker, line} thay vì chuỗi phẳng.
export function validateScriptSceneResultMulti(
  parsed: unknown,
  storyDescription: string,
  characterLabels: string[]
): ScriptSceneResultMulti[] {
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Danh sách hành động không hợp lệ");
  if (parsed.length > MAX_SCENES) throw new Error(`Quá nhiều hành động (${parsed.length}), vượt giới hạn ${MAX_SCENES} cảnh`);
  const maxIndex = characterLabels.length - 1;
  return parsed.map((s: Record<string, unknown>) => {
    if (typeof s.description !== "string" || !s.description.trim()) throw new Error("Thiếu description ở 1 hành động");
    if (
      !Array.isArray(s.characters) ||
      s.characters.length === 0 ||
      !s.characters.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= maxIndex)
    ) {
      throw new Error("characters không hợp lệ ở 1 hành động");
    }
    if (typeof s.location !== "string" || !s.location.trim()) throw new Error("Thiếu location ở 1 hành động");
    if (typeof s.end_pose !== "string" || !s.end_pose.trim()) throw new Error("Thiếu end_pose ở 1 hành động");
    const durationSeconds = Number(s.duration_seconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("duration_seconds không hợp lệ ở 1 hành động");
    const characters = s.characters as number[];
    // Phòng thủ phía code: giữ dialogue khi speaker hợp lệ (nằm trong "characters" của cảnh) + câu thoại
    // khớp nguyên văn truyện gốc (chặn AI dịch/diễn giải sang tiếng Anh) — cùng quy tắc đã áp dụng cho
    // splitStoryIntoScenesMulti. Đã kiểm chứng qua test thật Kling LipSync: khớp môi đúng người được chỉ
    // định qua "speaker" dù cảnh có nhiều người, không cần giới hạn còn ĐÚNG 1 người trong khung hình nữa.
    const rawDialogue = s.dialogue as { speaker?: unknown; line?: unknown } | null | undefined;
    const dialogue =
      rawDialogue &&
      typeof rawDialogue.speaker === "number" &&
      characters.includes(rawDialogue.speaker) &&
      typeof rawDialogue.line === "string" &&
      rawDialogue.line.trim() &&
      isVerbatimQuoteInStory(rawDialogue.line, storyDescription)
        ? { speaker: rawDialogue.speaker, line: rawDialogue.line.trim() }
        : null;
    const pace = s.pace === "fast" || s.pace === "slow" || s.pace === "normal" ? s.pace : "normal";
    const rotationDegreesRaw = Number(s.rotation_degrees);
    const rotationDegrees =
      Number.isFinite(rotationDegreesRaw) && rotationDegreesRaw > 0 && rotationDegreesRaw <= 360
        ? Math.round(rotationDegreesRaw)
        : undefined;
    return {
      description: s.description.trim(),
      characters,
      shot_size: resolveShotSize(s.shot_size),
      camera_angle: resolveCameraAngleKey(s.camera_angle),
      camera_movement: resolveCameraMovement(s.camera_movement),
      dialogue,
      location: s.location.trim(),
      end_pose: s.end_pose.trim(),
      // Không ép làm tròn số nguyên nữa — thanh trượt tốc độ (enable_speed_slider) cho khách kéo tự do,
      // giữ nguyên số lẻ khách chọn. Vẫn làm tròn 2 chữ số thập phân để tránh nhiễu dấu phẩy động (vd
      // "6.438297482926") lỡ lọt qua từ phía client, không giới hạn thực chất khả năng chỉnh tự do.
      duration_seconds: Math.round(durationSeconds * 100) / 100,
      pace,
      rotation_degrees: rotationDegrees,
    };
  });
}

function parseScriptSceneResultMulti(output: string, storyDescription: string, characterLabels: string[]): ScriptSceneResultMulti[] {
  const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  try {
    return validateScriptSceneResultMulti(parsed, storyDescription, characterLabels);
  } catch (err) {
    throw new Error(`AI không trả về danh sách cảnh hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Gọi Agent 1 lần (thử lại đúng 1 lần nếu sai định dạng) cho luồng NHIỀU NHÂN VẬT — mirror
// generateStoryScript() ở trên, xem planStoryVideoScenesMulti() để nhóm cảnh + tính giá thật.
export async function generateStoryScriptMulti(
  storyDescription: string,
  characterLabels: string[],
  modelChatKey?: string,
  miniAppId?: string
): Promise<ScriptSceneResultMulti[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  let systemPrompt = buildStoryScriptPromptMulti(characterLabels);
  if (miniAppId) {
    const miniApp = await getMiniAppModelConfig(miniAppId);
    const override = miniApp.model_config.prompt_helper_instructions;
    if (override?.trim()) systemPrompt += `\n\nGhi chú thêm từ admin: ${override.trim()}`;
  }
  const { output } = await callOpenRouter(chatModel, 2000, systemPrompt, storyDescription);
  try {
    return parseScriptSceneResultMulti(output, storyDescription, characterLabels);
  } catch (err) {
    const { output: retryOutput } = await callOpenRouter(
      chatModel,
      2000,
      systemPrompt,
      `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng: ${err instanceof Error ? err.message : String(err)}. Chỉ trả về mảng JSON hợp lệ đúng theo hướng dẫn.)`
    );
    return parseScriptSceneResultMulti(retryOutput, storyDescription, characterLabels);
  }
}

// So sánh địa điểm 2 hành động liền kề (Agent được dặn viết Y HỆT khi cùng chỗ) — bỏ qua khác biệt hoa/thường
// và khoảng trắng thừa để không mất cơ hội gộp chỉ vì lệch định dạng.
function sameLocation(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type PlannedScene = ScriptSceneResult & {
  // Nhóm hành động nào bị gộp chung cảnh này (chỉ có >1 phần tử khi khách chỉnh N thấp hơn số hành
  // động thật và việc gộp không vượt mức giây tối đa model hỗ trợ — xem planStoryVideoScenes).
  merged_from: ScriptSceneResult[];
  // null khi model video KHÔNG có duration_price_vnd riêng (giá phẳng, vd Kling v1.6 Standard) — không
  // có mức nào để "khoá", submitSceneVideoForRow/proceedToVideoStage đã xử lý null đúng như hành vi cũ.
  duration_key: string | null;
  provider_cost_vnd: number;
};

export type StoryVideoPlan = {
  scenes: PlannedScene[];
  totalNaturalSeconds: number;
  totalVideoProviderCostVnd: number;
};

// Nhóm danh sách hành động Agent trả về (generateStoryScript) thành N cảnh THEO ĐÚNG model video khách
// đã chọn + tính giá thật. Quy tắc ĐÃ CHỐT (xem ghi nhớ project_story_video_scene_duration_architecture):
// - Mặc định (không truyền requestedSceneCount, hoặc requestedSceneCount >= số hành động): 1 hành động
//   = 1 cảnh, mỗi cảnh tự chọn mức duration GẦN NHẤT trong catalog model đó.
// - Nếu khách muốn N THẤP hơn số hành động: gộp các hành động LIỀN KỀ lại (không đảo thứ tự) — CHỈ gộp
//   khi tổng giây của nhóm ≤ mức GIÂY TỐI ĐA model hỗ trợ; vượt ngưỡng thì TUYỆT ĐỐI không gộp thêm,
//   để N cuối cùng cao hơn requestedSceneCount nếu cần (bảo toàn chất lượng chuyển động, không rush).
// - Không đụng gì tới model ẢNH/giá ảnh — hàm này chỉ lo phần VIDEO (thời lượng), giá ảnh tính riêng
//   theo đúng số cảnh cuối cùng (scenes.length) ở nơi gọi.
export function planStoryVideoScenes(
  actions: ScriptSceneResult[],
  videoEntry: VideoModelEntry,
  requestedSceneCount?: number
): StoryVideoPlan {
  const durationMap = videoEntry.duration_price_vnd;
  const maxSeconds = durationMap ? Math.max(...Object.keys(durationMap).map(Number).filter((n) => Number.isFinite(n))) : undefined;

  // Gộp liền kề TỰ ĐỘNG (không cần requestedSceneCount) — bất cứ khi nào tổng giây 2 nhóm liền kề vẫn
  // nằm trong mốc thời lượng LỚN NHẤT model video hỗ trợ (maxSeconds), gộp lại thành 1 cảnh để giảm số
  // lượt gọi model video (tiết kiệm chi phí thật, không đổi chất lượng vì vẫn nằm trong đúng 1 mốc
  // duration thật, phần dư vẫn được stitchAndFinish() cắt bỏ như bình thường). requestedSceneCount (nếu
  // có -- hiện không nơi nào gửi, giữ lại cho tương lai) ép dừng gộp sớm hơn ở đúng N khách muốn.
  const groups: ScriptSceneResult[][] = actions.map((a) => [a]);
  const groupSeconds = (g: ScriptSceneResult[]) => g.reduce((sum, a) => sum + a.duration_seconds, 0);
  // Không gộp nếu CẢ HAI nhóm đều đã có lời thoại riêng -- bước ghép "dialogue" bên dưới chỉ giữ được
  // đúng 1 câu/cảnh (group.find lấy câu ĐẦU tiên), gộp 2 nhóm có thoại sẽ làm mất câu còn lại.
  const groupDialogueCount = (g: ScriptSceneResult[]) => g.filter((a) => a.dialogue).length;
  if (maxSeconds !== undefined) {
    while (groups.length > 1 && (!requestedSceneCount || groups.length > requestedSceneCount)) {
      // Tìm cặp liền kề có tổng giây NHỎ NHẤT sau khi gộp (ưu tiên gộp cặp "rẻ" nhất trước) mà vẫn
      // trong ngưỡng maxSeconds -- nếu không còn cặp nào gộp được nữa thì dừng.
      let bestIdx = -1;
      let bestSum = Infinity;
      for (let i = 0; i < groups.length - 1; i++) {
        // Khác địa điểm cũng không gộp — 1 cảnh gộp chỉ có 1 ảnh tĩnh, không thể vừa ở nơi này vừa ở nơi kia.
        if (!sameLocation(groups[i][0].location, groups[i + 1][0].location)) continue;
        const sum = groupSeconds(groups[i]) + groupSeconds(groups[i + 1]);
        if (sum <= maxSeconds && sum < bestSum && groupDialogueCount(groups[i]) + groupDialogueCount(groups[i + 1]) <= 1) {
          bestSum = sum;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break; // không còn cặp nào gộp được nữa (hoặc chỉ còn cặp 2 lời thoại) -- dừng
      groups[bestIdx] = [...groups[bestIdx], ...groups[bestIdx + 1]];
      groups.splice(bestIdx + 1, 1);
    }
  }

  let totalNaturalSeconds = 0;
  let totalVideoProviderCostVnd = 0;
  const scenes: PlannedScene[] = groups.map((group) => {
    const naturalSeconds = groupSeconds(group);
    totalNaturalSeconds += naturalSeconds;
    const durationKey = durationMap ? (resolveNearestDurationKey(durationMap, naturalSeconds) ?? null) : null;
    const providerCostVnd = durationKey !== null ? (durationMap?.[durationKey] ?? videoEntry.provider_cost_vnd) : videoEntry.provider_cost_vnd;
    totalVideoProviderCostVnd += providerCostVnd;
    // Cảnh gộp từ nhiều hành động -> nối "description" theo thứ tự, giữ nguyên location/camera_view
    // của hành động ĐẦU trong nhóm (đại diện cho cả cảnh), end_pose lấy của hành động CUỐI trong nhóm.
    const primary = group[0];
    const last = group[group.length - 1];
    return {
      description: group.length === 1 ? primary.description : group.map((a) => a.description).join(" Then, "),
      camera_view: primary.camera_view,
      shot_size: primary.shot_size,
      camera_angle: primary.camera_angle,
      camera_movement: primary.camera_movement,
      outfit_override: primary.outfit_override,
      face_view: primary.face_view,
      dialogue: group.find((a) => a.dialogue)?.dialogue,
      location: primary.location,
      end_pose: last.end_pose,
      duration_seconds: naturalSeconds,
      pace: primary.pace,
      rotation_degrees: primary.rotation_degrees,
      merged_from: group,
      duration_key: durationKey,
      provider_cost_vnd: providerCostVnd,
    };
  });

  return { scenes, totalNaturalSeconds, totalVideoProviderCostVnd };
}

export type PlannedSceneMulti = ScriptSceneResultMulti & {
  duration_key: string | null;
  provider_cost_vnd: number;
};

export type StoryVideoPlanMulti = {
  scenes: PlannedSceneMulti[];
  totalNaturalSeconds: number;
  totalVideoProviderCostVnd: number;
};

// Mirror planStoryVideoScenes() cho NHIỀU NHÂN VẬT — code thuần, không gọi LLM. Gộp liền kề TỰ ĐỘNG
// giống bản 1 nhân vật, nhưng CHỈ gộp khi 2 hành động có ĐÚNG CÙNG tập "characters" (không kể thứ tự)
// — gộp 2 hành động khác tập nhân vật sẽ không rõ ảnh tĩnh của cảnh gộp (chỉ 1 ảnh/cảnh) nên vẽ ai,
// theo mô tả nào. Hành động nào đổi tập nhân vật (thêm/bớt người) luôn giữ ranh giới cảnh riêng.
function sameCharacterSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

export function planStoryVideoScenesMulti(actions: ScriptSceneResultMulti[], videoEntry: VideoModelEntry): StoryVideoPlanMulti {
  const durationMap = videoEntry.duration_price_vnd;
  const maxSeconds = durationMap ? Math.max(...Object.keys(durationMap).map(Number).filter((n) => Number.isFinite(n))) : undefined;

  const groups: ScriptSceneResultMulti[][] = actions.map((a) => [a]);
  const groupSeconds = (g: ScriptSceneResultMulti[]) => g.reduce((sum, a) => sum + a.duration_seconds, 0);
  // Không gộp nếu CẢ HAI nhóm đều đã có lời thoại riêng — mirror đúng chốt an toàn của bản 1 nhân vật
  // (bước ghép "dialogue" bên dưới chỉ giữ được đúng 1 câu/cảnh).
  const groupDialogueCount = (g: ScriptSceneResultMulti[]) => g.filter((a) => a.dialogue).length;
  if (maxSeconds !== undefined) {
    while (groups.length > 1) {
      let bestIdx = -1;
      let bestSum = Infinity;
      for (let i = 0; i < groups.length - 1; i++) {
        if (!sameCharacterSet(groups[i][0].characters, groups[i + 1][0].characters)) continue;
        // Khác địa điểm cũng không gộp (xem bản 1 nhân vật).
        if (!sameLocation(groups[i][0].location, groups[i + 1][0].location)) continue;
        const sum = groupSeconds(groups[i]) + groupSeconds(groups[i + 1]);
        if (sum <= maxSeconds && sum < bestSum && groupDialogueCount(groups[i]) + groupDialogueCount(groups[i + 1]) <= 1) {
          bestSum = sum;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      groups[bestIdx] = [...groups[bestIdx], ...groups[bestIdx + 1]];
      groups.splice(bestIdx + 1, 1);
    }
  }

  let totalNaturalSeconds = 0;
  let totalVideoProviderCostVnd = 0;
  const scenes: PlannedSceneMulti[] = groups.map((group) => {
    const naturalSeconds = groupSeconds(group);
    totalNaturalSeconds += naturalSeconds;
    const durationKey = durationMap ? (resolveNearestDurationKey(durationMap, naturalSeconds) ?? null) : null;
    const providerCostVnd = durationKey !== null ? (durationMap?.[durationKey] ?? videoEntry.provider_cost_vnd) : videoEntry.provider_cost_vnd;
    totalVideoProviderCostVnd += providerCostVnd;
    const primary = group[0];
    const last = group[group.length - 1];
    return {
      ...primary,
      description: group.length === 1 ? primary.description : group.map((a) => a.description).join(" Then, "),
      end_pose: last.end_pose,
      duration_seconds: naturalSeconds,
      dialogue: group.length === 1 ? primary.dialogue : group.find((a) => a.dialogue)?.dialogue,
      duration_key: durationKey,
      provider_cost_vnd: providerCostVnd,
    };
  });
  return { scenes, totalNaturalSeconds, totalVideoProviderCostVnd };
}

// Câu chỉ dẫn thêm khi bật "chuyển động liên tục giữa các cảnh" (continuousMotion) — mỗi cảnh cần
// thêm "end_description" (khoảnh khắc KẾT THÚC của cảnh, dùng làm ảnh cuối) bên cạnh "description"
// (khoảnh khắc chính/đầu cảnh) — ảnh cuối cảnh N sẽ được dùng làm ảnh đầu cảnh N+1 (xem lib này,
// runSceneStage) nên "end_description" của cảnh N và "description" của cảnh N+1 nên tự nhiên nối tiếp.
const CONTINUOUS_MOTION_INSTRUCTION =
  'Chế độ chuyển động liên tục ĐANG BẬT: với MỌI cảnh, thêm khoá "end_description" (chuỗi tiếng Anh) mô tả khoảnh khắc KẾT THÚC của cảnh đó (sau khi hành động trong "description" đã diễn ra một chút) — đây sẽ là điểm nối sang cảnh tiếp theo, nên "end_description" của cảnh này và "description" của cảnh sau nó nên là 2 khoảnh khắc liền mạch tự nhiên (không nhảy cóc hành động/bối cảnh). "end_description" bắt buộc có ở MỌI cảnh, kể cả cảnh cuối cùng. Bối cảnh/địa điểm VÀ ánh sáng/thời điểm trong ngày (khu vườn, bãi biển, ban công, nắng sáng, hoàng hôn...) PHẢI GIỮ NGUYÊN xuyên suốt "description" và "end_description" của MỌI cảnh trong toàn bộ video — đây là 1 cảnh quay liên tục (như 1 shot phim dài), không phải nhiều cảnh phim rời rạc ở nhiều nơi/thời điểm khác nhau. CHỈ đổi bối cảnh hoặc ánh sáng giữa các cảnh nếu ý tưởng truyện gốc yêu cầu RÕ RÀNG (vd truyện tự viết "họ di chuyển từ vườn ra biển", hoặc "trời chuyển tối dần") — hành động nhân vật chuẩn bị rời đi/đứng dậy KHÔNG tự động là lý do để đổi ánh sáng sang tông hoàng hôn/kịch tính hơn nếu truyện không nói. Khung hình/bố cục camera (vị trí bàn, cửa sổ, cửa ra vào... trong khung hình, mức độ zoom/cỡ cảnh) cũng PHẢI giữ nguyên xuyên suốt như 1 shot phim dài quay từ 1 vị trí camera cố định — không được tự đổi góc/khoảng cách máy quay giữa các cảnh trừ khi truyện mô tả rõ nhân vật di chuyển sang chỗ khác. Đặc biệt: MỌI đồ vật/nội thất cụ thể xuất hiện trong khung hình (giường, sofa, bàn, ghế, tủ, thảm...) phải được nêu rõ và giữ NGUYÊN VĂN cùng 1 danh từ xuyên suốt "description" và "end_description" của cùng 1 cảnh VÀ giữa các cảnh liên tiếp — ví dụ đã nói "a sofa" ở đầu cảnh thì "end_description" của chính cảnh đó và "description" của cảnh kế tiếp cũng phải nói "the same sofa", TUYỆT ĐỐI không đổi thành "a bed" hay đồ vật khác dù cùng là "phòng ngủ/phòng khách" chung chung — mỗi cảnh là 1 lần gọi ảnh riêng biệt nên nếu mô tả không nêu cụ thể, model tạo ảnh dễ tự ý đổi đồ nội thất giữa các lần gọi.';

// Chế độ Frame-chain (nối khung hình thật): ảnh BẮT ĐẦU của MỌI cảnh trừ cảnh đầu tiên là khung hình
// CUỐI THẬT trích trực tiếp từ video cảnh liền trước (không phải AI vẽ mới, xem applyFrameChainVideoResult)
// — nghĩa là khi model tạo VIDEO cho cảnh đó, nó CHỈ có đúng 1 ảnh bắt đầu này + "description" làm căn
// cứ, KHÔNG có ảnh Character tham chiếu nào khác đi kèm (khác hẳn bước tạo ẢNH, có gửi kèm Character).
// Nếu cảnh đó bắt đầu với nhân vật đang quay lưng/khuất mặt (camera_view "back") rồi NGAY TRONG CÙNG
// cảnh lại xoay người lộ mặt ra, model tạo video phải tự bịa khuôn mặt lúc lộ ra (không có căn cứ) —
// đây chính là nguyên nhân "đổi sang khuôn mặt khác" khách đã báo. Cảnh ĐẦU TIÊN (position 0) không bị
// giới hạn này vì ảnh bắt đầu của nó do AI vẽ mới trực tiếp từ Character reference (an toàn hơn).
const FRAME_CHAIN_TURN_INSTRUCTION =
  'Chế độ Frame-chain (nối khung hình thật) ĐANG BẬT: ảnh bắt đầu của MỌI cảnh trừ cảnh đầu tiên (cảnh có "camera_view" khác) là khung hình THẬT trích từ video cảnh ngay trước nó — khi tạo video cho cảnh đó, model KHÔNG có bất kỳ ảnh tham chiếu khuôn mặt nào khác ngoài đúng ảnh bắt đầu này. QUY TẮC BẮT BUỘC: TUYỆT ĐỐI không viết 1 "description" có hành động nhân vật xoay từ quay lưng/khuất mặt hoàn toàn (trạng thái camera_view "back" của cảnh TRƯỚC đó) sang lộ mặt/nhìn về phía camera NGAY TRONG CÙNG 1 cảnh — vì lúc đó model tạo video phải tự bịa khuôn mặt không có căn cứ, dễ ra sai khuôn mặt/đổi nhân vật giữa cảnh. Nếu ý tưởng gốc có hành động nhân vật quay người lộ mặt sau khi đang quay lưng, PHẢI tách hành động đó thành ranh giới giữa 2 cảnh: cảnh trước kết thúc ("end_pose") khi nhân vật vẫn còn quay lưng/mới chỉ bắt đầu xoay (chưa lộ mặt hẳn), cảnh sau đó mới bắt đầu ("description") đã lộ mặt hẳn với "camera_view" là 1 trong các góc thấy mặt ("front"/"three_quarter_left"/"three_quarter_right"/"side"/"face") — không được để việc "từ khuất mặt sang lộ mặt" diễn ra như 1 hành động liền mạch bên trong "description" của đúng 1 cảnh.';

// Phòng thủ phía code (không chỉ dựa Agent nghe lời): dù prompt đã yêu cầu rõ "giữ nguyên văn tiếng
// Việt, KHÔNG dịch", model chat vẫn có rủi ro thật dịch câu thoại sang tiếng Anh (cả JSON xung quanh
// toàn tiếng Anh nên model dễ "quán tính" dịch luôn "line"/"dialogue"). Kiểm tra câu thoại AI trả về
// có thực sự là 1 đoạn trích gần đúng trong truyện gốc không (chuẩn hoá bỏ dấu câu/khoảng trắng/hoa
// thường trước khi so) — không khớp thì coi như bị dịch/diễn giải, null hoá để tránh gửi nhầm ngôn ngữ
// vào TTS/lipsync (thà câm còn hơn đọc sai ngôn ngữ).
function isVerbatimQuoteInStory(line: string, story: string): boolean {
  // Bỏ qua khác biệt dấu tiếng Việt khi so khớp (vd khách gõ thiếu dấu "chi" thay vì "chị") — nếu không,
  // Agent viết đúng chính tả có dấu sẽ bị coi là "không khớp nguyên văn" và bị null hoá oan, dù không hề
  // dịch/bịa gì. Dịch sang tiếng Anh thật sự vẫn bị chặn bình thường vì chuỗi tiếng Anh không khớp được
  // với tiếng Việt dù đã bỏ dấu.
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const normalizedLine = normalize(line);
  if (!normalizedLine) return false;
  return normalize(story).includes(normalizedLine);
}

export async function splitStoryIntoScenes(
  storyDescription: string,
  numScenes: number,
  customInstructions?: string,
  modelChatKey?: string,
  continuousMotion?: boolean,
  frameChainMode?: boolean,
  allowScenePadding?: boolean
): Promise<SceneSplitResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  // "Agent xử lý" — admin thêm hướng dẫn phong cách/chủ đề qua model_config.prompt_helper_instructions
  // (đúng field/UI đã dùng cho nút "AI viết giúp mô tả" ở app video-gen). Nối THÊM vào cuối, không
  // thay hẳn — bắt buộc giữ nguyên yêu cầu "chỉ trả JSON đúng N phần tử" để pipeline không gãy.
  const basePrompt = SCENE_SPLIT_SYSTEM_PROMPT.replace("N phân cảnh", `${numScenes} phân cảnh`);
  let systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  if (continuousMotion) systemPrompt += `\n\n${CONTINUOUS_MOTION_INSTRUCTION}`;
  if (frameChainMode) systemPrompt += `\n\n${FRAME_CHAIN_TURN_INSTRUCTION}`;
  if (allowScenePadding) systemPrompt += `\n\n${SCENE_PADDING_INSTRUCTION}`;
  async function attempt(reminder?: string): Promise<SceneSplitResult[]> {
    const userInput = reminder
      ? `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng. Chỉ trả về mảng JSON gồm đúng ${numScenes} object {description, camera_view}, không thêm gì khác.)`
      : storyDescription;
    const { output } = await callOpenRouter(chatModel, 800, systemPrompt, userInput);
    const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("not-json");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== numScenes ||
      !parsed.every(
        (s) =>
          s &&
          typeof s === "object" &&
          typeof (s as { description?: unknown }).description === "string" &&
          (s as { description: string }).description.trim() &&
          CHARACTER_ANGLE_LABELS.includes((s as { camera_view?: unknown }).camera_view as CharacterAngleKey) &&
          ((s as { outfit_override?: unknown }).outfit_override === undefined ||
            (typeof (s as { outfit_override?: unknown }).outfit_override === "string" &&
              (s as { outfit_override: string }).outfit_override.trim())) &&
          ((s as { face_view?: unknown }).face_view === undefined ||
            CHARACTER_ANGLE_LABELS.includes((s as { face_view?: unknown }).face_view as CharacterAngleKey)) &&
          ((s as { dialogue?: unknown }).dialogue === undefined ||
            (typeof (s as { dialogue?: unknown }).dialogue === "string" && (s as { dialogue: string }).dialogue.trim())) &&
          typeof (s as { location?: unknown }).location === "string" &&
          (s as { location: string }).location.trim() &&
          typeof (s as { end_pose?: unknown }).end_pose === "string" &&
          (s as { end_pose: string }).end_pose.trim() &&
          (!continuousMotion ||
            (typeof (s as { end_description?: unknown }).end_description === "string" &&
              (s as { end_description: string }).end_description.trim()))
      )
    ) {
      throw new Error("wrong-shape");
    }
    return (parsed as SceneSplitResult[]).map((s) => ({
      ...s,
      shot_size: resolveShotSize(s.shot_size),
      camera_angle: resolveCameraAngleKey(s.camera_angle),
      camera_movement: resolveCameraMovement(s.camera_movement),
      dialogue: s.dialogue && isVerbatimQuoteInStory(s.dialogue, storyDescription) ? s.dialogue : undefined,
    }));
  }

  try {
    return await attempt();
  } catch {
    try {
      return await attempt("retry");
    } catch {
      throw new Error("AI không chia được phân cảnh hợp lệ, vui lòng thử lại hoặc viết ý tưởng rõ ràng hơn");
    }
  }
}

// Chia cảnh cho job NHIỀU NHÂN VẬT (Bước 2) — song song splitStoryIntoScenes() ở trên nhưng đơn giản
// hơn có chủ đích cho v1: mỗi cảnh chỉ cần biết ai (những SỐ thứ tự nhân vật nào) xuất hiện trong
// khung hình, KHÔNG có camera_view/face_view/outfit_override (những tinh chỉnh đó chỉ áp dụng cho
// đúng 1 người trong 1 khung hình, chưa kiểm chứng khi mở rộng cho nhiều người cùng lúc).
export type MultiSceneSplitResult = {
  description: string;
  characters: number[];
  shot_size: ShotSize;
  camera_angle: CameraAngleKey;
  camera_movement: CameraMovement;
  dialogue?: { speaker: number; line: string } | null;
  end_description?: string;
  end_characters?: number[];
  location: string;
  end_pose: string;
};

// Câu chỉ dẫn continuity riêng cho nhiều nhân vật — nối thêm CONTINUOUS_MOTION_INSTRUCTION (đã định
// nghĩa ở trên, dùng chung cho luồng 1 nhân vật) với 1 câu bổ sung: ảnh cuối cảnh N (dùng làm ảnh đầu
// cảnh N+1) PHẢI khai báo đúng "end_characters" — những ai THẬT SỰ xuất hiện ở khoảnh khắc kết thúc
// (có thể khác "characters" ở đầu cảnh, vd có thêm 1 người vừa bước vào khung hình) — vì hệ thống chỉ
// gửi đúng ảnh tham chiếu của những người trong "end_characters" khi vẽ ảnh cuối; thiếu khai báo sẽ
// khiến AI tự bịa mặt cho người không có ảnh tham chiếu, ra thêm 1 người lạ không phải nhân vật thật.
const CONTINUOUS_MOTION_INSTRUCTION_MULTI =
  CONTINUOUS_MOTION_INSTRUCTION +
  ' Lưu ý thêm cho nhiều nhân vật: với MỌI cảnh, thêm thêm khoá "end_characters" (mảng số, cùng quy tắc chỉ số như "characters") — liệt kê ĐÚNG những nhân vật THẬT SỰ có mặt trong khung hình ở khoảnh khắc KẾT THÚC (mô tả trong "end_description"). Nếu không có ai xuất hiện/biến mất so với đầu cảnh thì "end_characters" giống hệt "characters"; nếu có thêm người bước vào khung hình ở cuối cảnh (vd chuẩn bị sang cảnh sau) thì phải liệt kê thêm đúng số của người đó — TUYỆT ĐỐI không để "end_description" nhắc tới 1 nhân vật mà không có mặt trong "end_characters", vì hệ thống chỉ dùng đúng ảnh tham chiếu của những người trong mảng này, thiếu sẽ khiến AI tự bịa thêm 1 người lạ.';

function buildMultiSceneSplitPrompt(characterLabels: string[]): string {
  const list = characterLabels.map((label, i) => `${i}: ${label}`).join(", ");
  const example =
    characterLabels.length >= 2
      ? `[{"description": "${characterLabels[0]} stands alone by the entrance, waiting nervously, morning light", "characters": [0], "shot_size": "wide_shot", "camera_angle": "eye_level", "camera_movement": "static", "dialogue": {"speaker": 0, "line": "Sao mãi chưa thấy ai đến vậy"}, "location": "a wedding venue entrance, evening", "end_pose": "she is glancing anxiously toward the road"}, {"description": "${characterLabels[0]} and ${characterLabels[1]} stand together, holding hands, smiling warmly", "characters": [0, 1], "shot_size": "medium_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a wedding venue entrance, evening", "end_pose": "they are smiling at each other, hands still held"}]`
      : `[{"description": "a scene description", "characters": [0], "shot_size": "medium_shot", "camera_angle": "eye_level", "camera_movement": "static", "location": "a scene location", "end_pose": "a brief pose description"}]`;
  return `Bạn là đạo diễn dựng phân cảnh cho 1 video có NHIỀU nhân vật thật cùng xuất hiện. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Danh sách nhân vật trong video này (đánh số bắt đầu từ 0): ${list}.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (ai đang làm gì, ở đâu, bối cảnh gì).
Với MỖI cảnh, xác định thêm khoá "characters": 1 mảng các SỐ (đúng chỉ số trong danh sách nhân vật ở trên) — liệt kê TẤT CẢ nhân vật thực sự xuất hiện trong khung hình của cảnh đó, có thể là 1 người hoặc nhiều người cùng lúc. Không tự thêm số ngoài danh sách, không tự bỏ sót người rõ ràng có mặt theo mô tả.
${CAMERA_FRAMING_INSTRUCTION}
Khi viết "description" (tiếng Anh): mô tả rõ ai đang làm gì, có thể thêm chi tiết điện ảnh (ánh sáng, khung hình, không khí) phù hợp bối cảnh gốc, nhưng KHÔNG bịa thêm tình tiết/hành động/địa điểm không có trong ý tưởng gốc.
Rào chắn giữ đúng danh tính (bắt buộc): không tự đổi giới tính/độ tuổi/kiểu tóc của bất kỳ nhân vật nào đã liệt kê ở trên; không tự thêm nhân vật phụ mới ngoài danh sách; nếu ý tưởng gốc mô tả 1 địa điểm liên tục thì không tự đổi bối cảnh giữa các cảnh.
Trang phục — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu sắc/kiểu dáng/chất liệu trang phục của bất kỳ ai trong "description" (ví dụ KHÔNG viết "a white blouse", "a red dress"...). Lý do: bạn KHÔNG nhìn thấy ảnh nhân vật thật — tự bịa màu/kiểu sẽ mâu thuẫn với ảnh tham chiếu thật. Nếu cần nhắc trang phục để giữ liên tục, chỉ viết chung chung "wearing the same outfit as before".
Trạng thái liên tục giữa các cảnh (quan trọng): MỖI cảnh được gửi cho model tạo ảnh RIÊNG BIỆT, độc lập — model đó KHÔNG thấy ảnh của cảnh trước, chỉ thấy đúng "description" của cảnh đang xét. Vì vậy mỗi "description" phải TỰ ĐẦY ĐỦ ngữ cảnh (self-contained): nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 địa điểm kế thừa từ cảnh trước, PHẢI nhắc lại rõ địa điểm/bối cảnh đó trong CHÍNH cảnh đang viết.
Tư thế/hành động nối tiếp (quan trọng, áp dụng cho MỌI cảnh không phải cảnh đầu tiên): "description" của cảnh này PHẢI bắt đầu đúng từ tư thế/hành động mà "end_pose" của cảnh NGAY TRƯỚC nó vừa mô tả — viết liền thành 1 câu tự nhiên, như đó là trạng thái hiện tại (1 khoảnh khắc duy nhất), TUYỆT ĐỐI không viết theo kiểu kể lại 2 mốc thời gian nối nhau (SAI: "she was smiling, and now she stands up"; ĐÚNG: "still smiling as she stands up from the table"). Không tự ý đặt nhân vật về lại tư thế mặc định nếu không có căn cứ đã di chuyển/đổi tư thế giữa 2 cảnh.
Không được bỏ sót hành động đổi tư thế lớn (bắt buộc): nếu ý tưởng gốc có 1 hành động đổi tư thế/trạng thái lớn của bất kỳ nhân vật nào (đứng dậy, ngồi xuống, quay người, bắt đầu di chuyển, dừng lại...), hành động đó PHẢI được thể hiện rõ trong "description" hoặc "end_pose" của ĐÚNG 1 cảnh cụ thể — không được để 2 cảnh liền kề nhảy thẳng từ tư thế này sang tư thế khác mà không cảnh nào thể hiện lúc đang chuyển. Khi số cảnh ít hơn số hành động trong ý tưởng gốc, ưu tiên gộp các hành động KHÔNG đổi tư thế lớn, tuyệt đối không gộp/bỏ qua đúng hành động CÓ đổi tư thế lớn.
Khung hình/bố cục camera nhất quán (bắt buộc, khi nhiều cảnh liên tiếp cùng 1 địa điểm): vị trí các vật thể cố định trong khung hình (bàn, cửa sổ, cửa ra vào...) và mức độ zoom/cỡ cảnh PHẢI giữ nguyên qua các cảnh đó — không được tự đổi bố cục coi như đang quay từ góc khác. Chỉ đổi khi ý tưởng gốc có lý do rõ ràng (nhân vật di chuyển sang vị trí khác, hoặc mô tả rõ máy quay lùi ra/tiến lại gần).
Không tự bịa phụ kiện/biểu cảm không có trong ý tưởng gốc nếu không có căn cứ.
Lời thoại (chỉ áp dụng khi ý tưởng gốc CÓ trích dẫn/thể hiện rõ ràng 1 nhân vật đang NÓI THÀNH LỜI ở đúng cảnh đó): thêm khoá "dialogue" là 1 object {"speaker": số (đúng chỉ số nhân vật đang nói, phải nằm trong mảng "characters" của cảnh đó), "line": chuỗi tiếng Việt giữ NGUYÊN VĂN lời nói, KHÔNG dịch/diễn giải lại, dưới khoảng 15 từ}. Có thể thêm dù cảnh có nhiều người cùng khung hình — hệ thống lồng tiếng chỉ khớp môi đúng người được chỉ định qua "speaker", những người còn lại trong cảnh vẫn giữ nguyên. Cảnh không có lời nói thì KHÔNG thêm khoá "dialogue" (bỏ hẳn khoá này). Không tự bịa thêm lời thoại không có trong ý tưởng gốc.
Bối cảnh vật lý (bắt buộc, MỌI cảnh): thêm khoá "location" (chuỗi tiếng Anh NGẮN GỌN) mô tả nơi cảnh đang diễn ra, BAO GỒM cả ánh sáng/thời điểm trong ngày. Nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 chỗ, "location" của những cảnh đó PHẢI viết Y HỆT NHAU, ĐÚNG TỪNG CHỮ (kể cả phần ánh sáng) — chỉ đổi khi ý tưởng gốc nói RÕ RÀNG có sự di chuyển sang nơi khác hoặc thời gian trôi qua rõ rệt. TUYỆT ĐỐI không tự đổi tông sáng (vd tự thêm hoàng hôn cho cảnh chia tay/rời đi) nếu truyện gốc không nói tới.
Trạng thái kết thúc cảnh (bắt buộc, MỌI cảnh): thêm khoá "end_pose" (chuỗi tiếng Anh NGẮN GỌN) mô tả tư thế/hành động của (các) nhân vật ở khoảnh khắc KẾT THÚC cảnh đó — dùng làm điểm nối sang cảnh kế tiếp.
Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ gồm đúng N phần tử, mỗi phần tử có khoá "description" (chuỗi tiếng Anh), "characters" (mảng số), "shot_size" (bắt buộc), "camera_angle" (bắt buộc), "camera_movement" (bắt buộc), "dialogue" (tuỳ chọn), "location" (bắt buộc) và "end_pose" (bắt buộc) như hướng dẫn trên — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích (comment) nào trong JSON.
Ví dụ format: ${example}`;
}

export async function splitStoryIntoScenesMulti(
  storyDescription: string,
  numScenes: number,
  characterLabels: string[],
  customInstructions?: string,
  modelChatKey?: string,
  continuousMotion?: boolean,
  allowScenePadding?: boolean
): Promise<MultiSceneSplitResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  const basePrompt = buildMultiSceneSplitPrompt(characterLabels).replace("N phân cảnh", `${numScenes} phân cảnh`);
  let systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  if (continuousMotion) systemPrompt += `\n\n${CONTINUOUS_MOTION_INSTRUCTION_MULTI}`;
  if (allowScenePadding) systemPrompt += `\n\n${SCENE_PADDING_INSTRUCTION}`;
  const maxIndex = characterLabels.length - 1;

  async function attempt(reminder?: string): Promise<MultiSceneSplitResult[]> {
    const userInput = reminder
      ? `${storyDescription}\n\n(Lưu ý: lần trước bạn trả sai định dạng. Chỉ trả về mảng JSON gồm đúng ${numScenes} object {description, characters}, không thêm gì khác.)`
      : storyDescription;
    const { output } = await callOpenRouter(chatModel, 900, systemPrompt, userInput);
    const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("not-json");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== numScenes ||
      !parsed.every(
        (s) =>
          s &&
          typeof s === "object" &&
          typeof (s as { description?: unknown }).description === "string" &&
          (s as { description: string }).description.trim() &&
          Array.isArray((s as { characters?: unknown }).characters) &&
          (s as { characters: unknown[] }).characters.length > 0 &&
          (s as { characters: unknown[] }).characters.every(
            (c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= maxIndex
          ) &&
          ((s as { dialogue?: unknown }).dialogue == null ||
            (typeof (s as { dialogue?: unknown }).dialogue === "object" &&
              typeof (s as { dialogue: { speaker?: unknown } }).dialogue.speaker === "number" &&
              typeof (s as { dialogue: { line?: unknown } }).dialogue.line === "string" &&
              (s as { dialogue: { line: string } }).dialogue.line.trim())) &&
          typeof (s as { location?: unknown }).location === "string" &&
          (s as { location: string }).location.trim() &&
          typeof (s as { end_pose?: unknown }).end_pose === "string" &&
          (s as { end_pose: string }).end_pose.trim() &&
          (!continuousMotion ||
            (typeof (s as { end_description?: unknown }).end_description === "string" &&
              (s as { end_description: string }).end_description.trim() &&
              Array.isArray((s as { end_characters?: unknown }).end_characters) &&
              (s as { end_characters: unknown[] }).end_characters.length > 0 &&
              (s as { end_characters: unknown[] }).end_characters.every(
                (c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= maxIndex
              )))
      )
    ) {
      throw new Error("wrong-shape");
    }
    // Phòng thủ phía code (không chỉ dựa Agent nghe lời): giữ dialogue khi speaker hợp lệ (nằm trong
    // "characters" của cảnh, có thể nhiều người trong khung hình — đã kiểm chứng qua test thật Kling
    // LipSync khớp môi đúng người được chỉ định, không ảnh hưởng người còn lại) + câu thoại khớp nguyên
    // văn truyện gốc (chặn Agent dịch sang tiếng Anh, xem isVerbatimQuoteInStory).
    return (parsed as MultiSceneSplitResult[]).map((s) => ({
      ...s,
      shot_size: resolveShotSize(s.shot_size),
      camera_angle: resolveCameraAngleKey(s.camera_angle),
      camera_movement: resolveCameraMovement(s.camera_movement),
      dialogue:
        s.dialogue &&
        s.characters.includes(s.dialogue.speaker) &&
        isVerbatimQuoteInStory(s.dialogue.line, storyDescription)
          ? s.dialogue
          : null,
    }));
  }

  try {
    return await attempt();
  } catch {
    try {
      return await attempt("retry");
    } catch {
      throw new Error("AI không chia được phân cảnh hợp lệ, vui lòng thử lại hoặc viết ý tưởng rõ ràng hơn");
    }
  }
}

type SceneStageInput = Pick<
  JobRow,
  | "id"
  | "mini_app_id"
  | "auto_video"
  | "image_provider_cost_vnd_per_scene"
  | "video_provider_cost_vnd_per_scene"
  | "num_scenes"
  | "image_model"
  | "video_model"
  | "aspect_ratio"
  | "image_resolution_key"
  | "character_sheet_url"
  | "character_angle_urls"
  | "genre_key"
  | "location_reference_url"
  | "location_reference_mask_url"
  | "item_reference_urls"
  | "continuous_motion"
  | "frame_chain_mode"
>;

// Reference Selector — TRA BẢNG BẰNG CODE (key -> URL), không dùng AI: chọn đúng 1 ảnh góc đã cắt sẵn
// (xem cropCharacterSheetIntoAngles) khớp camera_view AI vừa gán cho cảnh, thay vì luôn gửi cả tấm
// Character sheet gộp cho mọi cảnh. Fallback về sheet gộp khi thiếu dữ liệu góc (sheet khách tự tải
// lên "uploaded_sheet", ảnh đơn "skipped", hoặc bước cắt trước đó lỗi/chưa chạy migration).
// faceView (tuỳ chọn, thử nghiệm — Priority 3): khi mặt/ánh nhìn nhân vật lệch hướng với thân người,
// gửi ảnh góc khớp đúng hướng mặt đó làm ảnh tham chiếu thứ 2. Mặc định (Rule 28, không cần faceView
// riêng): MỌI cảnh còn thấy mặt (camera_view khác "back") đều gửi kèm THÊM face.png làm ảnh tham
// chiếu thứ 2, để model tạo ảnh có căn cứ giữ đúng khuôn mặt ổn định hơn — không đảm bảo 100% (model
// tự pha trộn theo text hướng dẫn), chỉ áp dụng khi có đủ dữ liệu ảnh góc đã cắt (angleUrls).
function selectReferenceImagesForScene(
  cameraView: string | null,
  angleUrls: CharacterAngleUrls | null,
  sheetUrl: string,
  faceView?: string | null
): string[] {
  if (angleUrls && cameraView && cameraView in angleUrls) {
    const bodyImage = angleUrls[cameraView as CharacterAngleKey];
    if (faceView && faceView !== cameraView && faceView in angleUrls) {
      return [bodyImage, angleUrls[faceView as CharacterAngleKey]];
    }
    if (cameraView !== "back" && cameraView !== "face" && "face" in angleUrls) {
      return [bodyImage, angleUrls.face];
    }
    return [bodyImage];
  }
  return [sheetUrl];
}

type ImageSceneRefRow = {
  id: number;
  scene_description: string | null;
  camera_view: string | null;
  shot_size: string | null;
  camera_angle: string | null;
  outfit_override: string | null;
  face_view: string | null;
  location: string | null;
};

// Scene State — tiêm (inject) BỐI CẢNH nối tiếp vào ĐẦU prompt tạo ảnh BẰNG CODE, không trông chờ
// Agent tự nhớ nhắc lại trong "description" (cách cũ, chỉ dựa prompt, không chắc chắn). Chỉ dùng ở
// nhánh KHÔNG bật continuousMotion (chế độ đó đã có cơ chế nối ẢNH thật mạnh hơn — xem runSceneStage).
// LƯU Ý (đã xác nhận qua test thật): KHÔNG dùng câu "Continuing directly from this moment: {end_pose}"
// — model ảnh (Flux Kontext, có thể cả model khác) hiểu nhầm câu này là yêu cầu VẼ RA cả khoảnh khắc
// trước lẫn khoảnh khắc hiện tại trong CÙNG 1 tấm (ra ảnh 2 khung dính liền như storyboard/before-after)
// thay vì chỉ dùng làm ngữ cảnh cho 1 ảnh tĩnh — previousEndPose vẫn được tính/truyền vào (dùng cho
// tương lai nếu tìm được cách diễn đạt an toàn hơn) nhưng KHÔNG được đưa vào prompt thật ở đây.
function buildContinuityPrefix(location: string | null | undefined, previousEndPose: string | null | undefined): string {
  void previousEndPose;
  return location ? `Setting: ${location}. ` : "";
}

// Mô tả bằng chữ vị trí 1 vùng mask (theo tâm vùng, chia lưới 3x3) — dùng để viết chỉ dẫn "nhân vật X
// đứng ở vùng bên trái/giữa/phải..." khi cảnh có NHIỀU nhân vật cùng chung 1 ảnh Bối cảnh, vì mask_url
// tự nó không phân biệt được vùng trắng nào ứng với ai (xem JobRow.location_reference_mask_zones).
function describeMaskZonePosition(zone: LocationMaskZone): string {
  const cx = zone.xPct + zone.wPct / 2;
  const cy = zone.yPct + zone.hPct / 2;
  const h = cx < 0.34 ? "left" : cx > 0.66 ? "right" : "center";
  const v = cy < 0.34 ? "upper" : cy > 0.66 ? "lower" : "middle";
  if (h === "center" && v === "middle") return "center";
  if (v === "middle") return `${h} side`;
  if (h === "center") return `${v} center`;
  return `${v}-${h}`;
}

// Build prompt + chọn ảnh tham chiếu + submit Fal.ai cho ĐÚNG 1 cảnh — dùng chung cho batch tạo lần
// đầu (runSceneStage) và tạo lại riêng lẻ 1 cảnh (regenerateSceneImage), tránh lặp logic ở 2 nơi
// (từng gây lệch bug multi_image trước đây khi chỉ sửa 1 chỗ). regen=true thêm cờ &regen=1 vào
// webhook URL để applyImageStageResult biết không cần chờ/kiểm tra các cảnh khác. previousEndPose (Scene
// State — chỉ nhánh không continuousMotion mới truyền vào): end_pose của cảnh liền trước, tiêm vào đầu
// prompt qua buildContinuityPrefix() để nối tiếp chắc chắn bằng code thay vì chỉ trông chờ Agent.
async function submitSceneImageForRow(
  job: Pick<
    JobRow,
    | "id"
    | "mini_app_id"
    | "character_angle_urls"
    | "character_sheet_url"
    | "image_model"
    | "aspect_ratio"
    | "image_resolution_key"
    | "location_reference_url"
    | "location_reference_mask_url"
    | "item_reference_urls"
  >,
  row: ImageSceneRefRow,
  imageEntry: ImageModelEntry | undefined,
  regen: boolean,
  stage: "image" | "image_end" = "image",
  previousEndPose?: string | null,
  propagateToSceneId?: number,
  // Frame-chaining — khung hình THẬT trích từ video cảnh liền trước (khác continuous_motion dùng ảnh
  // AI tự đoán trước khi có video). Chỉ nhánh 1 nhân vật hỗ trợ ở v1 — xem applyFrameChainVideoResult().
  chainedFrameUrl?: string
): Promise<string> {
  // MARKER_SINGLE_CHARACTER_IMAGE_SUBMIT
  // Frame-chaining (chainedFrameUrl có giá trị, từ cảnh 2 trở đi): LUÔN gửi CẢ 2 nguồn — ảnh Character
  // gốc (giữ mặt) VÀ khung hình thật cảnh trước (giữ tư thế/trang phục/bối cảnh) — không chỉ dùng 1
  // trong 2. Lần đầu thử chỉ dùng khung hình thật (bỏ hẳn ảnh Character) đã sửa được lỗi lẫn 2 nguồn
  // ảnh "người" (ra sai người hoàn toàn), NHƯNG lại lộ lỗi khác nghiêm trọng hơn: nếu khung hình cảnh
  // trước đang quay lưng/khuất mặt (hoàn toàn hợp lệ, hệ thống có camera_view "back"), cảnh sau sẽ
  // KHÔNG CÒN GÌ để biết mặt thật ra sao — AI buộc phải tự bịa mặt. Sửa đúng gốc: luôn có ảnh Character
  // làm "nguồn mặt" cố định xuyên suốt, khung hình chain chỉ đảm nhận "nguồn tư thế/bối cảnh" — xem câu
  // chỉ dẫn phân vai rõ ràng bên dưới (mirror đúng cách đã làm cho cặp ảnh thân/mặt ở luồng thường).
  const characterImages = selectReferenceImagesForScene(
    row.camera_view,
    job.character_angle_urls,
    job.character_sheet_url as string,
    row.face_view
  );
  // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — nối THÊM vào cuối, độc lập với ảnh
  // thân/mặt ở trên. Chỉ gửi khi model thật sự hỗ trợ đa ảnh, không thì im lặng bỏ qua (không throw
  // lỗi) — đúng tiền lệ đã làm với face_view. Bỏ qua khi có chainedFrameUrl để giữ tổng số ảnh tham
  // chiếu gọn (character + chained là đủ, không cần thêm địa điểm vì khung hình chain đã tự chứa đúng
  // bối cảnh thật của bước trước rồi).
  // Ảnh Vật phẩm riêng (tuỳ chọn, vd đôi giày/túi xách thật của nhân vật) — nối vào TRƯỚC địa điểm.
  // KHÁC với địa điểm: LUÔN gửi kể cả khi có chainedFrameUrl (đã sửa — bản đầu lỡ copy nhầm logic bỏ
  // qua của địa điểm). Lý do: khung hình chain chỉ THẬT SỰ chứa đúng vật phẩm nếu vật phẩm đó đã được
  // model vẽ đúng ở cảnh trước — nếu cảnh 1 lỡ vẽ sai/thiếu vật phẩm, mọi cảnh chain sau sẽ mất hẳn vật
  // phẩm vĩnh viễn vì không còn nguồn nào để tham chiếu lại (khác địa điểm — cả 1 căn phòng lớn nên
  // khung hình chain gần như chắc chắn giữ được; khác cả mặt — luôn có ảnh Character riêng không phụ
  // thuộc chain). Giữ ảnh vật phẩm làm nguồn tham chiếu cố định xuyên suốt, giống hệt vai trò ảnh
  // Character cho khuôn mặt.
  const itemUrls = (imageEntry?.multi_image ?? false) ? (job.item_reference_urls ?? []) : [];
  const hasItem = itemUrls.length > 0;
  const hasLocation = !chainedFrameUrl && !!job.location_reference_url && (imageEntry?.multi_image ?? false);
  // Vị trí đứng chính xác (mask) — chỉ áp dụng khi có ảnh Bối cảnh + đã khoanh vùng + model đang chọn
  // THẬT SỰ hỗ trợ mask_url (chỉ "fal-ai/gpt-image-2/edit", xem buildImageRequestBody). Model khác vẫn
  // dùng ảnh Bối cảnh như tham chiếu chung (hasLocation), chỉ là không có mask định vị chính xác.
  const hasLocationMask = hasLocation && !!job.location_reference_mask_url && job.image_model === "fal-ai/gpt-image-2/edit";
  const referenceImages = [...characterImages];
  if (hasItem) referenceImages.push(...itemUrls);
  if (hasLocation) referenceImages.push(job.location_reference_url as string);
  if (chainedFrameUrl) referenceImages.push(chainedFrameUrl);
  // Tầng 2 (Appearance) — chỉ cảnh có outfit_override mới chèn thêm chỉ dẫn đổi đồ vào cuối prompt,
  // đè lên đồ trong ảnh tham chiếu (Tầng 1 mặt/tóc/dáng người vẫn giữ nguyên qua ảnh tham chiếu như
  // bình thường). Không đổi gì với cảnh không có outfit_override.
  // Khi đang frame-chain: BỎ câu "Setting: {location}" — location này do Agent viết cho cảnh MỚI, có
  // thể diễn đạt khác chữ với bối cảnh THẬT đã có sẵn trong chainedFrameUrl (vd Agent viết "phòng
  // khách" trong khi khung hình chain vẫn đang là phòng ngủ) — 2 nguồn "bối cảnh" xung đột nhau khiến
  // model phải chọn 1 trong 2, thường ưu tiên chữ mô tả cảnh mới hơn ảnh, gây "nhảy cóc" hẳn sang bối
  // cảnh/khung hình khác thay vì tiếp nối mượt — xem chỉ dẫn camera/framing bên dưới, đã đủ để dẫn dắt
  // bối cảnh đúng nghĩa "tiếp nối thật" mà không cần câu địa điểm bằng chữ giẫm chân lên nhau.
  const continuityPrefix = chainedFrameUrl ? "" : buildContinuityPrefix(row.location, previousEndPose);
  // Xác nhận qua test thật (job story-100): KHÔNG có outfit_override + KHÔNG có chainedFrameUrl (cảnh
  // đầu tiên, chỉ dựa ảnh Character) — model tự bịa hẳn 1 bộ trang phục khác (áo choàng ngủ) dù truyện
  // không hề nhắc tới, khác hẳn trang phục thật trong ảnh tham chiếu (tube đen + short trắng) — chỉ vì
  // "không khí" cảnh (phòng ngủ, buổi sáng) gợi ý AI liên tưởng sang ảnh stock photo "thức dậy mặc áo
  // choàng". Trước đây hoàn toàn ngầm định model tự giữ đúng trang phục qua ảnh tham chiếu — không đủ
  // chắc chắn. Ép rõ bằng câu chữ khi KHÔNG đổi đồ và KHÔNG đang chain (chain đã có câu riêng bảo lấy
  // trang phục từ khung hình chain, xem nhánh chainedFrameUrl bên dưới — không chèn thêm ở đây kẻo mâu
  // thuẫn 2 nguồn "trang phục" cùng lúc).
  let scenePrompt = row.outfit_override
    ? `${continuityPrefix}${row.scene_description} Change the character's outfit to: ${row.outfit_override}. Keep the exact same face, hairstyle, and body proportions as shown in the reference image — only the clothing changes.`
    : chainedFrameUrl
      ? `${continuityPrefix}${row.scene_description}`
      : `${continuityPrefix}${row.scene_description} Keep the exact same clothing/outfit (garment type, color, style) shown in the character reference image(s) — do not substitute different clothing (e.g. a robe, a different top or bottom, different colors), even if the scene's mood or setting might otherwise suggest different attire.`;
  scenePrompt += buildCameraFramingClause(row.shot_size, row.camera_angle);
  // 2 ảnh tham chiếu (thử nghiệm): ảnh 1 = hướng thân, ảnh 2 = mặt. Câu chỉ dẫn khác nhau tuỳ trường
  // hợp: Priority 3 (face_view lệch hướng camera_view) cần model đổi HƯỚNG mặt theo ảnh 2; Rule 28
  // (mặc định, mọi cảnh còn thấy mặt) chỉ cần model GIỮ ĐÚNG danh tính khuôn mặt theo ảnh 2, không đổi
  // hướng (đã cùng hướng với ảnh 1 rồi). CHỈ thêm câu chỉ dẫn này khi model THẬT SỰ hỗ trợ đa ảnh
  // (multi_image) — model không hỗ trợ (vd Flux Kontext) chỉ nhận đúng ảnh đầu tiên (xem
  // buildImageRequestBody), nói về "ảnh thứ 2" mà model không hề nhận được là vô nghĩa. Mô tả theo
  // FIRST/SECOND (không nói cứng "hai ảnh") để còn ghép thêm câu địa điểm phía sau mà không mâu thuẫn
  // số lượng ảnh thật sự gửi đi.
  // Khi có chainedFrameUrl: BỎ QUA hẳn khối "FIRST=body pose" cũ bên dưới — nó mâu thuẫn trực tiếp với
  // chainedFrameUrl (khối cũ bảo lấy tư thế từ ảnh Character, nhưng ở chế độ chain tư thế phải lấy từ
  // khung hình chain mới đúng). Thay bằng 1 khối chỉ dẫn PHÂN VAI rõ ràng: ảnh Character (1-2 ảnh đầu)
  // = nguồn MẶT cố định xuyên suốt cả job; khung hình chain (ảnh cuối) = nguồn TƯ THẾ/TRANG PHỤC/BỐI
  // CẢNH của đúng khoảnh khắc đang tiếp diễn. Bắt buộc phải LUÔN kèm ảnh Character dù đang chain — nếu
  // chỉ dùng khung hình chain một mình, lúc cảnh trước kết thúc bằng tư thế quay lưng/khuất mặt (hợp lệ,
  // camera_view "back") thì cảnh sau sẽ không còn gì để biết mặt thật, buộc phải bịa — đã xác nhận qua
  // test thật đây là nguyên nhân "khuôn mặt trôi dần thành người khác" qua nhiều cảnh liên tiếp.
  if (chainedFrameUrl) {
    const faceRefLabel = characterImages.length === 2 ? "FIRST and SECOND reference images" : "FIRST reference image";
    // Bản đầu chỉ nói "dùng làm tham khảo tư thế/bối cảnh" — quá lỏng, model tự do vẽ lại bố cục hoàn
    // toàn khác (đổi khoảng cách máy quay, góc chụp, tư thế tĩnh mới) miễn còn "hợp" với mô tả cảnh, gây
    // hiệu ứng "nhảy cóc" giữa 2 cảnh dù đã crossfade — xác nhận qua so khung hình thật ở đúng điểm nối
    // (job story-97: 2 điểm nối đều đổi hẳn phòng/tư thế đột ngột). Sửa: ép rõ đây là ẢNH BẮT ĐẦU của
    // khoảnh khắc NGAY SAU khung hình chain — giữ nguyên khoảng cách/góc máy/bố cục, chỉ thay đổi đúng
    // phần mô tả cảnh yêu cầu, và nếu cảnh mới đổi bối cảnh thì phải là chuyển động tự nhiên tiếp diễn
    // (vd đang bước đi tới) chứ không phải bị "dịch chuyển tức thời" sang khung hình/tư thế tĩnh khác.
    scenePrompt += ` The LAST reference image is the real frame this scene continues from, one instant later in the same continuous shot. This new image MUST keep the same camera distance, framing, and angle as that reference image, and continue the character's body position and motion naturally from it — only change what the scene description above requires, changing gradually, never resetting to a different framing, a different angle, or an unrelated static pose. If the scene description moves to a different setting, show it as a natural continuation of that motion (e.g. still mid-step, mid-turn), not an abrupt jump to an already-arrived, already-posed shot. Use the reference image for pose, motion continuation, clothing, and setting, never for the face. For the character's face and identity, always match the ${faceRefLabel} exactly — keep the identical face even if the last reference image's face looks slightly different due to motion blur, camera angle, or lighting.`;
  } else if (characterImages.length === 2 && imageEntry?.multi_image) {
    scenePrompt += row.face_view && row.face_view !== row.camera_view
      ? ` The FIRST reference image shows the body pose/angle to follow, the SECOND shows the face/gaze direction to follow — combine them: keep the body pose from the first image, but the face orientation and eye direction from the second image.`
      : ` The FIRST reference image shows the body pose/angle to follow, the SECOND is a close-up reference for the character's face — use it to keep facial identity accurate and consistent while following the body pose from the first image.`;
  }
  // Nhiều vật phẩm (tối đa MAX_ITEM_REFERENCES) — mỗi ảnh có câu chỉ dẫn RIÊNG nêu rõ số thứ tự ảnh,
  // tránh model lẫn lộn/trộn đặc điểm của vật phẩm này sang vật phẩm khác khi có từ 2 món trở lên.
  itemUrls.forEach((_, i) => {
    const idx = characterImages.length + i + 1;
    // Xác nhận qua phản hồi thật: câu chỉ dẫn cũ ("depict accurately") quá yếu — model vẫn vẽ ra vật
    // phẩm có kiểu/màu khác (đúng loại đồ vật, sai chi tiết thật), giống hệt lỗi trang phục đã sửa
    // trước đây. Viết mạnh hơn theo đúng công thức đã hiệu quả với outfit_override: gọi thẳng đây là
    // ẢNH THẬT của khách, liệt kê rõ các khía cạnh KHÔNG được đổi (màu/kiểu/hoạ tiết/chất liệu), và cấm
    // rõ việc vẽ 1 phiên bản "giống giống" hoặc chung chung thay cho ảnh thật.
    // SỬA (xác nhận thật: khách tải ảnh giày tham chiếu nhưng video ra chân không đi giày): điều kiện
    // cũ "Whenever the scene description mentions... wearing" gần như KHÔNG BAO GIỜ đúng — scene_description
    // do Agent viết từ truyện của khách, mà truyện thường không hề tường thuật rõ "đang đi giày" (coi
    // là mặc định/ngầm hiểu), nên câu lệnh có vật phẩm chưa từng được kích hoạt. Đổi hẳn sang mặc định
    // LUÔN hiện vật phẩm (giống cách outfit đã dùng — mặc định giữ nguyên trừ khi cảnh nói khác), chỉ bỏ
    // khi cảnh MÔ TẢ RÕ tình huống ngược lại (vd đi chân đất, đã cởi ra để sang 1 bên).
    scenePrompt += ` Reference image #${idx} is a REAL photo of one of the character's own physical items (e.g. shoes, a bag, an accessory, or another object) — this is not a generic example, it is the customer's actual item. The character should be shown wearing/holding/using this exact item throughout this scene (e.g. on their feet if it's shoes, on their shoulder if it's a bag) — do NOT omit it just because the scene description does not explicitly mention it in words; only leave it out if the scene description explicitly describes a contrary situation (e.g. barefoot, item set aside). When shown, you MUST copy this exact real item's appearance precisely: same color, same shape/silhouette, same pattern/design details, same material/texture — exactly as shown in reference image #${idx}. Do NOT substitute a different color, a different style, a generic or similar-looking version, or any item that merely resembles it — treat matching this item's exact real appearance with the same strictness as matching the character's face. If it is worn (e.g. shoes, a hat, an accessory), render it properly fitted and positioned on the body at the correct real-world size and angle — not floating, not misaligned, not oversized or undersized — as if the character is actually and naturally wearing it.`;
  });
  if (hasLocation) {
    const idx = characterImages.length + itemUrls.length + 1;
    scenePrompt += hasLocationMask
      ? ` Reference image #${idx} shows a REAL physical location, together with an inpainting mask (provided via mask_url) that marks EXACTLY where to place the character within that location: the WHITE area of the mask is where the character must stand/be positioned, the BLACK area must remain pixel-identical to reference image #${idx} — do not alter, redraw, move, or crop anything outside the white masked area. Preserve the real location's appearance (layout, colors, decor, lighting) accurately everywhere outside the masked area.`
      : ` Reference image #${idx} shows a REAL physical location — place this scene at that exact real location, preserving its real appearance (layout, colors, decor, lighting) accurately. Do not invent a different location.`;
  }
  // Ép ảnh chụp thật — model dễ ngả sang phong cách minh hoạ/tranh vẽ khi scene_description dùng
  // ngôn từ giàu chất thơ (hoàng hôn, khu vườn hoa...) mà không có chỉ dẫn phong cách hình ảnh rõ ràng.
  scenePrompt += ` Photorealistic photo, shot on a real camera — not an illustration, painting, drawing, anime, or digital art. Sharp, perfect focus on the subject, commercial-grade production quality.`;
  // Khách đa số không rành nhiếp ảnh/ánh sáng — truyện chỉ tả kiểu "đi lúc bình minh" là đủ với họ, còn
  // việc mặt nhân vật có bị tối/ngược sáng hay không là việc app phải tự lo, không thể dò từng từ khoá
  // (bình minh/đêm tối/hang động/nến...) vì vô số tình huống không liệt kê hết được. Thêm 1 câu KHÔNG
  // ĐIỀU KIỆN áp dụng cho MỌI cảnh, bất kể ánh sáng mô tả là gì.
  scenePrompt += ` Regardless of what kind of lighting the scene describes (sunset, sunrise, night, backlight, inside a cave, a dark room, candlelight, or any other lighting condition), always keep the character's face and key details visible and reasonably well-exposed; if the described lighting would leave the face or important details lost in shadow or unrecognizable, automatically add a very subtle, natural fill light matching the direction, color, intensity, atmosphere, and mood of the existing light, without altering or breaking the original lighting scenario.`;
  // Xác nhận qua test thật (job story-100, story-97): khi cảnh có gương, model tự vẽ ra ảnh phản chiếu
  // với gương mặt KHÁC hẳn nhân vật thật (son đậm hơn, gò má khác) — lưới kiểm tra danh tính bắt được
  // lỗi này nhưng vẽ lại cũng dễ sai lại vì đây là điểm yếu chung của model (không "soi gương" thật, chỉ
  // đoán). Thêm câu chỉ dẫn riêng — không tốn gì khi cảnh không có gương, chỉ hữu ích khi có.
  scenePrompt += ` If this scene includes a mirror or any other reflective surface, the reflection must show the exact same face and identity as the real character in the shot — never draw a different-looking face in the reflection.`;
  // Rà lại danh sách quy tắc bảo toàn danh tính (đối chiếu ý tưởng "Character Manager Agent" của anh):
  // khuôn mặt/tóc/tuổi/tỉ lệ/trang phục đã có câu chỉ dẫn riêng ở trên hoặc trong CHARACTER_SHEET_PROMPT
  // — CHỈ THIẾU đúng 1 ý: giữ phụ kiện (kính, vòng cổ, đồng hồ...) đã có sẵn trong ảnh tham chiếu xuyên
  // suốt các cảnh. Trước đây chỉ có quy tắc "không tự BỊA THÊM phụ kiện mới" (ở SCENE_SPLIT_SYSTEM_PROMPT,
  // tầng viết mô tả) — chưa có quy tắc "phải GIỮ phụ kiện đã có" ở tầng tạo ảnh. Bổ sung câu này.
  scenePrompt += ` Keep any accessories (glasses, jewelry, watch, hat, or similar items) shown on the character in the reference image(s) — do not remove or omit them in this scene, and do not add new accessories that are not in the reference image(s), unless the scene description explicitly requires a change.`;
  // Chặn chữ dính từ ảnh tham chiếu — character sheet có nhãn in sẵn ("1) FRONT VIEW", "5) BACK
  // VIEW"...) nên model đôi khi bị dính vụn chữ đó vào ảnh cảnh mới dù không liên quan.
  scenePrompt += ` The output image must contain NO text, letters, numbers, labels, captions, watermarks, or UI overlays anywhere in the frame — completely ignore and do not reproduce any panel numbers or text labels visible in the reference images.`;
  // Skill "scene-image" — admin ghi thêm ghi chú qua /admin (vd luôn ép 1 phong cách ánh sáng riêng).
  const scenePromptOverride = await resolveSkillOverride(job.mini_app_id, "scene_image_prompt");
  if (scenePromptOverride) scenePrompt += ` Ghi chú thêm từ admin: ${scenePromptOverride}`;
  const body = buildImageRequestBody(
    job.image_model as string,
    scenePrompt,
    referenceImages,
    imageEntry?.multi_image ?? false,
    job.aspect_ratio ?? "9:16",
    job.image_resolution_key ?? undefined,
    hasLocationMask ? (job.location_reference_mask_url as string) : undefined
  );
  return submitFalJob(
    job.image_model as string,
    body,
    `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&sceneId=${row.id}&stage=${stage}${regen ? "&regen=1" : ""}${
      propagateToSceneId ? `&propagateToSceneId=${propagateToSceneId}` : ""
    }`
  );
}

type JobCharacterRefRow = {
  position: number;
  label: string | null;
  character_sheet_url: string | null;
  character_angle_urls: CharacterAngleUrls | null;
  item_reference_urls: string[] | null;
  appearance_description: string | null;
};

// Reference Selector cho job NHIỀU NHÂN VẬT (Bước 2) — đơn giản hơn hẳn selectReferenceImagesForScene
// có chủ đích: mỗi người CHỈ lấy đúng 1 ảnh đại diện (góc "front" đã cắt sẵn, hoặc sheet gộp nếu thiếu
// dữ liệu góc), KHÔNG chọn theo camera_view/face_view như luồng 1 nhân vật — đúng công thức đã kiểm
// chứng qua test thật (ảnh thẳng mặt đơn giản đã ghép chung khung hình tốt, kể cả tư thế phức tạp).
function selectReferenceImagesForMultiScene(
  characterPositions: number[],
  jobCharacters: JobCharacterRefRow[]
): { position: number; url: string; label: string; itemUrls: string[] }[] {
  return characterPositions
    .map((pos) => {
      const jc = jobCharacters.find((c) => c.position === pos);
      if (!jc) return null;
      const url = jc.character_angle_urls?.front || jc.character_sheet_url || "";
      if (!url) return null;
      return { position: pos, url, label: jc.label || `Nhân vật ${pos + 1}`, itemUrls: jc.item_reference_urls ?? [] };
    })
    .filter((r): r is { position: number; url: string; label: string; itemUrls: string[] } => !!r);
}

type MultiCharacterSceneRefRow = {
  id: number;
  scene_description: string | null;
  character_positions: number[] | null;
  shot_size: string | null;
  camera_angle: string | null;
  location: string | null;
};

// Build prompt (liệt kê rõ ảnh nào ứng với ai) + submit Fal.ai cho ĐÚNG 1 cảnh nhiều nhân vật — dùng
// chung cho batch tạo lần đầu (runMultiCharacterSceneStage) và tạo lại riêng lẻ sau này (Bước 3).
// previousEndPose (Scene State — chỉ nhánh không continuousMotion mới truyền vào): xem
// buildContinuityPrefix() ở submitSceneImageForRow (cùng cơ chế, dùng chung).
async function submitMultiCharacterSceneImageForRow(
  job: Pick<
    JobRow,
    | "id"
    | "mini_app_id"
    | "image_model"
    | "aspect_ratio"
    | "image_resolution_key"
    | "location_reference_url"
    | "location_reference_mask_url"
    | "location_reference_mask_zones"
  >,
  row: MultiCharacterSceneRefRow,
  jobCharacters: JobCharacterRefRow[],
  imageEntry: ImageModelEntry | undefined,
  regen: boolean,
  stage: "image" | "image_end" = "image",
  previousEndPose?: string | null,
  propagateToSceneId?: number
): Promise<string> {
  const refs = selectReferenceImagesForMultiScene(row.character_positions ?? [], jobCharacters);
  // Ảnh Vật phẩm riêng của từng nhân vật (tuỳ chọn, mỗi người tối đa MAX_ITEM_REFERENCES món) — nối
  // vào SAU toàn bộ ảnh mặt/thân, TRƯỚC ảnh Địa điểm. Chỉ những nhân vật CÓ mặt trong cảnh này (đã lọc
  // qua "refs") và CÓ upload vật phẩm mới được nối thêm — không phải cứ có upload là luôn gửi cho mọi
  // cảnh. Mỗi vật phẩm là 1 phần tử riêng (không gộp theo người) để còn viết câu chỉ dẫn riêng từng ảnh.
  const supportsMultiImage = imageEntry?.multi_image ?? false;
  const itemRefs = supportsMultiImage
    ? refs.flatMap((r) => r.itemUrls.map((url) => ({ label: r.label, url })))
    : [];
  // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — nối THÊM vào cuối cùng, sau ảnh vật
  // phẩm. Chỉ gửi khi model thật sự hỗ trợ đa ảnh, không thì im lặng bỏ qua.
  const hasLocation = !!job.location_reference_url && supportsMultiImage;
  // Vị trí đứng chính xác (mask) — mirror logic đã thêm cho luồng 1 nhân vật (xem
  // submitSceneImageForRow), nhưng nhiều nhân vật cần thêm 1 điều kiện: MỌI nhân vật có mặt trong
  // CẢNH NÀY đều phải có vùng đã gán (location_reference_mask_zones) — nếu thiếu dù chỉ 1 người, ảnh
  // mask (đã cố định cho cả job) sẽ không có chỗ hợp lệ nào để đặt người đó (vùng đen phải giữ nguyên
  // pixel, không thể chèn người vào đó), nên phải bỏ hẳn mask cho cảnh này, để model tự do đặt như
  // hasLocation thường (an toàn hơn là ép mask sai).
  const maskZonesForScene = (job.location_reference_mask_zones ?? []).filter((z) => (row.character_positions ?? []).includes(z.position));
  const hasLocationMask =
    hasLocation &&
    !!job.location_reference_mask_url &&
    job.image_model === "fal-ai/gpt-image-2/edit" &&
    maskZonesForScene.length > 0 &&
    maskZonesForScene.length === (row.character_positions ?? []).length;
  const referenceImages = [
    ...refs.map((r) => r.url),
    ...itemRefs.map((r) => r.url),
    ...(hasLocation ? [job.location_reference_url as string] : []),
  ];
  let scenePrompt = buildContinuityPrefix(row.location, previousEndPose) + (row.scene_description ?? "");
  scenePrompt += buildCameraFramingClause(row.shot_size, row.camera_angle);
  if (refs.length >= 2) {
    const mapping = refs.map((r, i) => `Image ${i + 1} = ${r.label}`).join(", ");
    scenePrompt += ` Multiple reference images are provided, each showing a DIFFERENT real person: ${mapping}. Combine them so ALL of these people appear together in the scene as described — preserve each person's exact facial identity, hairstyle, and skin tone from their own reference image, do not blend or merge their faces into a single person, do not invent extra people.`;
  } else if (refs.length === 1) {
    scenePrompt += ` Use the reference image to keep ${refs[0].label}'s facial identity accurate and consistent.`;
  }
  itemRefs.forEach((r, i) => {
    const idx = refs.length + i + 1;
    // Mirror đúng câu chỉ dẫn mạnh hơn đã sửa cho luồng 1 nhân vật (submitSceneImageForRow) — cùng
    // nguyên nhân lỗi (vật phẩm ra sai màu/kiểu so với ảnh thật khách tải lên) + cùng lỗi mặc định tắt
    // (điều kiện "whenever mentions" gần như không bao giờ đúng vì scene_description hiếm khi tường
    // thuật rõ đang đi giày) — đổi sang mặc định LUÔN hiện, chỉ tắt khi cảnh mô tả rõ tình huống ngược lại.
    scenePrompt += ` Reference image #${idx} is a REAL photo of one of ${r.label}'s own physical items — this is not a generic example, it is the customer's actual item. ${r.label} should be shown wearing/holding/using this exact item throughout this scene (e.g. on their feet if it's shoes, on their shoulder if it's a bag) — do NOT omit it just because the scene description does not explicitly mention it in words; only leave it out if the scene description explicitly describes a contrary situation (e.g. barefoot, item set aside). When shown, you MUST copy this exact real item's appearance precisely: same color, same shape/silhouette, same pattern/design details, same material/texture — exactly as shown in reference image #${idx}. Do NOT substitute a different color, a different style, a generic or similar-looking version, or any item that merely resembles it. If it is worn (e.g. shoes, a hat, an accessory), render it properly fitted and positioned on ${r.label}'s body at the correct real-world size and angle — not floating, not misaligned, not oversized or undersized — as if actually and naturally worn.`;
  });
  if (hasLocation) {
    if (hasLocationMask) {
      // Mask gộp CHUNG 1 ảnh cho cả job — nhiều vùng trắng cùng lúc, tự nó KHÔNG phân biệt được vùng
      // nào cho ai (xem JobRow.location_reference_mask_zones), nên phải bù bằng câu chỉ dẫn văn bản
      // gán rõ từng người vào đúng vùng theo vị trí tương đối (trái/phải/giữa...).
      const placementLines = refs
        .map((r) => {
          const zone = maskZonesForScene.find((z) => z.position === r.position);
          return zone ? `${r.label} must be placed in the ${describeMaskZonePosition(zone)} of the white masked region` : null;
        })
        .filter((s): s is string => !!s)
        .join("; ");
      scenePrompt += ` The LAST reference image shows a REAL physical location, together with an inpainting mask (provided via mask_url) that marks the area(s) where characters may be placed within that location: the WHITE area(s) of the mask are editable, the BLACK area must remain pixel-identical to that reference image — do not alter, redraw, move, or crop anything outside the white area(s). Within the white area(s): ${placementLines}. Preserve the real location's appearance (layout, colors, decor, lighting) accurately everywhere outside the masked area(s).`;
    } else {
      scenePrompt += ` The LAST reference image shows a REAL physical location — place this scene at that exact real location, preserving its real appearance (layout, colors, decor, lighting) accurately. Do not invent a different location.`;
    }
  }
  // Mirror đúng 2 câu chỉ dẫn đã thêm cho luồng 1 nhân vật (xem submitSceneImageForRow) — cùng nguyên
  // nhân lỗi (model tự bịa trang phục khác/gương vẽ sai mặt) cũng có thể xảy ra ở luồng nhiều nhân vật.
  scenePrompt += ` Keep the exact same clothing/outfit (garment type, color, style) for each person as shown in their own reference image — do not substitute different clothing, even if the scene's mood or setting might otherwise suggest different attire.`;
  scenePrompt += ` Photorealistic photo, shot on a real camera — not an illustration, painting, drawing, anime, or digital art. Sharp, perfect focus on the subject, commercial-grade production quality.`;
  // Mirror đúng câu chỉ dẫn ánh sáng đã thêm cho luồng 1 nhân vật (xem submitSceneImageForRow).
  scenePrompt += ` Regardless of what kind of lighting the scene describes (sunset, sunrise, night, backlight, inside a cave, a dark room, candlelight, or any other lighting condition), always keep each character's face and key details visible and reasonably well-exposed; if the described lighting would leave a face or important details lost in shadow or unrecognizable, automatically add a very subtle, natural fill light matching the direction, color, intensity, atmosphere, and mood of the existing light, without altering or breaking the original lighting scenario.`;
  scenePrompt += ` If this scene includes a mirror or any other reflective surface, every reflection must show the exact same face and identity as the corresponding real character in the shot — never draw a different-looking face in a reflection.`;
  // Mirror đúng câu chỉ dẫn giữ phụ kiện đã thêm cho luồng 1 nhân vật (xem submitSceneImageForRow).
  scenePrompt += ` Keep any accessories (glasses, jewelry, watch, hat, or similar items) shown on each person in their own reference image — do not remove or omit them in this scene, and do not add new accessories that are not in the reference image, unless the scene description explicitly requires a change.`;
  // Chặn chữ dính từ ảnh tham chiếu — character sheet có nhãn in sẵn ("1) FRONT VIEW", "5) BACK
  // VIEW"...) nên model đôi khi bị dính vụn chữ đó vào ảnh cảnh mới dù không liên quan.
  scenePrompt += ` The output image must contain NO text, letters, numbers, labels, captions, watermarks, or UI overlays anywhere in the frame — completely ignore and do not reproduce any panel numbers or text labels visible in the reference images.`;
  // Skill "scene-image" — admin ghi thêm ghi chú qua /admin (vd luôn ép 1 phong cách ánh sáng riêng).
  const scenePromptOverride = await resolveSkillOverride(job.mini_app_id, "scene_image_prompt");
  if (scenePromptOverride) scenePrompt += ` Ghi chú thêm từ admin: ${scenePromptOverride}`;
  const body = buildImageRequestBody(
    job.image_model as string,
    scenePrompt,
    referenceImages,
    imageEntry?.multi_image ?? false,
    job.aspect_ratio ?? "9:16",
    job.image_resolution_key ?? undefined,
    hasLocationMask ? (job.location_reference_mask_url as string) : undefined
  );
  return submitFalJob(
    job.image_model as string,
    body,
    `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&sceneId=${row.id}&stage=${stage}${regen ? "&regen=1" : ""}${
      propagateToSceneId ? `&propagateToSceneId=${propagateToSceneId}` : ""
    }`
  );
}

// Thể loại — mỗi key ứng với 1 đoạn hướng dẫn phong cách CỐ ĐỊNH, viết sẵn 1 lần, nối THÊM vào cuối
// system prompt Agent chia cảnh (đúng cơ chế customInstructions/prompt_helper_instructions đã có sẵn)
// — không phải Agent "hiểu" khái niệm thể loại, chỉ là tra bảng lấy đúng đoạn text rồi nối vào prompt.
// "default"/không có key -> không nối gì thêm.
export const STORY_GENRE_KEYS = ["romance", "comedy", "horror", "scifi", "slice_of_life", "mystery"] as const;
export type StoryGenreKey = (typeof STORY_GENRE_KEYS)[number];
// export để admin/mini-apps route dùng làm bản mặc định khi ghép với genre_style_guides admin đã sửa
// (GET trả về bản merge default+override, PATCH chỉ lưu đúng override admin gửi lên).
export const GENRE_STYLE_GUIDES: Record<StoryGenreKey, string> = {
  romance:
    "Phong cách hình ảnh thể loại Tình cảm: ánh sáng ấm (hoàng hôn, đèn vàng, nắng sớm), tông màu ấm/pastel, ưu tiên khoảnh khắc gần gũi và biểu cảm dịu dàng, bối cảnh lãng mạn (quán cà phê, công viên, ban công).",
  comedy:
    "Phong cách hình ảnh thể loại Hài hước: ánh sáng tươi sáng rực rỡ, màu sắc sống động, biểu cảm/tư thế có thể hơi phóng đại tự nhiên (không gượng ép), không khí vui tươi, năng động.",
  horror:
    "Phong cách hình ảnh thể loại Kinh dị: ánh sáng tối, tương phản mạnh, bóng đổ dài, tông màu lạnh/xám xanh, không khí căng thẳng bất an, có thể dùng khung hình hẹp hoặc góc khuất tạo cảm giác bị theo dõi.",
  scifi:
    "Phong cách hình ảnh thể loại Khoa học viễn tưởng: ánh sáng neon/xanh lam, bối cảnh công nghệ cao hoặc tương lai, tông màu lạnh kim loại, chi tiết môi trường gợi cảm giác hiện đại/tương lai.",
  slice_of_life:
    "Phong cách hình ảnh thể loại Đời thường: ánh sáng tự nhiên, tông màu trung tính ấm áp, không khí chân thực gần gũi, tránh dàn dựng quá kịch tính, tập trung vào khoảnh khắc sinh hoạt bình dị.",
  mystery:
    "Phong cách hình ảnh thể loại Bí ẩn: ánh sáng mờ ảo hoặc tương phản cao, có thể có sương mù/bóng tối một phần che khuất, tông màu trầm, bố cục gợi tò mò thay vì phơi bày rõ ràng.",
};

function resolveGenreStyleGuide(genreKey: string | null | undefined, overrides?: Record<string, string> | null): string | undefined {
  if (!genreKey) return undefined;
  const override = overrides?.[genreKey]?.trim();
  if (override) return override;
  return (GENRE_STYLE_GUIDES as Record<string, string>)[genreKey];
}

// Trừ credit phần ảnh (+ video nếu auto_video) rồi chạy chia cảnh (LLM) + submit ảnh cho từng cảnh,
// dùng character_sheet_url làm tham chiếu chung — tách riêng để dùng chung cho 2 nơi gọi: (1)
// continueStoryVideoToSceneStage (khách bấm "Tiếp tục chia cảnh" sau khi duyệt Character mới tạo),
// (2) submitStoryVideoJob khi Character đã chắc chắn 100% ngay từ đầu (chọn từ thư viện, hoặc TOÀN BỘ
// ảnh tải lên đã là sheet sẵn) — bỏ qua hẳn màn xem trước, chạy thẳng 1 lượt nếu đã có Ý tưởng truyện.
async function runSceneStage(
  userId: string,
  job: SceneStageInput,
  finalStoryDescription: string,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  // Bước "Tạo kịch bản" (xem plan-script/route.ts) — khi khách đã xác nhận danh sách hành động trên
  // màn hình, gửi lại ĐÚNG mảng "actions" đó (không có giá) để nối vào luồng thật. Không tin bất kỳ
  // giá/duration_key nào client gửi kèm — luôn tự chạy lại planStoryVideoScenes() (hàm thuần, không
  // gọi LLM, cùng input luôn ra cùng kết quả) để tính lại đúng giá đã hiện cho khách lúc xem trước.
  preplannedActions?: ScriptSceneResult[]
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");
  if (!job.image_provider_cost_vnd_per_scene || !job.video_provider_cost_vnd_per_scene) {
    throw new Error("Thiếu dữ liệu giá của job");
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();

  // Mỗi cảnh từ bước kịch bản có thể có duration_key khác nhau (nhóm hành động khác tổng giây) — giá
  // video không còn là 1 mức phẳng nhân đều số cảnh, phải dùng đúng tổng giá thật planStoryVideoScenes
  // đã tính (xem comment tham số preplannedActions ở trên).
  let plannedScenes: PlannedScene[] | undefined;
  let videoCost: number;
  if (preplannedActions) {
    const miniAppForPlan = await getMiniAppModelConfig(job.mini_app_id);
    const videoEntryForPlan = miniAppForPlan.model_config.video_models.find((m) => m.model === job.video_model);
    if (!videoEntryForPlan) throw new Error("Không tìm thấy model video của job");
    const plan = planStoryVideoScenes(preplannedActions, videoEntryForPlan, undefined);
    plannedScenes = plan.scenes;
    videoCost = computeDynamicCreditCost(plan.totalVideoProviderCostVnd, marginPercent, vndPerCredit);
  } else {
    videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);
  }

  // Chuỗi liên tục: N+1 ảnh cho N cảnh (không phải 2N) — xem resolveCosts(). Số cảnh dùng để tính ảnh
  // phải lấy theo plannedScenes.length (số cảnh THẬT SỰ sẽ tạo ảnh, sau khi planStoryVideoScenes() đã
  // tự động gộp hành động liền kề) — không phải job.num_scenes (số hành động GỐC trước gộp, luôn ghi
  // vào job lúc submit qua preplannedActions.length), nếu không khách sẽ bị trừ credit ảnh nhiều hơn số
  // ảnh thật sự tạo ra.
  const effectiveSceneCount = plannedScenes ? plannedScenes.length : job.num_scenes;
  const imageCallCount = job.continuous_motion ? effectiveSceneCount + 1 : effectiveSceneCount;
  const imageCost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene * imageCallCount, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, job.auto_video ? imageCost + videoCost : imageCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  await supabase
    .from("story_video_jobs")
    .update({ status: "splitting_story", image_credit_tx_id: deduction.txId, story_description: finalStoryDescription })
    .eq("id", job.id);

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    const combinedInstructions = [
      miniApp.model_config.prompt_helper_instructions,
      resolveGenreStyleGuide(job.genre_key, miniApp.model_config.genre_style_guides),
    ]
      .filter((s): s is string => !!s?.trim())
      .join("\n\n");

    let scenes: SceneSplitResult[];
    if (plannedScenes) {
      scenes = plannedScenes;
    } else {
      // Skill "story-extractor" — chỉ dùng làm input nội bộ cho chia cảnh, không ghi đè
      // story_description đã lưu ở trên (khách vẫn thấy đúng nguyên văn mình gõ).
      const extractedStory = await extractStoryEssentials(finalStoryDescription, job.mini_app_id, modelChatKey);
      scenes = await splitStoryIntoScenes(
        extractedStory,
        job.num_scenes,
        combinedInstructions || undefined,
        modelChatKey,
        job.continuous_motion,
        job.frame_chain_mode,
        miniApp.model_config.allow_scene_padding
      );
      // Skill "story-validator" — kiểm tra bản chia cảnh có phản ánh đúng truyện gốc không, thử chia
      // lại ĐÚNG 1 lần nếu lỗi, không chặn cứng job nếu vẫn lỗi sau lần 2 (tránh false-positive chặn oan).
      const validation = await validateSceneSplit(finalStoryDescription, scenes, job.mini_app_id, modelChatKey);
      if (!validation.ok) {
        console.error(`[story-video] story-validator báo lỗi job #${job.id}, thử chia lại 1 lần: ${validation.issue}`);
        const retryInstructions = [combinedInstructions, `Lần chia trước bị lỗi: ${validation.issue}. Sửa lại cho đúng.`]
          .filter((s): s is string => !!s?.trim())
          .join("\n\n");
        scenes = await splitStoryIntoScenes(
          extractedStory,
          job.num_scenes,
          retryInstructions,
          modelChatKey,
          job.continuous_motion,
          job.frame_chain_mode,
          miniApp.model_config.allow_scene_padding
        );
      }
    }

    const { data: sceneRows, error: sceneError } = await supabase
      .from("story_video_scenes")
      .insert(
        scenes.map((scene, index) => ({
          job_id: job.id,
          position: index,
          scene_description: scene.description,
          end_description: scene.end_description ?? null,
          camera_view: scene.camera_view,
          shot_size: scene.shot_size,
          camera_angle: scene.camera_angle,
          camera_movement: scene.camera_movement,
          outfit_override: scene.outfit_override ?? null,
          face_view: scene.face_view ?? null,
          dialogue_line: scene.dialogue?.trim() || null,
          location: scene.location,
          end_pose: scene.end_pose,
          motion_duration_key: plannedScenes ? plannedScenes[index].duration_key : null,
          natural_duration_seconds: plannedScenes ? plannedScenes[index].duration_seconds : null,
          pace: plannedScenes ? plannedScenes[index].pace ?? null : null,
          rotation_degrees: plannedScenes ? plannedScenes[index].rotation_degrees ?? null : null,
        }))
      )
      .select("id, position, scene_description, camera_view, shot_size, camera_angle, camera_movement, outfit_override, face_view, location");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    if (job.frame_chain_mode) {
      // Frame-chaining (dẫn trạng thái qua khung hình THẬT) — chỉ tạo ảnh cho cảnh đầu tiên ngay bây
      // giờ. Các cảnh sau tạo TUẦN TỰ, mỗi ảnh dựa vào khung hình cuối THẬT trích từ video cảnh liền
      // trước (xem applyFrameChainVideoResult) — không thể tạo trước vì video cảnh trước chưa tồn tại.
      const firstRow = sceneRows.find((r) => r.position === 0);
      if (firstRow) {
        // Bỏ qua AI vẽ ảnh riêng cho cảnh 1 nếu đủ điều kiện, dùng thẳng ảnh góc "front" sạch từ bước
        // tạo Character — xác nhận thật qua test trực tiếp gọi Fal.ai (anh phát hiện + kiểm chứng lại
        // bằng job thật): H3 Max không khoá cứng bối cảnh của ảnh đầu vào, mà ưu tiên PROMPT để đặt nhân
        // vật vào bối cảnh mới — dùng ảnh gốc không hề làm video bị kẹt ở nền studio như lo ngại ban đầu,
        // ngược lại còn giữ mặt ổn định hơn hẳn so với ảnh đã qua AI vẽ lại. Điều kiện đầy đủ + lý do mở
        // rộng sang MỌI cảnh (không riêng cảnh 1): xem resolveCharacterPhotoDirectlyUrl().
        const directPhotoUrl = resolveCharacterPhotoDirectlyUrl(job, firstRow);
        if (directPhotoUrl) {
          await supabase.from("story_video_scenes").update({ image_url: directPhotoUrl }).eq("id", firstRow.id);
          await applyFrameChainImageResult(job.id, firstRow.id);
        } else {
          const requestId = await submitSceneImageForRow(job, firstRow, imageEntry, false, "image");
          await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", firstRow.id);
        }
      }
    } else if (job.continuous_motion) {
      // Chuỗi N+1 ảnh: ảnh ĐẦU của cảnh 1 (1 lượt) + ảnh CUỐI của MỌI cảnh (N lượt) — gửi SONG SONG
      // (không lượt nào phụ thuộc lượt khác, vì cả 2 loại ảnh đều chỉ dựa vào ảnh tham chiếu Character,
      // không dựa vào ảnh cảnh khác). Việc "nối chuỗi" (ảnh cuối cảnh N -> ảnh đầu cảnh N+1) xảy ra
      // trong applyImageStageResult() khi webhook ảnh cuối trả về, không phải ở đây.
      const sortedRows = [...sceneRows].sort((a, b) => a.position - b.position);
      const firstRow = sortedRows[0];
      await Promise.all([
        (async () => {
          const requestId = await submitSceneImageForRow(job, firstRow, imageEntry, false, "image");
          await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", firstRow.id);
        })(),
        ...sortedRows.map(async (row) => {
          const scene = scenes[row.position];
          const endRow = { ...row, scene_description: scene.end_description ?? scene.description };
          const requestId = await submitSceneImageForRow(job, endRow, imageEntry, false, "image_end");
          await supabase.from("story_video_scenes").update({ end_image_fal_request_id: requestId }).eq("id", row.id);
        }),
      ]);
    } else {
      // Scene State: cảnh N (N>0) được tiêm thêm end_pose của cảnh N-1 (lấy từ mảng "scenes" trong bộ
      // nhớ, đã có sẵn TRƯỚC khi insert — cùng thứ tự "position" nên scenes[row.position - 1] đúng là
      // cảnh liền trước). Chỉ áp dụng nhánh này — continuousMotion đã có cơ chế nối ẢNH riêng mạnh hơn.
      await Promise.all(
        sceneRows.map(async (row) => {
          const previousEndPose = row.position > 0 ? scenes[row.position - 1]?.end_pose : undefined;
          const requestId = await submitSceneImageForRow(job, row, imageEntry, false, "image", previousEndPose);
          await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", row.id);
        })
      );
    }

    await supabase.from("story_video_jobs").update({ status: "generating_images" }).eq("id", job.id);
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Bước 1: nhận request khách bấm "Chạy ngay" -> xử lý Character (chọn từ thư viện / phân loại ảnh đã
// là sheet / tạo mới qua GPT Image 2). Nếu Character đã chắc chắn 100% (chọn từ thư viện, hoặc TOÀN
// BỘ ảnh tải lên đã là sheet sẵn — không ảnh thường nào lẫn vào) VÀ khách đã gõ sẵn Ý tưởng truyện,
// chạy thẳng luôn sang chia cảnh + tạo ảnh trong 1 lượt (runSceneStage), không dừng ở màn xem trước
// Character nữa — vì không có gì cần khách duyệt (Character này không phải AI vừa tạo mới). Nếu vẫn
// còn phải tạo Character mới, hoặc Ý tưởng truyện chưa có, giữ nguyên hành vi cũ: dừng ở
// "character_ready" chờ khách xem/duyệt rồi bấm "Tiếp tục chia cảnh" (continueStoryVideoToSceneStage).
export async function submitStoryVideoJob(
  userId: string,
  miniAppId: string,
  storyDescription: string,
  numScenes: number,
  characterImageUrls: string[],
  imageModelKey: string | undefined,
  videoModelKey: string | undefined,
  autoVideo: boolean,
  aspectRatio: string,
  resolutionKey: string | undefined,
  durationKey: string | undefined,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  reuseCharacterId?: number,
  skipCharacterCreation?: boolean,
  genreKey?: string,
  characters?: MultiCharacterInput[],
  locationReferenceUrl?: string,
  // Vị trí đứng chính xác (mask) — chỉ có tác dụng khi có locationReferenceUrl VÀ model ảnh đang chọn
  // hỗ trợ mask_url (xem buildImageRequestBody). Khách khoanh vùng ở frontend, tự sinh ảnh mask cùng
  // kích thước ảnh Bối cảnh gốc rồi tải lên, gửi URL đó vào đây.
  locationReferenceMaskUrl?: string,
  // Nhiều nhân vật, nhiều vị trí trong CÙNG 1 ảnh Bối cảnh — chỉ có ý nghĩa khi rẽ sang nhánh nhiều
  // nhân vật bên dưới (characters.length>=2); nhánh 1 nhân vật bỏ qua (không cần, chỉ 1 vị trí duy
  // nhất, dùng đúng locationReferenceMaskUrl như hiện có). Xem JobRow.location_reference_mask_zones.
  locationReferenceMaskZones?: LocationMaskZone[],
  continuousMotion?: boolean,
  // Frame-chaining (chỉ luồng 1 nhân vật ở v1, xem applyFrameChainVideoResult) — bỏ qua hoàn toàn nếu
  // job rơi vào nhánh nhiều nhân vật bên dưới.
  frameChainMode?: boolean,
  // Ảnh Vật phẩm riêng (tuỳ chọn, tối đa MAX_ITEM_REFERENCES) của nhân vật #1 — chỉ dùng ở nhánh 1
  // nhân vật bên dưới. Nhánh nhiều nhân vật KHÔNG đọc tham số này — mỗi nhân vật (kể cả #1) tự có
  // itemReferenceUrls riêng trong mảng "characters" (xem MultiCharacterInput), truyền thẳng vào
  // submitMultiCharacterStoryVideoJob.
  itemReferenceUrls?: string[],
  // Bước "Tạo kịch bản" (xem runSceneStage) — CHỈ áp dụng nhánh 1 nhân vật, AI tự vẽ ảnh bên dưới. Khi
  // có, số cảnh THẬT SỰ dùng luôn lấy từ preplannedActions.length (bỏ qua numScenes client gửi lên cho
  // đúng nhánh này) — Agent đã tự quyết định số cảnh lúc lập kịch bản, không phải khách tự chọn.
  preplannedActions?: ScriptSceneResult[],
  // Bước "Tạo kịch bản" bản NHIỀU NHÂN VẬT (xem runMultiCharacterSceneStage) — mirror preplannedActions
  // ở trên nhưng cho nhánh characters.length>=2. Tách riêng tham số vì 2 nhánh dùng 2 kiểu dữ liệu khác
  // nhau (ScriptSceneResult vs ScriptSceneResultMulti, có thêm "characters" per action).
  preplannedActionsMulti?: ScriptSceneResultMulti[],
  // Chế độ "Mô tả bằng chữ" — CHỈ áp dụng nhánh 1 nhân vật (characters rỗng/1 phần tử), khách không có
  // ảnh thật, để AI tự bịa hẳn nhân vật từ mô tả này (xem CHARACTER_TEXT_TO_IMAGE_MODEL bên dưới). Khi
  // có giá trị, bỏ qua hoàn toàn yêu cầu characterImageUrls.length >= MIN_CHARACTER_IMAGES.
  characterAppearanceDescription?: string
): Promise<{ jobId: number; newBalance: number }> {
  const resolvedNumScenes = preplannedActions ? preplannedActions.length : numScenes;
  if (resolvedNumScenes < MIN_SCENES || resolvedNumScenes > MAX_SCENES) {
    throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
  }
  // Whitelist qua tra bảng GENRE_STYLE_GUIDES — key lạ/không hợp lệ thì coi như không chọn thể loại
  // (an toàn hơn validate chặn cứng, giữ app luôn chạy được).
  const resolvedGenreKey = genreKey && resolveGenreStyleGuide(genreKey) ? genreKey : null;

  // Nhánh nhiều nhân vật (>=2) — hoàn toàn tách riêng khỏi luồng 1 nhân vật bên dưới, không đụng gì
  // tới nó. Đúng 1 nhân vật (mặc định, kể cả khi khách truyền characters=[1 phần tử]) vẫn rơi xuống
  // chạy nguyên luồng cũ phía dưới, không có rủi ro regression.
  if (characters && characters.length >= 2) {
    if (characters.length > MAX_STORY_CHARACTERS) throw new Error(`Tối đa ${MAX_STORY_CHARACTERS} nhân vật`);
    if (preplannedActionsMulti && (preplannedActionsMulti.length < MIN_SCENES || preplannedActionsMulti.length > MAX_SCENES)) {
      throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
    }
    return submitMultiCharacterStoryVideoJob(
      userId,
      miniAppId,
      storyDescription,
      numScenes,
      characters,
      imageModelKey,
      videoModelKey,
      autoVideo,
      aspectRatio,
      resolutionKey,
      durationKey,
      idempotencyKey,
      resolvedGenreKey,
      locationReferenceUrl,
      locationReferenceMaskUrl,
      locationReferenceMaskZones,
      continuousMotion,
      frameChainMode,
      preplannedActionsMulti
    );
  }

  const supabase = getSupabaseAdmin();

  // Chọn từ thư viện đã lưu -> biết chắc 100% đây là Character chuẩn (chính hệ thống tạo ra trước
  // đó), bỏ qua hoàn toàn bước validate/phân loại ảnh tải lên mới.
  let reusedImageUrl: string | null = null;
  let reusedAngleUrls: CharacterAngleUrls | null = null;
  if (reuseCharacterId) {
    const { data: saved } = await supabase
      .from("story_characters")
      .select("id, user_id, image_url, angle_urls")
      .eq("id", reuseCharacterId)
      .single();
    if (!saved || saved.user_id !== userId) throw new Error("Không tìm thấy Character đã lưu");
    reusedImageUrl = saved.image_url;
    reusedAngleUrls = (saved.angle_urls as CharacterAngleUrls | null) ?? null;
  } else if (characterAppearanceDescription?.trim()) {
    // Chế độ "Mô tả bằng chữ" — không cần ảnh, bỏ qua hẳn yêu cầu MIN_CHARACTER_IMAGES.
  } else if (characterImageUrls.length < MIN_CHARACTER_IMAGES || characterImageUrls.length > MAX_CHARACTER_IMAGES) {
    throw new Error(`Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật`);
  }

  const { imageEntry, videoEntry, imageProviderCostVnd, videoProviderCostVnd, resolvedResolutionKey, resolvedDurationKey } =
    await resolveCosts(miniAppId, resolvedNumScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "pending",
      story_description: storyDescription,
      num_scenes: resolvedNumScenes,
      character_image_urls: characterImageUrls,
      character_appearance_description: characterAppearanceDescription?.trim() || null,
      image_model: imageEntry.model,
      video_model: videoEntry.model,
      auto_video: autoVideo,
      aspect_ratio: aspectRatio,
      image_resolution_key: resolvedResolutionKey ?? null,
      // Bước "Tạo kịch bản": mỗi cảnh tự khoá duration_key riêng (xem runSceneStage), giá trị phẳng
      // này không còn ý nghĩa cho nhánh đó -- để null tránh hiểu nhầm là mức đang thật sự dùng.
      video_duration_key: preplannedActions ? null : (resolvedDurationKey ?? null),
      image_provider_cost_vnd_per_scene: imageProviderCostVnd,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
      genre_key: resolvedGenreKey,
      location_reference_url: locationReferenceUrl ?? null,
      location_reference_mask_url: locationReferenceMaskUrl ?? null,
      item_reference_urls: normalizeItemReferenceUrls(itemReferenceUrls),
      continuous_motion: continuousMotion === true,
      frame_chain_mode: frameChainMode === true,
      // Lưu lại để continueStoryVideoToSceneStage (chạy sau, khi Character phải tạo mới qua webhook)
      // vẫn dùng đúng kịch bản đã xác nhận/hiện giá cho khách, không chia cảnh lại bằng LLM cũ.
      preplanned_actions: preplannedActions ?? null,
    })
    .select("id")
    .single();

  if (insertError || !job) throw new Error(insertError?.message ?? "Không tạo được job");

  const finalStoryDescription = storyDescription.trim();
  const sceneStageJob: SceneStageInput = {
    id: job.id,
    mini_app_id: miniAppId,
    auto_video: autoVideo,
    image_provider_cost_vnd_per_scene: imageProviderCostVnd,
    video_provider_cost_vnd_per_scene: videoProviderCostVnd,
    num_scenes: resolvedNumScenes,
    image_model: imageEntry.model,
    video_model: videoEntry.model,
    aspect_ratio: aspectRatio,
    image_resolution_key: resolvedResolutionKey ?? null,
    character_sheet_url: null,
    character_angle_urls: null,
    genre_key: resolvedGenreKey,
    location_reference_url: locationReferenceUrl ?? null,
    location_reference_mask_url: locationReferenceMaskUrl ?? null,
    item_reference_urls: normalizeItemReferenceUrls(itemReferenceUrls),
    continuous_motion: continuousMotion === true,
    frame_chain_mode: frameChainMode === true,
  };

  let characterTxId: number | null = null;
  try {
    if (reusedImageUrl) {
      await supabase
        .from("story_video_jobs")
        .update({
          status: "character_ready",
          character_sheet_url: reusedImageUrl,
          character_source: "reused",
          character_angle_urls: reusedAngleUrls,
        })
        .eq("id", job.id);
      if (finalStoryDescription) {
        sceneStageJob.character_sheet_url = reusedImageUrl;
        sceneStageJob.character_angle_urls = reusedAngleUrls;
        return {
          jobId: job.id,
          ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey, preplannedActions)),
        };
      }
    } else if (characterAppearanceDescription?.trim()) {
      // Chế độ "Mô tả bằng chữ" — không có ảnh thật, dùng bản TEXT-TO-IMAGE thuần của GPT Image 2
      // (CHARACTER_TEXT_TO_IMAGE_MODEL, không có "/edit") thay vì bản edit dùng cho ảnh thật. Cùng bố
      // cục 6 ô 3x2 như CHARACTER_SHEET_PROMPT nên applyCharacterStageResult()/cropCharacterSheetIntoAngles()
      // phía dưới chạy y hệt, không cần sửa gì thêm.
      const { creditCost } = await computeCharacterCreditCost();
      const deduction = await deductCredit(userId, creditCost, miniAppId, idempotencyKey);
      if (!deduction.success) throw new InsufficientCreditError();
      characterTxId = deduction.txId ?? null;

      const body = {
        prompt: buildCharacterSheetTextPrompt(characterAppearanceDescription.trim()),
        image_size: "landscape_4_3",
        quality: "high",
      };
      const requestId = await submitFalJob(
        CHARACTER_TEXT_TO_IMAGE_MODEL,
        body,
        `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&stage=character`
      );
      await supabase
        .from("story_video_jobs")
        .update({
          status: "generating_character",
          character_source: "text_described",
          character_credit_tx_id: characterTxId,
          character_fal_request_id: requestId,
        })
        .eq("id", job.id);
    } else {
      // Khách chủ động tick "Bỏ qua tạo Character" — dùng thẳng ảnh đầu tiên đã tải làm tham chiếu
      // duy nhất cho mọi cảnh sau này, bỏ qua hẳn bước phân loại + tạo sheet mới (tiết kiệm credit,
      // nhưng chỉ có đúng 1 góc ảnh nên các cảnh cần góc khác dễ kém đồng nhất hơn — đã cảnh báo
      // khách ở giao diện trước khi tick).
      const skipEntirely = skipCharacterCreation === true;
      // Kiểm tra TOÀN BỘ ảnh tải lên (không chỉ ảnh đầu) — chỉ dùng thẳng khi TẤT CẢ đều đã là sheet
      // sẵn (rõ ràng không cần tạo mới). Nếu có lẫn dù chỉ 1 ảnh thường: luôn tạo Character mới dùng
      // TOÀN BỘ ảnh làm tư liệu — tránh bỏ sót ảnh thường khách muốn AI tham chiếu thêm.
      const allAreSheets = skipEntirely ? true : await classifyAllAreSheets(characterImageUrls);
      if (allAreSheets) {
        const sheetUrl = characterImageUrls[0];
        // Thử cắt góc luôn cho sheet khách tự tải lên (uploaded_sheet — ĐÃ được AI phân loại xác nhận
        // đúng là sheet hợp lệ qua classifyAllAreSheets, khác "skipped" bên dưới nơi ảnh có thể chỉ là 1
        // ảnh thường bất kỳ, không đảm bảo bố cục 3x2). Trước đây luôn bỏ qua bước cắt cho uploaded_sheet
        // vì lo sheet khách không đúng bố cục 3 cột x 2 hàng — xác nhận thật qua job #153/#154 (anh tự
        // cắt thử panel "front" của đúng sheet khách tải lên, dùng thẳng cho video vẫn giữ mặt tốt, đúng
        // bố cục chuẩn): rủi ro này thấp hơn tưởng — cắt sai thì lưới an toàn danh tính đã có
        // (checkFrameChainIdentity/checkFinalSceneVideoIdentity) tự phát hiện lệch mặt và sửa lại.
        const angleUrls = skipEntirely ? null : await cropCharacterSheetIntoAngles(sheetUrl, userId);
        await supabase
          .from("story_video_jobs")
          .update({
            status: "character_ready",
            character_sheet_url: sheetUrl,
            character_source: skipEntirely ? "skipped" : "uploaded_sheet",
            character_angle_urls: angleUrls,
          })
          .eq("id", job.id);
        if (finalStoryDescription) {
          sceneStageJob.character_sheet_url = sheetUrl;
          sceneStageJob.character_angle_urls = angleUrls;
          return {
          jobId: job.id,
          ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey, preplannedActions)),
        };
        }
      } else {
        const { creditCost } = await computeCharacterCreditCost();
        const deduction = await deductCredit(userId, creditCost, miniAppId, idempotencyKey);
        if (!deduction.success) throw new InsufficientCreditError();
        characterTxId = deduction.txId ?? null;

        const characterPrompt = await resolveCharacterPrompt(miniAppId);
        const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, characterImageUrls, true, "1:1", undefined);
        const requestId = await submitFalJob(
          CHARACTER_SHEET_MODEL,
          body,
          `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&stage=character`
        );
        await supabase
          .from("story_video_jobs")
          .update({
            status: "generating_character",
            character_source: "generated",
            character_credit_tx_id: characterTxId,
            character_fal_request_id: requestId,
          })
          .eq("id", job.id);
      }
    }
  } catch (err) {
    await supabase
      .from("story_video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (characterTxId) await refundCredit(characterTxId);
    throw err;
  }

  return { jobId: job.id, newBalance: await getCreditBalance(userId) };
}

type ResolvedMultiCharacter = {
  label: string;
  imageUrls: string[];
  reuseCharacterId?: number;
  needsGeneration: boolean;
  initialSheetUrl: string | null;
  initialAngleUrls: CharacterAngleUrls | null;
  characterSource: "reused" | "uploaded_sheet" | "skipped" | "generated" | "text_described";
  itemReferenceUrls: string[] | null;
  // Chế độ "Mô tả bằng chữ" cho ĐÚNG nhân vật này — không có ảnh, dùng CHARACTER_TEXT_TO_IMAGE_MODEL
  // thay vì CHARACTER_SHEET_MODEL (xem nhánh generate bên dưới).
  appearanceDescription: string | null;
};

// Nhánh "nhiều nhân vật cùng khung hình" (Bước 1) — chỉ dừng ở "character_ready" khi xong, KHÔNG tự
// chạy tiếp sang chia cảnh dù Character đã chắc chắn 100% (khác luồng 1 nhân vật) vì bước chia cảnh
// nhiều nhân vật (Agent gán characters[] theo cảnh + Reference Selector nhiều ảnh) là hạng mục riêng
// (Bước 2), chưa xây ở đây.
async function submitMultiCharacterStoryVideoJob(
  userId: string,
  miniAppId: string,
  storyDescription: string,
  numScenes: number,
  characters: MultiCharacterInput[],
  imageModelKey: string | undefined,
  videoModelKey: string | undefined,
  autoVideo: boolean,
  aspectRatio: string,
  resolutionKey: string | undefined,
  durationKey: string | undefined,
  idempotencyKey: string,
  resolvedGenreKey: string | null,
  locationReferenceUrl?: string,
  // Mirror đúng tham số cùng tên của submitStoryVideoJob (luồng 1 nhân vật) — xem submitStoryVideoJob.
  locationReferenceMaskUrl?: string,
  locationReferenceMaskZones?: LocationMaskZone[],
  continuousMotion?: boolean,
  // Frame-chaining (dẫn trạng thái qua khung hình THẬT) — mirror đúng tham số cùng tên của
  // submitStoryVideoJob (luồng 1 nhân vật). applyFrameChainImageResult/applyFrameChainVideoResult ở
  // tầng dưới đã hoàn toàn generic theo scene/job (không phân biệt số nhân vật) nên không cần sửa gì
  // thêm ngoài việc set cột này + nhánh submit ảnh tuần tự trong runMultiCharacterSceneStage.
  frameChainMode?: boolean,
  // Bước "Tạo kịch bản" (xem runMultiCharacterSceneStage) — khi có, số cảnh THẬT SỰ dùng lấy từ
  // preplannedActions.length (bỏ qua numScenes client gửi) — mirror đúng resolvedNumScenes của
  // submitStoryVideoJob (luồng 1 nhân vật). CHỈ áp dụng khi KHÔNG continuousMotion (giống luồng 1
  // nhân vật, xem storyUsesScriptFlow ở frontend).
  preplannedActions?: ScriptSceneResultMulti[]
): Promise<{ jobId: number; newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const resolvedNumScenes = preplannedActions ? preplannedActions.length : numScenes;

  const { imageEntry, videoEntry, imageProviderCostVnd, videoProviderCostVnd, resolvedResolutionKey, resolvedDurationKey } =
    await resolveCosts(miniAppId, resolvedNumScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);
  // Đã kiểm chứng qua test thật: chỉ model hỗ trợ nhiều ảnh tham chiếu (multi_image) mới ghép được
  // nhiều người thật vào 1 cảnh — model như Flux Kontext chỉ nhận 1 ảnh nên chặn sớm ở đây, không để
  // khách tốn credit rồi mới thấy ảnh sai.
  if (!imageEntry.multi_image) {
    throw new Error("Model ảnh đã chọn không hỗ trợ nhiều nhân vật — vui lòng chọn model có nhiều ảnh tham chiếu (vd Nano Banana Pro Edit, GPT Image 2 Edit)");
  }

  // Resolve từng nhân vật trước (reuse thư viện / đã là sheet sẵn / cần AI tạo mới) để biết chính xác
  // cần trừ credit cho bao nhiêu người — chỉ người THẬT SỰ cần gọi model mới tính phí.
  const resolved: ResolvedMultiCharacter[] = await Promise.all(
    characters.map(async (c, index): Promise<ResolvedMultiCharacter> => {
      const label = c.label?.trim() || `Nhân vật ${index + 1}`;
      if (c.reuseCharacterId) {
        const { data: saved } = await supabase
          .from("story_characters")
          .select("id, user_id, image_url, angle_urls")
          .eq("id", c.reuseCharacterId)
          .single();
        if (!saved || saved.user_id !== userId) throw new Error(`Không tìm thấy Character đã lưu cho ${label}`);
        return {
          label,
          imageUrls: [],
          reuseCharacterId: c.reuseCharacterId,
          needsGeneration: false,
          initialSheetUrl: saved.image_url,
          initialAngleUrls: (saved.angle_urls as CharacterAngleUrls | null) ?? null,
          characterSource: "reused",
          itemReferenceUrls: normalizeItemReferenceUrls(c.itemReferenceUrls),
          appearanceDescription: null,
        };
      }
      // Chế độ "Mô tả bằng chữ" cho ĐÚNG nhân vật này — không cần ảnh, mirror nhánh cùng tên ở
      // submitStoryVideoJob (luồng 1 nhân vật).
      const trimmedDescription = c.appearanceDescription?.trim();
      if (trimmedDescription) {
        return {
          label,
          imageUrls: [],
          needsGeneration: true,
          initialSheetUrl: null,
          initialAngleUrls: null,
          characterSource: "text_described",
          itemReferenceUrls: normalizeItemReferenceUrls(c.itemReferenceUrls),
          appearanceDescription: trimmedDescription,
        };
      }
      const imageUrls = c.imageUrls ?? [];
      if (imageUrls.length < MIN_CHARACTER_IMAGES || imageUrls.length > MAX_CHARACTER_IMAGES) {
        throw new Error(`${label} cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh`);
      }
      const skipEntirely = c.skipCharacterCreation === true;
      const allAreSheets = skipEntirely ? true : await classifyAllAreSheets(imageUrls);
      if (allAreSheets) {
        return {
          label,
          imageUrls,
          needsGeneration: false,
          initialSheetUrl: imageUrls[0],
          initialAngleUrls: null,
          characterSource: skipEntirely ? "skipped" : "uploaded_sheet",
          itemReferenceUrls: normalizeItemReferenceUrls(c.itemReferenceUrls),
          appearanceDescription: null,
        };
      }
      return {
        label,
        imageUrls,
        needsGeneration: true,
        initialSheetUrl: null,
        initialAngleUrls: null,
        characterSource: "generated",
        itemReferenceUrls: normalizeItemReferenceUrls(c.itemReferenceUrls),
        appearanceDescription: null,
      };
    })
  );

  const generateCount = resolved.filter((r) => r.needsGeneration).length;
  const { creditCost: totalCharacterCost } = await computeCharacterCreditCost(generateCount);

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: generateCount > 0 ? "generating_character" : "character_ready",
      story_description: storyDescription,
      num_scenes: resolvedNumScenes,
      character_image_urls: [], // job nhiều nhân vật không dùng cột job-level này (xem story_video_job_characters)
      image_model: imageEntry.model,
      video_model: videoEntry.model,
      auto_video: autoVideo,
      aspect_ratio: aspectRatio,
      image_resolution_key: resolvedResolutionKey ?? null,
      video_duration_key: resolvedDurationKey ?? null,
      image_provider_cost_vnd_per_scene: imageProviderCostVnd,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
      genre_key: resolvedGenreKey,
      location_reference_url: locationReferenceUrl ?? null,
      location_reference_mask_url: locationReferenceMaskUrl ?? null,
      location_reference_mask_zones: locationReferenceMaskZones ?? null,
      continuous_motion: continuousMotion === true,
      frame_chain_mode: frameChainMode === true,
      // Lưu lại để continueStoryVideoToSceneStage (chạy sau, khi Character phải tạo mới qua webhook)
      // vẫn dùng đúng kịch bản đã xác nhận/hiện giá cho khách, không chia cảnh lại bằng LLM cũ.
      preplanned_actions: preplannedActions ?? null,
    })
    .select("id")
    .single();
  if (insertError || !job) throw new Error(insertError?.message ?? "Không tạo được job");

  const { data: characterRows, error: charInsertError } = await supabase
    .from("story_video_job_characters")
    .insert(
      resolved.map((r, index) => ({
        job_id: job.id,
        position: index,
        label: r.label,
        source_image_urls: r.imageUrls,
        story_character_id: r.reuseCharacterId ?? null,
        character_sheet_url: r.initialSheetUrl,
        character_angle_urls: r.initialAngleUrls,
        character_source: r.characterSource,
        item_reference_urls: r.itemReferenceUrls,
        appearance_description: r.appearanceDescription,
      }))
    )
    .select("id, position")
    .order("position", { ascending: true });
  if (charInsertError || !characterRows) throw new Error(charInsertError?.message ?? "Không tạo được nhân vật");

  let characterTxId: number | null = null;
  try {
    if (generateCount > 0) {
      const deduction = await deductCredit(userId, totalCharacterCost, miniAppId, idempotencyKey);
      if (!deduction.success) throw new InsufficientCreditError();
      characterTxId = deduction.txId ?? null;

      const characterPrompt = await resolveCharacterPrompt(miniAppId);
      await Promise.all(
        characterRows.map(async (row) => {
          const r = resolved[row.position];
          if (!r.needsGeneration) return;
          // Chế độ "Mô tả bằng chữ" cho ĐÚNG người này — dùng CHARACTER_TEXT_TO_IMAGE_MODEL (text-to-image
          // thuần) thay vì CHARACTER_SHEET_MODEL (edit, cần ảnh thật). Mirror nhánh cùng tên ở
          // submitStoryVideoJob (luồng 1 nhân vật).
          const requestId = r.appearanceDescription
            ? await submitFalJob(
                CHARACTER_TEXT_TO_IMAGE_MODEL,
                { prompt: buildCharacterSheetTextPrompt(r.appearanceDescription), image_size: "landscape_4_3", quality: "high" },
                `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&stage=character&characterPosition=${row.position}`
              )
            : await submitFalJob(
                CHARACTER_SHEET_MODEL,
                buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, r.imageUrls, true, "1:1", undefined),
                `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&stage=character&characterPosition=${row.position}`
              );
          await supabase.from("story_video_job_characters").update({ character_fal_request_id: requestId }).eq("id", row.id);
        })
      );
      if (characterTxId) await supabase.from("story_video_jobs").update({ character_credit_tx_id: characterTxId }).eq("id", job.id);
    }
  } catch (err) {
    await supabase
      .from("story_video_jobs")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", job.id);
    if (characterTxId) await refundCredit(characterTxId);
    throw err;
  }

  return { jobId: job.id, newBalance: await getCreditBalance(userId) };
}

// Nhánh nhiều nhân vật (Bước 2) của runSceneStage — cùng khuôn trừ credit/đổi status/failJob như bản 1
// nhân vật, chỉ khác bước chia cảnh (splitStoryIntoScenesMulti thay vì splitStoryIntoScenes) và bước
// tạo ảnh (submitMultiCharacterSceneImageForRow thay vì submitSceneImageForRow).
async function runMultiCharacterSceneStage(
  userId: string,
  job: JobRow,
  jobCharacters: JobCharacterRefRow[],
  finalStoryDescription: string,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  // Bước "Tạo kịch bản" bản nhiều nhân vật (xem generateStoryScriptMulti/plan-script route) — mirror
  // đúng tham số cùng tên của runSceneStage (luồng 1 nhân vật): khi có, bỏ qua hẳn
  // extractStoryEssentials/splitStoryIntoScenesMulti/validateSceneSplit, tự chạy lại
  // planStoryVideoScenesMulti() (hàm thuần, không LLM) để tính đúng giá đã hiện cho khách. Chỉ áp dụng
  // khi KHÔNG continuous_motion (giống luồng 1 nhân vật) — frontend đã loại trừ tổ hợp này.
  preplannedActions?: ScriptSceneResultMulti[]
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  if (!job.image_provider_cost_vnd_per_scene || !job.video_provider_cost_vnd_per_scene) {
    throw new Error("Thiếu dữ liệu giá của job");
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();

  // Mỗi cảnh từ bước kịch bản có thể có duration_key khác nhau — giá video không còn 1 mức phẳng nhân
  // đều số cảnh, phải dùng đúng tổng giá thật planStoryVideoScenesMulti đã tính (mirror runSceneStage).
  let plannedScenes: PlannedSceneMulti[] | undefined;
  let videoCost: number;
  if (preplannedActions) {
    const miniAppForPlan = await getMiniAppModelConfig(job.mini_app_id);
    const videoEntryForPlan = miniAppForPlan.model_config.video_models.find((m) => m.model === job.video_model);
    if (!videoEntryForPlan) throw new Error("Không tìm thấy model video của job");
    const plan = planStoryVideoScenesMulti(preplannedActions, videoEntryForPlan);
    plannedScenes = plan.scenes;
    videoCost = computeDynamicCreditCost(plan.totalVideoProviderCostVnd, marginPercent, vndPerCredit);
  } else {
    videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);
  }

  // Chuỗi liên tục: N+1 ảnh cho N cảnh (không phải 2N) — xem resolveCosts()/runSceneStage() (luồng 1
  // nhân vật đã áp dụng công thức này, đây là mirror cho nhiều nhân vật). Số cảnh dùng để tính ảnh phải
  // lấy theo plannedScenes.length (số cảnh THẬT SỰ sẽ tạo ảnh, sau khi planStoryVideoScenesMulti() đã
  // tự động gộp hành động cùng tập nhân vật) — không phải job.num_scenes (số hành động GỐC trước gộp).
  const effectiveSceneCount = plannedScenes ? plannedScenes.length : job.num_scenes;
  const imageCallCount = job.continuous_motion ? effectiveSceneCount + 1 : effectiveSceneCount;
  const imageCost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene * imageCallCount, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, job.auto_video ? imageCost + videoCost : imageCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  await supabase
    .from("story_video_jobs")
    .update({ status: "splitting_story", image_credit_tx_id: deduction.txId, story_description: finalStoryDescription })
    .eq("id", job.id);

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    const combinedInstructions = [
      miniApp.model_config.prompt_helper_instructions,
      resolveGenreStyleGuide(job.genre_key, miniApp.model_config.genre_style_guides),
    ]
      .filter((s): s is string => !!s?.trim())
      .join("\n\n");
    const characterLabels = jobCharacters.map((c) => c.label || `Nhân vật ${c.position + 1}`);

    let scenes: MultiSceneSplitResult[];
    if (plannedScenes) {
      scenes = plannedScenes;
    } else {
      // Skill "story-extractor" — chỉ dùng nội bộ cho chia cảnh, không ghi đè story_description đã lưu.
      const extractedStory = await extractStoryEssentials(finalStoryDescription, job.mini_app_id, modelChatKey);
      scenes = await splitStoryIntoScenesMulti(
        extractedStory,
        job.num_scenes,
        characterLabels,
        combinedInstructions || undefined,
        modelChatKey,
        job.continuous_motion,
        miniApp.model_config.allow_scene_padding
      );
      // Skill "story-validator" — thử chia lại ĐÚNG 1 lần nếu lỗi, không chặn cứng job nếu vẫn lỗi.
      const validation = await validateSceneSplit(finalStoryDescription, scenes, job.mini_app_id, modelChatKey);
      if (!validation.ok) {
        console.error(`[story-video] story-validator báo lỗi job #${job.id}, thử chia lại 1 lần: ${validation.issue}`);
        const retryInstructions = [combinedInstructions, `Lần chia trước bị lỗi: ${validation.issue}. Sửa lại cho đúng.`]
          .filter((s): s is string => !!s?.trim())
          .join("\n\n");
        scenes = await splitStoryIntoScenesMulti(
          extractedStory,
          job.num_scenes,
          characterLabels,
          retryInstructions,
          modelChatKey,
          job.continuous_motion,
          miniApp.model_config.allow_scene_padding
        );
      }
    }

    const { data: sceneRows, error: sceneError } = await supabase
      .from("story_video_scenes")
      .insert(
        scenes.map((scene, index) => ({
          job_id: job.id,
          position: index,
          scene_description: scene.description,
          end_description: scene.end_description ?? null,
          character_positions: scene.characters,
          shot_size: scene.shot_size,
          camera_angle: scene.camera_angle,
          camera_movement: scene.camera_movement,
          dialogue_line: scene.dialogue?.line?.trim() || null,
          dialogue_speaker_position: scene.dialogue ? scene.dialogue.speaker : null,
          location: scene.location,
          end_pose: scene.end_pose,
          motion_duration_key: plannedScenes ? plannedScenes[index].duration_key : null,
          natural_duration_seconds: plannedScenes ? plannedScenes[index].duration_seconds : null,
          pace: plannedScenes ? plannedScenes[index].pace ?? null : null,
          rotation_degrees: plannedScenes ? plannedScenes[index].rotation_degrees ?? null : null,
        }))
      )
      .select("id, position, scene_description, character_positions, shot_size, camera_angle, camera_movement, location");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    if (job.frame_chain_mode) {
      // Frame-chaining (dẫn trạng thái qua khung hình THẬT) — mirror đúng nhánh frame_chain_mode của
      // runSceneStage (luồng 1 nhân vật): chỉ tạo ảnh cho cảnh đầu tiên ngay bây giờ, các cảnh sau tạo
      // TUẦN TỰ dựa vào khung hình cuối THẬT trích từ video cảnh liền trước (xem
      // applyFrameChainVideoResult — đã hoàn toàn generic theo scene/job, không cần sửa gì thêm ở đó).
      const firstRow = sceneRows.find((r) => r.position === 0);
      if (firstRow) {
        const requestId = await submitMultiCharacterSceneImageForRow(job, firstRow, jobCharacters, imageEntry, false, "image");
        await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", firstRow.id);
      }
    } else if (job.continuous_motion) {
      // Chuỗi N+1 ảnh, song song — mirror đúng nhánh continuous_motion của runSceneStage (luồng 1
      // nhân vật): cảnh đầu tiên nộp thêm 1 lượt ảnh ĐẦU, MỌI cảnh đều nộp 1 lượt ảnh CUỐI (dùng
      // end_description) — nối chuỗi (ảnh cuối cảnh N -> ảnh đầu cảnh N+1) xảy ra trong
      // applyImageStageResult() khi webhook ảnh cuối trả về, không phải ở đây.
      const sortedRows = [...sceneRows].sort((a, b) => a.position - b.position);
      const firstRow = sortedRows[0];
      await Promise.all([
        (async () => {
          const requestId = await submitMultiCharacterSceneImageForRow(job, firstRow, jobCharacters, imageEntry, false, "image");
          await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", firstRow.id);
        })(),
        ...sortedRows.map(async (row) => {
          const scene = scenes[row.position];
          // Ảnh cuối cảnh có thể cần ảnh tham chiếu KHÁC với ảnh đầu (vd thêm 1 người vừa bước vào
          // khung hình để nối sang cảnh sau) — dùng end_characters nếu Agent có khai báo, không thì
          // rơi về đúng characters gốc của cảnh (không đổi gì nếu end_characters vắng mặt).
          const endRow = {
            ...row,
            scene_description: scene.end_description ?? scene.description,
            character_positions: scene.end_characters ?? row.character_positions,
          };
          const requestId = await submitMultiCharacterSceneImageForRow(job, endRow, jobCharacters, imageEntry, false, "image_end");
          await supabase.from("story_video_scenes").update({ end_image_fal_request_id: requestId }).eq("id", row.id);
        }),
      ]);
    } else {
      // Scene State — mirror runSceneStage (luồng 1 nhân vật): tiêm end_pose của cảnh liền trước.
      await Promise.all(
        sceneRows.map(async (row) => {
          const previousEndPose = row.position > 0 ? scenes[row.position - 1]?.end_pose : undefined;
          const requestId = await submitMultiCharacterSceneImageForRow(job, row, jobCharacters, imageEntry, false, "image", previousEndPose);
          await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", row.id);
        })
      );
    }

    await supabase.from("story_video_jobs").update({ status: "generating_images" }).eq("id", job.id);
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Khách bấm "Tiếp tục chia cảnh" sau khi xem/duyệt ảnh Character (job đang ở "character_ready") — trừ
// credit phần ảnh (đã snapshot provider_cost_vnd/cảnh lúc submit) rồi chạy chia cảnh (LLM) + submit
// ảnh cho từng cảnh, dùng character_sheet_url làm tham chiếu chung thay vì ảnh gốc lộn xộn.
export async function continueStoryVideoToSceneStage(
  userId: string,
  jobId: number,
  modelChatKey: string | undefined,
  idempotencyKey: string,
  storyDescription?: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "character_ready") throw new Error("Job không ở trạng thái sẵn sàng chia cảnh");

  // Bước Tạo Character không cần ý tưởng truyện, nên khách có thể chưa nhập lúc submit — bắt buộc
  // nhập ở đây trước khi chia cảnh (thứ dùng thật). Cho phép ghi đè/cập nhật nếu khách vừa gõ/sửa lại
  // ngay tại màn hình xem trước Character.
  const finalStoryDescription = storyDescription?.trim() || job.story_description?.trim();
  if (!finalStoryDescription) throw new Error("Thiếu ý tưởng truyện");

  // Job nhiều nhân vật (Bước 1) -> rẽ sang nhánh chia cảnh nhiều nhân vật (Bước 2), KHÔNG check
  // character_sheet_url job-level (job này không dùng cột đó — xem story_video_job_characters).
  const { data: jobCharacters } = await supabase
    .from("story_video_job_characters")
    .select("position, label, character_sheet_url, character_angle_urls, item_reference_urls")
    .eq("job_id", jobId)
    .order("position", { ascending: true });
  if (jobCharacters && jobCharacters.length >= 2) {
    return runMultiCharacterSceneStage(
      userId,
      job,
      jobCharacters as JobCharacterRefRow[],
      finalStoryDescription,
      modelChatKey,
      idempotencyKey,
      (job.preplanned_actions as unknown as ScriptSceneResultMulti[] | null) ?? undefined
    );
  }

  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");

  return runSceneStage(userId, job, finalStoryDescription, modelChatKey, idempotencyKey, job.preplanned_actions ?? undefined);
}

const SCENE_PROMPT_FROM_IMAGE_SYSTEM =
  `You are a screenwriter writing a short motion prompt (1-2 sentences, English) for the given image, to be used as an image-to-video generation prompt. Base it on: what's visible in the image, the overall story context provided, and the customer's hint if given.
IMPORTANT constraint when a per-scene hint IS given: the image + that specific hint are the ONLY authoritative source for what happens in THIS moment — the overall story is background/tone context only. Do NOT pull in, add, or continue any action, gesture, or plot beat from the overall story that is not present in this scene's own hint, even if the story mentions it elsewhere — that action belongs to a different scene and must not appear here. Only when NO hint is given at all should you infer the motion directly from the overall story.
HUMAN MOTION PRINCIPLE — video models render legs far more reliably than arms/hands (fewer degrees of freedom, strong repetitive gait pattern) — arms/hands are where AI-generated motion looks most unnatural. Do not treat the human body as a collection of independent moving parts; represent motion hierarchically. For locomotion actions such as walking:
1. The lower body generates the primary motion.
2. Weight transfer connects the legs to the hips.
3. The hips and torso provide balance and secondary movement.
4. Shoulder and arm motion is derived from the walking cycle.
5. Arm motion is contralateral to the leg on the OPPOSITE side of the body — this is a DIRECTION/PHASE relationship, not just shared tempo: at the instant the right leg swings forward, the left arm also swings forward (and the right arm swings backward); at the instant the left leg swings forward, the right arm also swings forward (and the left arm swings backward). Never describe an arm as moving "in rhythm with" or "in sync with" a leg without stating which direction it swings at that instant — that wording is ambiguous and has produced wrong-looking arm motion (arms moving the wrong way) in practice.
6. Arm frequency follows the walking rhythm, but arm amplitude remains substantially smaller than leg displacement.
7. Hands remain mostly passive unless the story explicitly requires hand action.
8. Do not give arms the same motion amplitude as the legs.
9. Do not invent independent gestures for hands or arms.
10. Explicit actions (waving, holding/using an object, pointing) override passive secondary motion for that limb only — other limbs stay in their normal secondary/passive role.
Think in terms of: motion hierarchy + dependency + phase + amplitude + timing — and write this directly into the motion description in plain language (not as separate fields), stating the swing DIRECTION explicitly, e.g. "she walks forward with alternating steps that lead the motion; each arm swings forward at the same instant the opposite leg swings forward, and backward as that leg swings backward, with noticeably smaller motion than her legs; her hands stay relaxed and mostly still."
Also estimate how many seconds of video this motion naturally needs to look smooth and natural — NOT rushed (too much motion crammed into too little time looks jerky/sped-up) and NOT padded (too little motion stretched over too much time makes the model invent extra filler motion, looking aimless/drifting).
If a rotation/turn hint is given below, use it as the primary guide for duration (bigger rotations need more time, but not linearly — the increase slows down for larger angles). Otherwise use this reference for non-turning motion:
- micro (blink, glance, small smile, slight head tilt): 1-2s
- gesture (nod, wave, point, pick up small object): 2-3s
- body motion (stand up, sit down): 3-4s
- locomotion (walk a few steps): duration = number of steps × 0.5s (real walking cadence is about 2 steps per second — a typical few-step walk is 3-5 steps, so about 1.5-2.5s; do NOT default to a longer duration out of habit, stretching a few steps over more time makes the model render a jog/run instead of a walk). If the framing needs the character to cover more ground, extend the duration to fit MORE steps at this same 0.5s/step cadence — never speed up the gait itself to cover more distance in less time, that is exactly what produces a running gait when a walk was intended.
- multi-step action (walk to object + pick it up + turn back): scale from the locomotion rule above (steps × 0.5s) plus 1-2s for the object interaction.
If the motion is (or includes) a FULL 360-degree rotation/turn (a continuous spin, not a step-wise turn to face a new direction): pace it as ONE brisk, EVEN, constant-speed rotation lasting about 2 seconds total (roughly a quarter-turn every 0.5s) — this is a single continuous momentum spin, much faster than a deliberate step-wise turn, and should read as confident/fluid, not slow or hesitant. Immediately after completing the full 360°, the character holds completely still in the ending pose — do NOT let the motion continue into a second rotation or any extra movement; if the estimated duration_seconds is longer than the spin itself needs, spend the remaining time on the hold, not on repeating the spin. Write this directly into the motion description (e.g. "she completes one brisk, even 360-degree rotation in about two seconds, then holds completely still facing forward — a single spin only, no second rotation") — a vague phrase like "smoothly rotates" alone is not enough guidance and tends to render as either an abrupt fast turn or an unwanted repeated spin.
Write the motion itself with a natural acceleration into the movement and a brief deceleration/settle at the end — not constant-speed motion, and not an abrupt instant stop — this reads as far more physically real.
Return ONLY 1 line of valid JSON with EXACTLY these 2 keys, no markdown fence, no explanation, no comment lines, and NO other keys of any kind: {"motion_prompt": "<the motion description>", "duration_seconds": <integer, your best estimate>}. Do NOT add extra keys like "primary_motion", "secondary_motion", "camera_motion", or any other breakdown — put everything into the single "motion_prompt" string. Adding extra keys makes the response too long and get cut off mid-way, breaking the JSON entirely.`;

type SceneMotionPlan = { motionPrompt: string; durationSeconds?: number };

// Ước lượng góc quay giữa 2 cảnh liên tiếp từ camera_view (6 giá trị cố định, xem CHARACTER_ANGLE_LABELS)
// -- quy về độ lệch so với "front" rồi lấy trị tuyệt đối chênh lệch. Chỉ là ước lượng gần đúng (vd
// three_quarter_left -> three_quarter_right thực ra có thể xoay ngược hướng), đủ dùng làm gợi ý thời
// lượng, không cần chính xác tuyệt đối như đo góc thật.
const CAMERA_VIEW_DEGREES: Record<string, number> = {
  front: 0,
  face: 0,
  three_quarter_left: 45,
  three_quarter_right: 45,
  side: 90,
  back: 180,
};

// Dữ liệu tham khảo: thời gian người thật xoay người theo góc không tuyến tính (Turn-H3.6M: ~55°≈1.1s,
// ~89°≈1.5s, ~135°≈2.4s, ~179°≈2.9s) -- AI video cần lâu hơn người thật (đủ thời gian tăng/giảm tốc +
// khựng lại cuối chuyển động cho tự nhiên, tránh giật), nên các mốc dưới đây rộng hơn số liệu người thật,
// không phải copy thẳng.
function describeCameraTurn(previousView: string | null | undefined, currentView: string | null | undefined): string | undefined {
  if (!previousView || !currentView) return undefined;
  const from = CAMERA_VIEW_DEGREES[previousView];
  const to = CAMERA_VIEW_DEGREES[currentView];
  if (from === undefined || to === undefined) return undefined;
  const delta = Math.abs(to - from);
  if (delta < 15) return undefined; // gần như không xoay -- để rơi về bảng tham khảo hành động thường
  let range: string;
  if (delta <= 45) range = "2-3s";
  else if (delta <= 60) range = "3-4s";
  else if (delta <= 90) range = "3-5s";
  else if (delta <= 135) range = "4-6s";
  else range = "5-7s";
  return `Rotation hint: this scene turns roughly ${delta}° relative to the previous scene (from "${previousView}" to "${currentView}") — target duration for this turn alone is about ${range} (adjust up if the scene also includes other motion beyond the turn).`;
}

// Model đôi khi bỏ qua chỉ dẫn "chỉ trả 2 field" và tự thêm field khác (primary_motion/camera_motion/...),
// khiến response dài hơn max_tokens và bị cắt cụt giữa chừng -> JSON.parse() cả chuỗi sẽ luôn fail dù
// field "motion_prompt" (thường đứng trước, đã đóng ngoặc kép đầy đủ) vẫn còn nguyên vẹn. Trích riêng
// field đó bằng regex trước khi rơi về dùng nguyên văn cả chuỗi thô -- tránh lặp lại bug thật đã gặp: cả
// chuỗi JSON thô (lẫn field name/dấu ngoặc, mô tả cùng 1 động tác lặp lại nhiều lần ở nhiều field) bị gửi
// thẳng làm prompt tạo video, khiến model video hiểu nhầm 1 động tác thành nhiều nhịp (vd job 121: xoay
// 360 độ bị render thành "quay nửa vòng rồi quay lại").
function extractMotionPromptFragment(text: string): string | undefined {
  const match = text.match(/"motion_prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(`"${match[1]}"`).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

// Model đôi khi chèn thẳng xuống dòng/tab THẬT (không escape thành "\n") vào giữa chuỗi motion_prompt —
// phá cả JSON.parse() lẫn bước unescape trong extractMotionPromptFragment ("Bad control character in
// string literal" ở CẢ 2 nơi), khiến rơi hẳn về fallback dùng NGUYÊN VĂN cả khối JSON thô (kèm mọi field
// dư model tự thêm như "resolution"/"safety_tolerance"/"seed") làm prompt gửi thẳng cho model tạo video —
// xác nhận qua job thật #370: model video từ chối 422 content_policy_violation vì prompt lẫn cú pháp
// JSON + tên field lạ, không phải vì nội dung chuyển động thật có vấn đề. Thay hết ký tự xuống dòng/tab
// thật bằng khoảng trắng trước khi thử parse — an toàn với JSON hợp lệ (khoảng trắng ngoài chuỗi không
// ảnh hưởng cú pháp), chỉ sửa đúng trường hợp lỗi (khoảng trắng bên trong 1 chuỗi giá trị vẫn hợp lệ).
function normalizeRawControlChars(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ");
}

function parseSceneMotionPlan(output: string, fallbackPrompt?: string): SceneMotionPlan {
  const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const normalized = normalizeRawControlChars(cleaned);
  try {
    const parsed = JSON.parse(normalized);
    if (typeof parsed?.motion_prompt === "string" && parsed.motion_prompt.trim()) {
      const seconds = Number(parsed.duration_seconds);
      return { motionPrompt: parsed.motion_prompt.trim(), durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined };
    }
  } catch {
    const extracted = extractMotionPromptFragment(normalized);
    if (extracted) return { motionPrompt: extracted };
  }
  // Không trích được field "motion_prompt" hợp lệ nào (JSON hỏng, hoặc JSON hợp lệ nhưng thiếu/rỗng
  // field này) — xác nhận thật qua job #163: model tự thêm field "primary_motion" TRƯỚC "motion_prompt"
  // (dù prompt đã cấm rõ), rồi bị cắt cụt NGAY GIỮA field đó, "motion_prompt" chưa từng được viết ra.
  // TUYỆT ĐỐI không gửi nguyên văn rác JSON dở dang làm prompt video (đúng lỗi đã gặp ở job #370: model
  // video từ chối 422 vì lẫn cú pháp JSON/tên field lạ) — rơi về mô tả cảnh tĩnh (scene_description/hint)
  // đã có sẵn, an toàn hơn hẳn dù không phải "mô tả chuyển động" thật sự, còn hơn gửi rác.
  return { motionPrompt: fallbackPrompt?.trim() || normalized };
}

// Motion Timing Controller — xem migration-story-video-motion-timing.sql + ghi nhớ
// project_story_video_scene_duration_architecture. CODE tính toán deterministic (tốc độ, chia giai
// đoạn), AI chỉ dịch số liệu đó thành câu văn tự nhiên — không để AI tự đoán mù nhịp độ nữa. Tỉ lệ %
// mỗi giai đoạn khác nhau theo "pace": fast dồn nhiều thời lượng vào "steady" (tăng/giảm tốc gọn hơn,
// cảm giác dứt khoát); slow kéo dài tăng/giảm tốc (êm hơn, từ tốn hơn).
const MOTION_PHASE_RATIOS: Record<"fast" | "normal" | "slow", number[]> = {
  fast: [0.05, 0.12, 0.66, 0.12, 0.05],
  normal: [0.1, 0.15, 0.5, 0.17, 0.08],
  slow: [0.1, 0.2, 0.4, 0.2, 0.1],
};
const MOTION_PHASE_LABELS = ["preparation", "acceleration", "steady motion", "deceleration", "settle"];

function buildMotionTimingSpec(
  durationSeconds: number,
  pace: "fast" | "normal" | "slow",
  rotationDegrees?: number
): string {
  const ratios = MOTION_PHASE_RATIOS[pace];
  let cursor = 0;
  const timeline = MOTION_PHASE_LABELS.map((phase, i) => {
    const start = cursor;
    cursor += durationSeconds * ratios[i];
    return `${phase} (${start.toFixed(1)}-${cursor.toFixed(1)}s)`;
  });
  const paceWord = pace === "fast" ? "brisk, energetic" : pace === "slow" ? "slow, deliberate" : "steady, natural";
  const speedLine =
    rotationDegrees && rotationDegrees > 0
      ? `This motion covers ${rotationDegrees}° of rotation over ${durationSeconds}s (average ${(rotationDegrees / durationSeconds).toFixed(1)}°/s — pace the rotation evenly across the timeline below, not front-loaded into the first second). `
      : "";
  return `${speedLine}Pace this motion in 5 phases matching the exact timeline: ${timeline.join(", ")}. Begin gently, build into a ${paceWord} pace through the middle "steady motion" phase, then decelerate smoothly and settle into the final pose — never a fast initial snap, and never an abrupt instant stop.`;
}

async function generateSceneDescriptionFromImage(
  imageUrl: string,
  hint: string | undefined,
  storyDescription: string,
  modelChatKey: string | undefined,
  genreStyleGuide?: string,
  skillOverride?: string,
  cameraTurn?: { previousCameraView?: string | null; currentCameraView?: string | null },
  // Khi bước "Tạo kịch bản" đã chốt sẵn số giây thật cho cảnh này (preplannedActions/script-flow),
  // truyền vào đây để Agent viết đúng nhịp độ khớp với thời lượng ĐÃ QUYẾT ĐỊNH — thay vì tự đoán mù 1
  // con số khác rồi bị code phía sau âm thầm vứt bỏ (đã xác nhận qua đọc code: applyFrameChainImageResult/
  // applyFrameChainVideoResult/proceedToVideoStage đều ưu tiên giữ scene.natural_duration_seconds đã có
  // sẵn, không bao giờ dùng plan.durationSeconds của lượt gọi này khi đã có số chốt từ trước).
  knownDurationSeconds?: number,
  pace?: "fast" | "normal" | "slow" | null,
  rotationDegrees?: number | null,
  // Job có vật phẩm riêng (giày/túi xách...) — ảnh tĩnh đã có vật phẩm trong khung hình (nếu cảnh đó
  // dùng tới), nhưng Agent viết chuyển động chỉ nhìn ảnh nên dễ bỏ qua, tả chuyển động chung chung
  // không nhắc tới vật phẩm dù đang cầm/đeo nó rõ trong ảnh. Câu nhắc này không bắt buộc Agent phải bịa
  // thêm hành động — chỉ nhắc ưu tiên mô tả ĐÚNG tương tác thật đang thấy trong ảnh khi có liên quan.
  hasItemReference?: boolean,
  // Cảnh CÓ lời thoại (sẽ lồng tiếng bằng Kling LipSync ở bước SAU, tách riêng) — truyền vào để chặn
  // Agent tự mô tả nhân vật "nói liên tục"/"speaking" xuyên suốt cả video câm này. Đã xác nhận qua báo
  // cáo thật: video câm gốc (trước khi lồng tiếng) tự vẽ miệng chuyển động gần như suốt clip theo đúng
  // mô tả "speaking naturally" — dài hơn hẳn thời gian đọc thật của câu thoại (đã đệm audio khớp đúng độ
  // dài video, nhưng KHÔNG sửa được việc video câm gốc đã "nói" quá lâu) — LipSync chỉ chỉnh KHỚP MIỆNG
  // theo audio chứ không ép miệng đứng yên hoàn toàn khi audio đã sang đoạn im lặng, nên miệng vẫn "mấp
  // máy" sau khi lời thoại kết thúc. Gốc rễ thật nằm ở video câm gốc, không phải ở bước lồng tiếng.
  dialogueLine?: string | null
): Promise<SceneMotionPlan> {
  let systemPrompt = genreStyleGuide?.trim()
    ? `${SCENE_PROMPT_FROM_IMAGE_SYSTEM}\n\nGhi chú thêm về phong cách/nhịp điệu chuyển động cho đúng thể loại: ${genreStyleGuide.trim()}`
    : SCENE_PROMPT_FROM_IMAGE_SYSTEM;
  if (hasItemReference) {
    systemPrompt += `\n\nThe character may be wearing, holding, or carrying one of their own real physical items in this image. If the image clearly shows them interacting with such an item (wearing it, holding it, using it), describe that interaction naturally as part of the motion — do not ignore a visible item interaction in favor of a generic description. Only mention the item if it is actually visible in the image; do not invent one.`;
  }
  if (dialogueLine?.trim()) {
    systemPrompt += `\n\nThis scene has a short spoken line that will be added afterward via a SEPARATE lip-sync process applied to this silent video — do NOT describe the character as talking/speaking continuously for the whole clip. The real spoken line is short (only a few seconds); describe the mouth/face as speaking only briefly near the start, then returning to a natural closed/resting mouth expression for the rest of the clip. Never write "speaking naturally" or similar as an action spanning the entire described motion.`;
  }
  // Skill "motion-planner" — admin ghi thêm ghi chú qua /admin (vd luôn nhấn mạnh chuyển động camera).
  if (skillOverride?.trim()) systemPrompt += `\n\nGhi chú thêm từ admin: ${skillOverride.trim()}`;
  const turnHint = describeCameraTurn(cameraTurn?.previousCameraView, cameraTurn?.currentCameraView);
  // Có đủ số giây đã chốt -> dùng Motion Timing Spec tính sẵn (chính xác hơn, thay cho việc để AI tự
  // đoán nhịp độ) thay vì chỉ nói "vừa khít X giây" chung chung.
  const durationLine =
    knownDurationSeconds && knownDurationSeconds > 0
      ? `\nThời lượng cảnh này ĐÃ ĐƯỢC CHỐT SẴN: ${knownDurationSeconds} giây — không cần tự ước lượng lại số giây. ${buildMotionTimingSpec(knownDurationSeconds, pace ?? "normal", rotationDegrees ?? undefined)}`
      : "";
  const userPrompt = `Ý tưởng truyện tổng thể: ${storyDescription}${hint ? `\nGợi ý riêng cho cảnh này: ${hint}` : ""}${turnHint ? `\n${turnHint}` : ""}${durationLine}\nViết mô tả chuyển động ngắn cho ảnh này.`;
  // 500 -> 900: model "thinking" (gemini-3-flash-preview) tốn 1 phần token cho suy nghĩ nội bộ trước khi
  // ra chữ trả lời (cùng nguyên nhân đã sửa cho classifyCharacterImage) — nếu model lỡ thêm field thừa
  // (primary_motion/camera_motion...) dù đã bị cấm, 500 token quá chật dễ bị cắt cụt giữa chừng.
  const { output } = await callOpenRouter(modelChatKey || "google/gemini-3-flash-preview", 900, systemPrompt, userPrompt, imageUrl);
  return parseSceneMotionPlan(output, hint);
}

// Motion Timing Controller: model video chỉ nhận 1 trong các mức thời lượng rời rạc catalog cho phép
// (vd "5"/"8" giây) -- tìm mức GẦN NHẤT với số giây skill motion-planner vừa ước lượng cho đúng cảnh
// đó. Trả undefined nếu model không có bảng giá theo thời lượng (chỉ 1 mức cố định, không có gì để
// chọn) hoặc chưa ước lượng được số giây -- cả 2 trường hợp đều rơi về video_duration_key của job.
// Ưu tiên mức NHỎ NHẤT trong các mức ĐỦ HOẶC DƯ so với nhu cầu thật (seconds) — phần dư (nếu có) được
// cơ chế "giữ tư thế + cắt" xử lý an toàn, miễn phí, không có nguy cơ model tự bịa thêm chuyển động lặp.
// Ngược lại, chọn mức THIẾU sẽ ép hành động bị nén lại cho vừa (giật/nhanh hơn tự nhiên) — không có cơ
// chế nào bù được phần thiếu đó, nên rủi ro cao hơn hẳn so với rủi ro của phần dư. Chỉ khi KHÔNG còn
// mức nào đủ (seconds vượt quá cả mức cao nhất model hỗ trợ) mới đành lấy mức cao nhất hiện có (chắc
// chắn thiếu, không còn lựa chọn khác).
function resolveNearestDurationKey(durationPriceMap: Record<string, number> | undefined, seconds: number | undefined): string | undefined {
  if (!durationPriceMap || seconds === undefined) return undefined;
  const numericKeys = Object.keys(durationPriceMap)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (numericKeys.length === 0) return undefined;
  const coveringKeys = numericKeys.filter((n) => n >= seconds);
  return String(coveringKeys.length > 0 ? Math.min(...coveringKeys) : Math.max(...numericKeys));
}

// Khách đã có sẵn ảnh cho từng phân cảnh (tải lên thay vì để AI tạo) -> bỏ qua hoàn toàn bước Character
// + bước AI tạo ảnh phân cảnh (không cần model ảnh, không tốn credit ảnh) — chỉ cần Agent viết mô tả
// chuyển động (dựa vào ảnh + gợi ý tuỳ chọn của khách + Ý tưởng truyện) để dùng làm prompt tạo VIDEO.
// Dừng ở "images_ready" (hoặc chạy thẳng tới video nếu autoVideo) giống hệt luồng AI tự tạo, dùng
// chung toàn bộ phần hiển thị/tiếp tục phía sau — không cần thêm status hay UI kết quả riêng.
export async function submitStoryVideoJobWithOwnImages(
  userId: string,
  miniAppId: string,
  storyDescription: string,
  sceneImages: { imageUrl: string; hint?: string }[],
  videoModelKey: string | undefined,
  autoVideo: boolean,
  aspectRatio: string,
  durationKey: string | undefined,
  modelChatKey: string | undefined,
  idempotencyKey: string
): Promise<{ jobId: number; newBalance: number }> {
  const numScenes = sceneImages.length;
  if (numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
    throw new Error(`Cần từ ${MIN_SCENES} đến ${MAX_SCENES} phân cảnh`);
  }
  const finalStoryDescription = storyDescription.trim();
  if (!finalStoryDescription) throw new Error("Thiếu ý tưởng truyện");

  const supabase = getSupabaseAdmin();
  const miniApp = await getMiniAppModelConfig(miniAppId);
  const videoEntry = resolveModelEntry(miniApp.model_config.video_models, videoModelKey);
  // Luồng "khách tự tải ảnh phân cảnh" chỉ có đúng 1 ảnh/cảnh, không có cơ chế tạo ảnh CUỐI cảnh —
  // model nào bắt buộc cả ảnh đầu lẫn ảnh cuối (vd "veo31-lite-flf") sẽ luôn lỗi 422 thiếu last_frame_url
  // nếu chọn ở đây. Chặn sớm bằng lỗi rõ ràng thay vì để job chạy tới lúc tạo video mới báo lỗi.
  if (REQUIRES_CONTINUOUS_MOTION_VIDEO_KEYS.has(videoEntry.key)) {
    throw new Error(
      `Model video "${videoEntry.label}" yêu cầu cả ảnh đầu lẫn ảnh cuối cảnh — không dùng được khi tự tải ảnh phân cảnh có sẵn. Vui lòng chọn model video khác.`
    );
  }

  let videoProviderCostVnd = videoEntry.provider_cost_vnd;
  let resolvedDurationKey: string | undefined;
  if (videoEntry.duration_price_vnd) {
    const resolved = resolvePricedKey(videoEntry.duration_price_vnd, durationKey);
    resolvedDurationKey = resolved.key;
    videoProviderCostVnd = resolved.costVnd;
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const videoCost = computeDynamicCreditCost(videoProviderCostVnd * numScenes, marginPercent, vndPerCredit);

  const deduction = await deductCredit(userId, videoCost, miniAppId, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "splitting_story",
      story_description: finalStoryDescription,
      num_scenes: numScenes,
      character_image_urls: [],
      video_model: videoEntry.model,
      auto_video: autoVideo,
      aspect_ratio: aspectRatio,
      video_duration_key: resolvedDurationKey ?? null,
      video_provider_cost_vnd_per_scene: videoProviderCostVnd,
      video_credit_tx_id: deduction.txId,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    if (deduction.txId) await safeRefund(deduction.txId);
    throw new Error(insertError?.message ?? "Không tạo được job");
  }

  try {
    const motionPlannerOverride = await resolveSkillOverride(miniAppId, "motion_planner_prompt");
    const scenes = await Promise.all(
      sceneImages.map(async (s, index) => {
        const plan = await generateSceneDescriptionFromImage(
          s.imageUrl,
          s.hint,
          finalStoryDescription,
          modelChatKey,
          undefined,
          motionPlannerOverride
        );
        // Motion Timing Controller: dùng luôn kết quả ước lượng giây của lượt gọi AI vừa rồi (không tốn
        // thêm lượt gọi nào) để chọn mức thời lượng RIÊNG cho cảnh này thay vì dùng chung 1 mức cho cả job.
        const motionDurationKey = resolveNearestDurationKey(videoEntry.duration_price_vnd, plan.durationSeconds);
        return {
          job_id: job.id,
          position: index,
          scene_description: plan.motionPrompt,
          image_url: s.imageUrl,
          motion_duration_key: motionDurationKey ?? null,
        };
      })
    );
    const { error: sceneError } = await supabase.from("story_video_scenes").insert(scenes);
    if (sceneError) throw new Error(sceneError.message);

    if (autoVideo) {
      const sceneRows = await getScenes(job.id);
      await proceedToVideoStage(job.id, sceneRows);
    } else {
      await supabase.from("story_video_jobs").update({ status: "images_ready" }).eq("id", job.id);
    }
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { jobId: job.id, newBalance: await getCreditBalance(userId) };
}

// Khách chỉ ưng 1 phần ảnh phân cảnh — tạo lại ĐÚNG 1 cảnh (không đụng các cảnh khác), trừ credit
// đúng bằng giá 1 ảnh (không phải cả N cảnh). Dùng lại nguyên description/camera_view/outfit_override/
// face_view đã có sẵn của cảnh đó, chỉ đổi ảnh xuất ra — không gọi lại Agent chia cảnh.
export async function regenerateSceneImage(userId: string, sceneId: number, idempotencyKey: string): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: sceneData } = await supabase
    .from("story_video_scenes")
    .select(
      "id, job_id, position, scene_description, camera_view, shot_size, camera_angle, outfit_override, face_view, character_positions, location"
    )
    .eq("id", sceneId)
    .single();
  if (!sceneData) throw new Error("Không tìm thấy phân cảnh");

  // Scene State — tạo lại 1 cảnh giữa chừng vẫn cần giữ đúng continuity với cảnh liền trước (không có
  // sẵn trong "scenes" mảng bộ nhớ như lúc chia cảnh lần đầu, phải tự fetch lại từ DB).
  let previousEndPose: string | null | undefined;
  if (sceneData.position > 0) {
    const { data: prevScene } = await supabase
      .from("story_video_scenes")
      .select("end_pose")
      .eq("job_id", sceneData.job_id)
      .eq("position", sceneData.position - 1)
      .maybeSingle();
    previousEndPose = prevScene?.end_pose;
  }

  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", sceneData.job_id).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với phân cảnh này");
  if (!job.image_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá của job");

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const cost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene, marginPercent, vndPerCredit);
  const deduction = await deductCredit(userId, cost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    let requestId: string;
    // Cảnh thuộc job nhiều nhân vật (Bước 2) -> tạo lại đúng theo công thức nhiều người (nhiều ảnh
    // tham chiếu), không phải công thức 1 người (camera_view/face_view).
    if (sceneData.character_positions && sceneData.character_positions.length > 0) {
      const { data: jobCharacters } = await supabase
        .from("story_video_job_characters")
        .select("position, label, character_sheet_url, character_angle_urls, item_reference_urls")
        .eq("job_id", job.id)
        .order("position", { ascending: true });
      requestId = await submitMultiCharacterSceneImageForRow(
        job,
        sceneData,
        (jobCharacters as JobCharacterRefRow[]) ?? [],
        imageEntry,
        true,
        "image",
        previousEndPose
      );
    } else {
      requestId = await submitSceneImageForRow(job, sceneData, imageEntry, true, "image", previousEndPose);
    }
    await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId, image_url: null }).eq("id", sceneId);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// "Tạo lại" ảnh cho ĐÚNG 1 vị trí khi job bật chuyển động liên tục — không dùng chung được với
// regenerateSceneImage() ở trên vì ảnh hiển thị ở "Cảnh (position+1)" trong UI thực ra là end_image_url
// của cảnh (position-1) đã được copy sang làm image_url lúc tạo lần đầu (xem "chuỗi liên tục" trong
// applyImageStageResult). Vậy tạo lại ảnh ở vị trí P nghĩa là:
//  - P = 0: tạo lại ĐÚNG ảnh đầu của chính cảnh 0 — không ảnh hưởng cảnh nào khác.
//  - P > 0: tạo lại ẢNH CUỐI của cảnh (P-1) — cảnh đó độc lập tự sinh end_image_url từ character sheet
//    (không phụ thuộc ảnh cảnh khác) rồi copy sang làm image_url của cảnh P, nên KHÔNG cần tạo lại/động
//    tới bất kỳ cảnh nào khác trong chuỗi (webhook trả về tự copy sang cảnh P qua propagateToSceneId).
export async function regenerateContinuousMotionSceneImage(
  userId: string,
  jobId: number,
  position: number,
  idempotencyKey: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;
  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (!job.continuous_motion) throw new Error("Job này không bật chuyển động liên tục");
  if (job.status !== "images_ready") throw new Error("Chỉ tạo lại được khi ảnh đã xong, chưa bắt đầu tạo video");
  if (!job.image_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá của job");

  const scenes = await getScenes(jobId);
  const targetPosition = position > 0 ? position - 1 : 0;
  const targetScene = scenes.find((s) => s.position === targetPosition);
  if (!targetScene) throw new Error("Không tìm thấy phân cảnh");
  const nextScene = position > 0 ? scenes.find((s) => s.position === position) : undefined;
  const stage: "image" | "image_end" = position > 0 ? "image_end" : "image";
  // Ảnh cuối dùng đúng "end_description" đã lưu lúc chia cảnh (khoảnh khắc KẾT THÚC); ảnh đầu (P=0)
  // dùng scene_description gốc (khoảnh khắc chính của chính cảnh đó). Thiếu end_description (job cũ
  // tạo trước khi có cột này) thì đành fallback về scene_description, còn hơn báo lỗi không tạo lại được.
  const descriptionForThisImage =
    stage === "image_end" ? targetScene.end_description ?? targetScene.scene_description ?? "" : targetScene.scene_description ?? "";
  if (!descriptionForThisImage) throw new Error("Cảnh này thiếu mô tả để tạo lại ảnh");

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const cost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene, marginPercent, vndPerCredit);
  const deduction = await deductCredit(userId, cost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    const rowForSubmit = { ...targetScene, scene_description: descriptionForThisImage };
    let requestId: string;
    if (targetScene.character_positions && targetScene.character_positions.length > 0) {
      const { data: jobCharacters } = await supabase
        .from("story_video_job_characters")
        .select("position, label, character_sheet_url, character_angle_urls, item_reference_urls")
        .eq("job_id", job.id)
        .order("position", { ascending: true });
      requestId = await submitMultiCharacterSceneImageForRow(
        job,
        rowForSubmit,
        (jobCharacters as JobCharacterRefRow[]) ?? [],
        imageEntry,
        true,
        stage,
        undefined,
        nextScene?.id
      );
    } else {
      requestId = await submitSceneImageForRow(job, rowForSubmit, imageEntry, true, stage, undefined, nextScene?.id);
    }
    const requestIdField = stage === "image_end" ? "end_image_fal_request_id" : "image_fal_request_id";
    await supabase.from("story_video_scenes").update({ [requestIdField]: requestId }).eq("id", targetScene.id);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Khách chưa ưng ảnh Character (job đang ở "character_ready") -> ép tạo lại từ đúng ảnh gốc đã tải
// lên lúc submit. Không hoàn credit lần tạo trước (đã tốn phí gọi model thật, coi là chi phí đã chi
// để thử) — chỉ tính thêm credit cho lần tạo mới.
export async function regenerateCharacter(userId: string, jobId: number, idempotencyKey: string): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "character_ready") throw new Error("Job không ở trạng thái xem trước Character");
  const hasDescription = !!job.character_appearance_description?.trim();
  if (!hasDescription && (!job.character_image_urls || job.character_image_urls.length === 0)) {
    throw new Error("Job này không có ảnh gốc để tạo lại (đang dùng Character đã lưu từ thư viện)");
  }

  const { creditCost } = await computeCharacterCreditCost();
  const deduction = await deductCredit(userId, creditCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    // Chế độ "Mô tả bằng chữ" — dùng lại đúng mô tả đã lưu, không cần khách gõ lại (xem
    // character_appearance_description ở JobRow, set 1 lần lúc submitStoryVideoJob).
    const requestId = hasDescription
      ? await submitFalJob(
          CHARACTER_TEXT_TO_IMAGE_MODEL,
          { prompt: buildCharacterSheetTextPrompt(job.character_appearance_description!.trim()), image_size: "landscape_4_3", quality: "high" },
          `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character`
        )
      : await (async () => {
          const characterPrompt = await resolveCharacterPrompt(job.mini_app_id);
          const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, job.character_image_urls, true, "1:1", undefined);
          return submitFalJob(CHARACTER_SHEET_MODEL, body, `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character`);
        })();
    await supabase
      .from("story_video_jobs")
      .update({
        status: "generating_character",
        character_source: hasDescription ? "text_described" : "generated",
        character_credit_tx_id: deduction.txId,
        character_fal_request_id: requestId,
      })
      .eq("id", jobId);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Tạo lại Character của ĐÚNG 1 người trong job nhiều nhân vật — mirror regenerateCharacter() nhưng
// nhắm đúng 1 hàng story_video_job_characters. Job chuyển tạm về "generating_character" trong lúc
// chờ; applyCharacterStageResult(jobId, result, position) sẽ tự đưa job về lại "character_ready" khi
// TẤT CẢ người (kể cả những người khác không đổi, vẫn còn sheet cũ) đã có sheet.
export async function regenerateJobCharacter(
  userId: string,
  jobId: number,
  position: number,
  idempotencyKey: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "character_ready") throw new Error("Job không ở trạng thái xem trước Character");

  const { data: jobCharacter } = await supabase
    .from("story_video_job_characters")
    .select("id, source_image_urls, appearance_description")
    .eq("job_id", jobId)
    .eq("position", position)
    .single();
  if (!jobCharacter) throw new Error("Không tìm thấy nhân vật này trong job");
  const hasDescription = !!jobCharacter.appearance_description?.trim();
  if (!hasDescription && (!jobCharacter.source_image_urls || jobCharacter.source_image_urls.length === 0)) {
    throw new Error("Nhân vật này không có ảnh gốc để tạo lại (đang dùng Character đã lưu từ thư viện)");
  }

  const { creditCost } = await computeCharacterCreditCost();
  const deduction = await deductCredit(userId, creditCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    // Chế độ "Mô tả bằng chữ" — dùng lại đúng mô tả đã lưu, không cần khách gõ lại.
    const requestId = hasDescription
      ? await submitFalJob(
          CHARACTER_TEXT_TO_IMAGE_MODEL,
          { prompt: buildCharacterSheetTextPrompt(jobCharacter.appearance_description!.trim()), image_size: "landscape_4_3", quality: "high" },
          `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character&characterPosition=${position}`
        )
      : await (async () => {
          const characterPrompt = await resolveCharacterPrompt(job.mini_app_id);
          const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, jobCharacter.source_image_urls, true, "1:1", undefined);
          return submitFalJob(CHARACTER_SHEET_MODEL, body, `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character&characterPosition=${position}`);
        })();
    await supabase
      .from("story_video_job_characters")
      .update({ character_sheet_url: null, character_angle_urls: null, character_fal_request_id: requestId })
      .eq("id", jobCharacter.id);
    await supabase.from("story_video_jobs").update({ status: "generating_character" }).eq("id", jobId);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// jobId (tuỳ chọn): nếu có, lấy luôn character_angle_urls đã cắt sẵn từ job đó gán vào Character lưu
// mới — tránh phải cắt lại từ đầu mỗi lần dùng lại Character này sau này.
export async function saveStoryCharacter(userId: string, imageUrl: string, label?: string, jobId?: number): Promise<number> {
  const supabase = getSupabaseAdmin();
  let angleUrls: CharacterAngleUrls | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select("user_id, character_angle_urls")
      .eq("id", jobId)
      .single();
    if (job && job.user_id === userId) angleUrls = (job.character_angle_urls as CharacterAngleUrls | null) ?? null;
  }
  const { data, error } = await supabase
    .from("story_characters")
    .insert({ user_id: userId, image_url: imageUrl, label: label?.trim() || null, angle_urls: angleUrls })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Không lưu được Character");
  return data.id;
}

export async function listStoryCharacters(
  userId: string
): Promise<{ id: number; imageUrl: string; label: string | null; createdAt: string }[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("story_characters")
    .select("id, image_url, label, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ id: r.id, imageUrl: r.image_url, label: r.label, createdAt: r.created_at }));
}

export async function deleteStoryCharacter(userId: string, characterId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("story_characters").delete().eq("id", characterId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// refund_credit (RPC) tự chặn hoàn credit trùng qua unique constraint trên idempotency_key
// "{txId}-refund" — nếu 2 lượt gọi failJob() gần như đồng thời cùng hoàn 1 tx (vd Fal.ai gửi trùng
// webhook báo lỗi cho cùng 1 cảnh), lượt thua sẽ nhận lỗi 23505 (duplicate key). Đây KHÔNG phải lỗi
// thật — tx đó đã được hoàn đúng bởi lượt thắng — nên bỏ qua an toàn, không quăng lỗi lên trên.
async function safeRefund(txId: number) {
  try {
    await refundCredit(txId);
  } catch (err) {
    if ((err as { code?: string })?.code !== "23505") throw err;
  }
}

// Khách chủ động bấm "Dừng tạo" (dừng hẳn) — mọi webhook Fal.ai trả về SAU thời điểm đó phải bị bỏ
// qua hoàn toàn, không được tiếp tục sang bước/cảnh kế tiếp. Dùng ở đầu 3 hàm applyXStageResult
// (image/video/lipsync) — đây là nơi DUY NHẤT quyết định "có tiếp tục pipeline hay không" mỗi khi 1
// kết quả Fal.ai trả về, nên chỉ cần chặn đúng 3 chỗ này là chặn được toàn bộ, kể cả nhánh frame-chain
// (applyFrameChainImageResult/applyFrameChainVideoResult chỉ được gọi TỪ BÊN TRONG 2 hàm applyImage/
// applyVideoStageResult, không có đường vào nào khác).
async function isJobCancelled(jobId: number): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("story_video_jobs").select("status").eq("id", jobId).single();
  return data?.status === "cancelled";
}

// Khách chủ động dừng job đang chạy dở — KHÔNG hoàn credit (khác hẳn failJob() dành cho lỗi thật): các
// cảnh đã tốn credit tạo ra trước khi dừng (ảnh/video) vẫn giữ nguyên, không hoàn lại, đúng theo lựa
// chọn của khách khi xác nhận tính năng này.
export async function cancelStoryVideoJob(userId: string, jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("story_video_jobs").select("user_id, status").eq("id", jobId).single();
  if (!job) throw new Error("Không tìm thấy job");
  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  // Chỉ dừng được job đang thật sự chạy dở — job đã xong/lỗi/đã dừng rồi thì bỏ qua im lặng, tránh ghi
  // đè lên 1 trạng thái đã có ý nghĩa khác (vd job đã "done" mà lỡ bấm dừng do bấm nhầm/chậm mạng).
  const activeStatuses = ["pending", "generating_character", "splitting_story", "generating_images", "generating_videos", "stitching"];
  if (!activeStatuses.includes(job.status)) return;
  await supabase.from("story_video_jobs").update({ status: "cancelled", error_message: "Đã dừng theo yêu cầu của bạn" }).eq("id", jobId);
}

async function failJob(jobId: number, message: string) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select("status, image_credit_tx_id, video_credit_tx_id, character_credit_tx_id, lipsync_credit_tx_id")
    .eq("id", jobId)
    .single();
  // Job đã bị đánh fail bởi 1 lượt gọi khác rồi (race) -> đã hoàn credit xong, không cần làm lại.
  if (job?.status === "failed") return;
  await supabase.from("story_video_jobs").update({ status: "failed", error_message: message }).eq("id", jobId);

  // Chỉ hoàn ĐÚNG phần credit của giai đoạn đang dở dang lúc lỗi — dựa vào status NGAY TRƯỚC KHI lỗi
  // (job.status đã select ở trên, trước dòng update phía trên). Trước đây hoàn cả 3 loại tx bất kể
  // đã set hay chưa, nên nếu lỗi xảy ra ở bước VIDEO (sau khi ảnh phân cảnh đã tạo xong, khách đã xem
  // được) thì credit ảnh cũng bị hoàn nhầm dù ảnh đã giao thành công — không đúng, khách đã nhận đúng
  // sản phẩm ảnh rồi thì không nên hoàn lại phần đó.
  if (!job?.image_credit_tx_id && !job?.character_credit_tx_id && job?.video_credit_tx_id) {
    // Job "ảnh phân cảnh tự tải lên" (submitStoryVideoJobWithOwnImages) — chỉ trừ duy nhất 1 loại
    // credit (video) ngay từ đầu, không theo mô hình 3 nấc Character/ảnh/video của luồng AI thường
    // (không có image/character tx nào để suy theo status) — hoàn thẳng luôn.
    await safeRefund(job.video_credit_tx_id);
    return;
  }

  if (job?.status === "generating_videos" || job?.status === "stitching") {
    if (job.video_credit_tx_id) await safeRefund(job.video_credit_tx_id);
    if (job.lipsync_credit_tx_id) await safeRefund(job.lipsync_credit_tx_id);
  } else if (job?.status === "splitting_story" || job?.status === "generating_images") {
    if (job.image_credit_tx_id) await safeRefund(job.image_credit_tx_id);
  } else {
    if (job?.character_credit_tx_id) await safeRefund(job.character_credit_tx_id);
  }
}

async function getScenes(jobId: number): Promise<SceneRow[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("story_video_scenes").select("*").eq("job_id", jobId).order("position", { ascending: true });
  return (data as SceneRow[]) ?? [];
}

export { getScenes as getStoryVideoScenes };

const CHARACTER_ANGLE_LABELS = ["front", "three_quarter_left", "three_quarter_right", "side", "back", "face"] as const;
export type CharacterAngleKey = (typeof CHARACTER_ANGLE_LABELS)[number];
export type CharacterAngleUrls = Record<CharacterAngleKey, string>;

// Cắt Character sheet (1 ảnh gộp 6 ô, bố cục CỐ ĐỊNH 3 cột x 2 hàng đúng theo CHARACTER_SHEET_PROMPT:
// hàng 1 = front/3-4 trái/3-4 phải, hàng 2 = nghiêng/sau lưng/cận mặt) thành 6 ảnh riêng theo toạ độ
// cố định — không cần AI "nhìn" ảnh để tìm vị trí từng góc, vì bố cục luôn giống nhau khi CHÍNH APP
// tự vẽ ra sheet này. CHỈ dùng cho sheet do app tạo (character_source = 'generated') — sheet khách tự
// tải lên (uploaded_sheet) không đảm bảo đúng bố cục 3x2 này nên không cắt, để null.
async function cropCharacterSheetIntoAngles(sheetUrl: string, userId: string): Promise<CharacterAngleUrls | null> {
  // Log rõ từng lý do fail — không để im lặng trả null như failJob() từng làm với ffmpeg trước đây,
  // khiến không biết bucket chưa tạo (migration chưa chạy) hay lỗi thật khác đang xảy ra.
  try {
    const res = await fetch(sheetUrl);
    if (!res.ok) {
      console.error(`[crop-character] Tải ảnh sheet thất bại: ${res.status} ${sheetUrl}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) {
      console.error(`[crop-character] Không đọc được kích thước ảnh sheet: ${sheetUrl}`);
      return null;
    }

    const cellWidth = Math.floor(metadata.width / 3);
    const cellHeight = Math.floor(metadata.height / 2);
    const supabase = getSupabaseAdmin();
    const urls: Partial<CharacterAngleUrls> = {};

    for (let i = 0; i < CHARACTER_ANGLE_LABELS.length; i++) {
      const label = CHARACTER_ANGLE_LABELS[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const cropped = await sharp(buffer)
        .extract({ left: col * cellWidth, top: row * cellHeight, width: cellWidth, height: cellHeight })
        .jpeg({ quality: 90 })
        .toBuffer();
      const filePath = `${userId}/${label}-${randomUUID()}.jpg`;
      const { error } = await supabase.storage
        .from("story-video-character-angles")
        .upload(filePath, cropped, { contentType: "image/jpeg", upsert: true });
      if (error) {
        console.error(`[crop-character] Upload "${label}" lỗi (có thể do chưa chạy migration tạo bucket): ${error.message}`);
        return null;
      }
      const { data: publicUrlData } = supabase.storage.from("story-video-character-angles").getPublicUrl(filePath);
      urls[label] = publicUrlData.publicUrl;
    }
    return urls as CharacterAngleUrls;
  } catch (err) {
    console.error(`[crop-character] Lỗi cắt Character sheet:`, err);
    return null;
  }
}

// Gọi khi Fal.ai tạo xong ảnh Character sheet -> dừng ở "character_ready" chờ khách xem trước, bấm
// "Tạo lại" hoặc "Tiếp tục chia cảnh". characterPosition (tuỳ chọn) = job nhiều nhân vật, cập nhật
// đúng 1 hàng story_video_job_characters thay vì cột job-level (job 1 nhân vật vẫn dùng job-level như
// trước, không có tham số này).
export async function applyCharacterStageResult(
  jobId: number,
  falPayload: Record<string, unknown>,
  characterPosition?: number
) {
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (characterPosition !== undefined) {
    if (isError) {
      // Log FULL payload (không chỉ falPayload.error, chuỗi ngắn kiểu "Unexpected status code: 422" không
      // đủ chẩn đoán được nguyên nhân thật) — mirror đúng cách đã làm cho lỗi tạo ảnh/video/lồng tiếng cảnh,
      // bước tạo Character trước đây bị sót.
      console.error(`[story-video] Lỗi tạo Character #${characterPosition + 1}, full payload:`, JSON.stringify(falPayload));
      await failJob(jobId, `Lỗi tạo Character #${characterPosition + 1}: ${String(falPayload.error ?? "")}`);
      return;
    }
    const imageUrl = extractImageUrl(falPayload);
    if (!imageUrl) {
      await failJob(jobId, `Không tìm thấy URL ảnh Character #${characterPosition + 1} trong phản hồi Fal.ai`);
      return;
    }
    const { data: jobRow } = await supabase.from("story_video_jobs").select("user_id").eq("id", jobId).single();
    const angleUrls = jobRow ? await cropCharacterSheetIntoAngles(imageUrl, jobRow.user_id) : null;
    await supabase
      .from("story_video_job_characters")
      .update({ character_sheet_url: imageUrl, character_angle_urls: angleUrls })
      .eq("job_id", jobId)
      .eq("position", characterPosition);

    const { data: rows } = await supabase.from("story_video_job_characters").select("character_sheet_url").eq("job_id", jobId);
    if (rows && rows.length > 0 && rows.every((r) => r.character_sheet_url)) {
      await supabase.from("story_video_jobs").update({ status: "character_ready" }).eq("id", jobId);
    }
    return;
  }

  if (isError) {
    // Log FULL payload (không chỉ falPayload.error, chuỗi ngắn kiểu "Unexpected status code: 422" không đủ
    // chẩn đoán được nguyên nhân thật) — mirror đúng cách đã làm cho lỗi tạo ảnh/video/lồng tiếng cảnh, bước
    // tạo Character (luồng 1 nhân vật) trước đây bị sót. Xác nhận thật qua job #156: webhook báo lỗi này
    // nhưng khi tra thẳng request_id qua Fal.ai API sau đó thì request lại ĐÃ "COMPLETED" — khả năng cao là
    // lỗi tạm thời phía provider (Fal.ai/model) tự phục hồi sau webhook đầu, nhưng app không có gì để biết
    // vì chưa từng log payload đầy đủ ở bước này.
    console.error(`[story-video] Lỗi tạo Character, full payload:`, JSON.stringify(falPayload));
    await failJob(jobId, `Lỗi tạo Character: ${String(falPayload.error ?? "")}`);
    return;
  }

  const imageUrl = extractImageUrl(falPayload);
  if (!imageUrl) {
    await failJob(jobId, "Không tìm thấy URL ảnh Character trong phản hồi Fal.ai");
    return;
  }

  const { data: jobRow } = await supabase.from("story_video_jobs").select("user_id").eq("id", jobId).single();
  const angleUrls = jobRow ? await cropCharacterSheetIntoAngles(imageUrl, jobRow.user_id) : null;

  await supabase
    .from("story_video_jobs")
    .update({ status: "character_ready", character_sheet_url: imageUrl, character_angle_urls: angleUrls })
    .eq("id", jobId);
}

// Gọi khi 1 ảnh giữ nhân vật (bước 1) của 1 cảnh tạo xong. Khi TẤT CẢ cảnh xong: nếu job bật
// auto_video thì chuyển thẳng sang bước video, ngược lại DỪNG ở "images_ready" chờ khách xem trước
// rồi tự bấm "Tạo video" (continueStoryVideoToVideoStage).
// isRegenerate=true khi webhook này đến từ regenerateSceneImage (tạo lại riêng 1 cảnh, xem
// &regen=1 trong URL webhook) — job lúc đó đã ở "images_ready"/"failed" từ trước, KHÔNG được đụng vào
// status job hay chạy failJob (sẽ hoàn nhầm toàn bộ credit job + xoá mất kết quả các cảnh khác) chỉ vì
// 1 lượt tạo lại lỗi/xong — chỉ cập nhật đúng ảnh của cảnh đó rồi dừng.
export async function applyImageStageResult(
  jobId: number,
  sceneId: number,
  falPayload: Record<string, unknown>,
  isRegenerate = false,
  stage: "image" | "image_end" = "image",
  propagateToSceneId?: number
) {
  if (await isJobCancelled(jobId)) return; // khách đã bấm "Dừng tạo" — bỏ qua hoàn toàn kết quả này
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    // Log FULL payload (không chỉ falPayload.error, chuỗi ngắn kiểu "Unexpected status code: 403"
    // không đủ chẩn đoán được nguyên nhân thật — model bị chặn, tham số sai, hay lý do khác) — mirror
    // đúng cách đã làm cho lỗi lồng tiếng (applyLipsyncStageResult) trước đây.
    console.error(`[story-video] Lỗi tạo ảnh cảnh #${sceneId} (stage=${stage}), full payload:`, JSON.stringify(falPayload));
    if (isRegenerate) {
      console.error(`[story-video] Lỗi tạo lại ảnh cho cảnh #${sceneId}:`, falPayload.error ?? "unknown");
      return;
    }
    await failJob(jobId, `Lỗi tạo ảnh cảnh: ${String(falPayload.error ?? "")}`);
    return;
  }

  const imageUrl = extractImageUrl(falPayload);
  if (!imageUrl) {
    if (isRegenerate) {
      console.error(`[story-video] Không tìm thấy URL ảnh khi tạo lại cảnh #${sceneId}`);
      return;
    }
    await failJob(jobId, "Không tìm thấy URL ảnh trong phản hồi Fal.ai");
    return;
  }

  // Chặn "thành công giả" — Fal.ai trả URL ảnh thật nhưng nội dung là 1 màu đen đồng nhất (bộ lọc nội
  // dung nội bộ chặn ngầm, không báo lỗi qua API) — xem chú thích checkImageNotBlank(). Coi như lỗi
  // thật (không được để job tự đi tiếp dùng ảnh hỏng làm nền cho video/cảnh sau).
  try {
    const blankCheck = await checkImageNotBlank(imageUrl);
    if (!blankCheck.ok) {
      console.error(`[story-video] Ảnh cảnh #${sceneId} (stage=${stage}) bị đen/hỏng: ${blankCheck.issue}`);
      if (isRegenerate) return;
      await failJob(jobId, `Ảnh phân cảnh bị lỗi (ảnh đen/trống): ${blankCheck.issue ?? ""}`);
      return;
    }
  } catch (err) {
    // Lỗi khi GỌI kiểm tra (vd OpenRouter tạm lỗi) không được chặn cả job — bỏ qua, coi như ảnh ổn,
    // để không biến 1 tính năng an toàn phụ thành điểm chặn job diện rộng.
    console.error(`[story-video] Lỗi kiểm tra ảnh đen cho cảnh #${sceneId}, coi như đạt:`, err);
  }

  await supabase.from("story_video_scenes").update(stage === "image_end" ? { end_image_url: imageUrl } : { image_url: imageUrl }).eq("id", sceneId);

  // Frame-chaining — hoàn toàn tách khỏi luồng song song bên dưới (không dùng RPC "đủ ảnh chưa", vì
  // ảnh của các cảnh sau CHƯA TỒN TẠI ở thời điểm này, tạo tuần tự từng cảnh một). isRegenerate=true ở
  // đây KHÔNG phải khách bấm nút (chưa có UI đó cho v1) — là do chính applyFrameChainImageResult tự gọi
  // lại để vẽ lại ảnh khi lưới kiểm tra danh tính phát hiện sai người, nên vẫn phải xử lý tiếp bình
  // thường (không được return sớm), không như nhánh continuous_motion cũ (isRegenerate luôn từ UI khách).
  {
    const { data: chainJob } = await supabase.from("story_video_jobs").select("frame_chain_mode").eq("id", jobId).single();
    if (chainJob?.frame_chain_mode) {
      await applyFrameChainImageResult(jobId, sceneId);
      return;
    }
  }

  if (isRegenerate) {
    // Tạo lại ảnh CUỐI 1 cảnh trong chế độ chuyển động liên tục (regenerateContinuousMotionSceneImage) —
    // ảnh này còn được dùng làm ảnh ĐẦU của cảnh kế tiếp (đã copy lúc tạo lần đầu), nên phải copy đè
    // URL mới sang luôn, không thì cảnh kế tiếp vẫn giữ ảnh cũ/lỗi dù cảnh này đã tạo lại xong.
    if (propagateToSceneId) {
      await supabase.from("story_video_scenes").update({ image_url: imageUrl }).eq("id", propagateToSceneId);
    }
    return;
  }

  const scenes = await getScenes(jobId);

  // Chuỗi liên tục: ảnh CUỐI của cảnh này vừa xong -> dùng làm ảnh ĐẦU của cảnh kế tiếp (nếu có),
  // không tốn thêm lượt gọi Fal.ai nào — chỉ copy URL.
  if (stage === "image_end") {
    const thisScene = scenes.find((s) => s.id === sceneId);
    const nextScene = thisScene ? scenes.find((s) => s.position === thisScene.position + 1) : undefined;
    if (nextScene && !nextScene.image_url) {
      await supabase.from("story_video_scenes").update({ image_url: imageUrl }).eq("id", nextScene.id);
      nextScene.image_url = imageUrl; // giữ mảng scenes trong bộ nhớ khớp DB cho check "đủ cảnh chưa" dưới đây
    }
  }

  // Chốt "đủ ảnh chưa" bằng 1 RPC atomic (khoá dòng job ở DB) thay vì đọc-rồi-so-sánh ở phía JS —
  // nhiều webhook ảnh của cùng job có thể đến gần như cùng lúc (7 lệnh song song khi continuous
  // motion), đọc-rồi-so-sánh ở JS có thể khiến KHÔNG webhook nào tự nhận là "cái cuối cùng" và job
  // kẹt mãi dù ảnh đã đủ. Xem migration-story-video-atomic-images-ready.sql.
  const { data: becameReady, error: claimError } = await supabase.rpc("try_mark_story_video_images_ready", { p_job_id: jobId });
  if (claimError) {
    console.error(`[story-video] Lỗi kiểm tra hoàn tất ảnh cho job #${jobId}:`, claimError.message);
    return;
  }
  if (!becameReady) return; // hoặc chưa đủ cảnh, hoặc job khác đã chuyển status trước rồi

  const { data: job } = await supabase.from("story_video_jobs").select("auto_video").eq("id", jobId).single();
  if (job?.auto_video) {
    await proceedToVideoStage(jobId, scenes);
  }
}

type VideoSceneRefRow = {
  id: number;
  image_url: string | null;
  scene_description: string | null;
  motion_prompt: string | null;
  motion_duration_key?: string | null;
  natural_duration_seconds?: number | null;
  end_image_url?: string | null;
  dialogue_line?: string | null;
  camera_movement?: string | null;
};

// Build prompt (ưu tiên motion_prompt đã sinh riêng cho video, fallback scene_description nếu thiếu —
// vd job cũ tạo trước khi có cột này) + submit Fal.ai cho ĐÚNG 1 cảnh — dùng chung cho batch tạo lần
// đầu (proceedToVideoStage) và tạo lại riêng lẻ 1 cảnh (regenerateSceneVideo). regen=true thêm cờ
// &regen=1 vào webhook URL để applyVideoStageResult biết đây là tạo lại 1 cảnh, không phải lượt đầu.
async function submitSceneVideoForRow(
  job: Pick<
    JobRow,
    "id" | "video_model" | "aspect_ratio" | "video_duration_key" | "character_sheet_url" | "character_angle_urls"
  >,
  row: VideoSceneRefRow,
  regen: boolean
): Promise<string> {
  const basePrompt = row.motion_prompt ?? row.scene_description;
  // Cảnh có ảnh CUỐI riêng (chế độ chuyển động liên tục, Kling O1 FLFV) — model nội suy chuyển động
  // THẬT giữa 2 khung hình khác nhau, nên KHÔNG dùng câu chỉ dẫn "chỉ hoạt náo nhẹ, giữ nguyên mọi
  // thứ" (mâu thuẫn với việc 2 khung hình vốn khác nhau). Cảnh câm 1 ảnh (đa số model khác) vẫn giữ
  // nguyên câu chỉ dẫn cũ — khách từng phản ánh bối cảnh/nền bị trôi lệch khi model tự "hoạt náo".
  let prompt = row.end_image_url
    ? basePrompt
    : basePrompt
      ? `${basePrompt} Keep the background, environment, lighting, and every object in the scene exactly the same as the reference image — do not change or add anything to the setting, only animate with subtle natural motion.`
      : basePrompt;
  // Mức thời lượng gửi model (generation) làm tròn theo catalog, có thể DÀI HƠN nhu cầu thật
  // (natural_duration_seconds, Motion Timing Controller ước lượng) — vd natural 6s nhưng model chỉ có
  // 4s/8s nên chọn 8s. Không đụng gì tới cảnh có ảnh cuối riêng (end_image_url, model nội suy giữa 2
  // khung hình, khái niệm "giữ nguyên tư thế cuối" không áp dụng). MIỄN PHÍ (không đổi mức duration đã
  // chọn, không tốn thêm credit) — chỉ thêm chỉ dẫn rồi cắt (trim) phần dư sau khi tải về (xem
  // stitchAndFinish), thay vì để model tự bịa thêm chuyển động cho đủ thời lượng dư (đã ghi chú
  // "aimless/drifting" ở SCENE_PROMPT_FROM_IMAGE_SYSTEM).
  const resolvedDurationKey = row.motion_duration_key ?? job.video_duration_key;
  const generationSeconds = resolvedDurationKey ? Number(resolvedDurationKey) : undefined;
  if (!row.end_image_url && prompt && row.natural_duration_seconds && generationSeconds && generationSeconds > row.natural_duration_seconds) {
    prompt = `${prompt} Complete the entire described motion within the first ${row.natural_duration_seconds} seconds, then hold completely still in that final pose for the rest of the clip — no new movement, no repeated motion, no drifting.`;
  }
  // Chuyển động máy quay (camera_movement) — Agent đã chọn lúc chia cảnh, tiêm thẳng bằng code (không
  // qua LLM), bỏ qua khi "static" (không cần thêm câu gì).
  if (prompt) prompt += CAMERA_MOVEMENT_PROMPT_TEXT[resolveCameraMovement(row.camera_movement)];
  // Model tự sinh giọng (H3 Max) — nhét THẲNG nguyên văn câu thoại tiếng Việt vào prompt bằng code (không
  // qua LLM viết lại, tránh rủi ro bị dịch/diễn đạt lại khác câu gốc — đúng triết lý isVerbatimQuoteInStory
  // đã áp dụng cho luồng TTS/LipSync cũ). Model tự tạo giọng + khớp môi theo đúng câu này, không cần
  // ElevenLabs/Kling LipSync riêng nữa (xem sceneNeedsLipsync).
  if (row.dialogue_line?.trim() && NATIVE_DIALOGUE_VIDEO_MODELS.has(job.video_model as string) && prompt) {
    prompt = `${prompt} The character speaks naturally, in Vietnamese, saying exactly: "${row.dialogue_line.trim()}"`;
  }
  // Chỉ 2 model đã kiểm chứng thật (xem buildVideoRequestBody) mới chấp nhận ảnh Character làm căn cứ
  // lúc TẠO VIDEO — so trực tiếp theo model string, không cần tra lại catalog ở tầng thấp này (đúng
  // cách các nhánh model-riêng khác trong file đang làm, vd FLFV/veo lite).
  const needsCharacterReference =
    job.video_model === "fal-ai/kling-video/o1/reference-to-video" || job.video_model === "fal-ai/veo3.1/reference-to-video";
  const characterReference = needsCharacterReference
    ? selectCharacterReferenceImages(job.character_angle_urls, job.character_sheet_url)
    : undefined;
  const body = buildVideoRequestBody(
    job.video_model as string,
    prompt,
    row.image_url as string,
    job.aspect_ratio ?? "9:16",
    // Motion Timing Controller: dùng mức thời lượng riêng đã ước lượng cho ĐÚNG cảnh này nếu có, rơi về
    // mức chung của job (hành vi cũ) khi cảnh chưa có/không áp dụng được (vd chế độ chuyển động liên tục).
    row.motion_duration_key ?? job.video_duration_key ?? undefined,
    row.end_image_url ?? undefined,
    characterReference
  );
  return submitFalJob(
    job.video_model as string,
    body,
    `${SITE_URL}/api/story-video/webhook?jobId=${job.id}&sceneId=${row.id}&stage=video${regen ? "&regen=1" : ""}`
  );
}

// Sinh giọng đọc (ElevenLabs, tái dùng nguyên lib/elevenlabs.ts của "Video đồng nhất nhân vật") +
// submit Kling LipSync cho ĐÚNG 1 cảnh có lời thoại — chạy SAU khi clip video câm (bước trước) đã có
// video_url. Chỉ gọi khi scene có dialogue_line VÀ mini_app đã cấu hình lipsync_model.
async function submitSceneLipsyncForRow(
  jobId: number,
  sceneId: number,
  lipsyncModel: string,
  videoUrl: string,
  dialogueLine: string,
  voiceId: string,
  regen: boolean,
  // Độ dài THẬT (giây) của video câm vừa render (motion_duration_key) — truyền xuống để pad audio khớp
  // hết clip, không chỉ đủ ngưỡng tối thiểu 2.2s của Kling (xem chú thích trong lib/elevenlabs.ts).
  videoDurationSeconds?: number
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const audioUrl = await generateVietnameseSpeech(dialogueLine, voiceId, jobId, sceneId, "story-video", videoDurationSeconds);
  const requestId = await submitFalJob(
    lipsyncModel,
    { video_url: videoUrl, audio_url: audioUrl },
    `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&sceneId=${sceneId}&stage=lipsync${regen ? "&regen=1" : ""}`
  );
  await supabase.from("story_video_scenes").update({ dialogue_audio_url: audioUrl, lipsync_fal_request_id: requestId }).eq("id", sceneId);
}

// Model video TỰ sinh giọng nói + khớp môi ngay trong lúc tạo video (đã xác nhận qua test thật của anh
// với tiếng Việt) — cảnh dùng model này có dialogue_line vẫn giữ nguyên (để nhét thẳng câu thoại vào
// prompt, xem submitSceneVideoForRow), nhưng KHÔNG chạy qua bước TTS (ElevenLabs) + Kling LipSync riêng
// như các model khác — sceneNeedsLipsync() phải trả false cho model này dù scene có dialogue_line.
const NATIVE_DIALOGUE_VIDEO_MODELS = new Set(["minimax/h3-max/image-to-video"]);

// Cảnh có coi là "cần chờ lồng tiếng mới xong" hay không — cần đồng bộ giữa applyVideoStageResult,
// applyLipsyncStageResult và resolveStoryVideoJob nên tách riêng 1 hàm dùng chung.
function sceneNeedsLipsync(
  scene: Pick<SceneRow, "dialogue_line">,
  lipsyncModel: string | undefined,
  videoModel?: string | null
): boolean {
  return !!scene.dialogue_line && !!lipsyncModel && !(videoModel && NATIVE_DIALOGUE_VIDEO_MODELS.has(videoModel));
}

async function proceedToVideoStage(jobId: number, scenes: SceneRow[]) {
  const supabase = getSupabaseAdmin();
  try {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select(
        "user_id, mini_app_id, video_model, aspect_ratio, video_duration_key, story_description, genre_key, continuous_motion, character_sheet_url, character_angle_urls, item_reference_urls"
      )
      .eq("id", jobId)
      .single();
    if (!job?.video_model) throw new Error("Không tìm thấy model video của job");
    const hasItemReference = (job.item_reference_urls?.length ?? 0) > 0;

    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const genreStyleGuide = resolveGenreStyleGuide(job.genre_key, miniApp.model_config.genre_style_guides);
    // Motion Timing Controller — chỉ áp dụng cho luồng AI tự vẽ ảnh MẶC ĐỊNH (không phải chế độ chuyển
    // động liên tục Kling O1 FLFV, nơi thời lượng đã cố định 5s gắn liền với cặp ảnh đầu/cuối theo đúng
    // thiết kế riêng của chế độ đó — xem migration-story-video-continuous-motion.sql).
    const videoEntry = job.continuous_motion
      ? undefined
      : miniApp.model_config.video_models.find((m) => m.model === job.video_model);

    // Trừ credit lồng tiếng RIÊNG, 1 lần cho cả job — chỉ tính được chính xác ở đây vì lúc này Agent
    // đã chia cảnh xong nên đã biết đúng số cảnh có dialogue_line (không đoán trước lúc submit).
    // Idempotency key cố định theo jobId để lỡ hàm này chạy 2 lần (race hiếm) không bị trừ trùng.
    // Model tự sinh giọng (NATIVE_DIALOGUE_VIDEO_MODELS) không cần khoản phụ phí này — chi phí đã nằm
    // sẵn trong provider_cost_vnd/giây của chính model đó, không gọi ElevenLabs/Kling LipSync riêng.
    const isNativeDialogueModel = NATIVE_DIALOGUE_VIDEO_MODELS.has(job.video_model);
    const lipsyncModel = miniApp.model_config.lipsync_model;
    const lipsyncCostVnd = miniApp.model_config.lipsync_provider_cost_vnd;
    const dialogueScenes = !isNativeDialogueModel && lipsyncModel && lipsyncCostVnd ? scenes.filter((s) => s.dialogue_line) : [];
    if (dialogueScenes.length > 0) {
      const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
      const lipsyncCost = computeDynamicCreditCost(lipsyncCostVnd! * dialogueScenes.length, marginPercent, vndPerCredit);
      const deduction = await deductCredit(job.user_id, lipsyncCost, job.mini_app_id, `story-video-lipsync-${jobId}`);
      if (deduction.success) {
        await supabase.from("story_video_jobs").update({ lipsync_credit_tx_id: deduction.txId }).eq("id", jobId);
      } else {
        // Không đủ credit cho phần lồng tiếng — coi các cảnh đó là câm để job vẫn chạy tiếp bình
        // thường, không chặn cả job chỉ vì thiếu credit phần bổ sung này.
        const dialogueSceneIds = dialogueScenes.map((s) => s.id);
        await supabase.from("story_video_scenes").update({ dialogue_line: null }).in("id", dialogueSceneIds);
        scenes.forEach((s) => {
          if (dialogueSceneIds.includes(s.id)) s.dialogue_line = null;
        });
      }
    }

    await Promise.all(
      scenes.map(async (scene) => {
        // Sinh mô tả CHUYỂN ĐỘNG riêng cho video (khác mô tả ảnh tĩnh scene_description) — chỉ cần cho
        // luồng AI tự vẽ ảnh (camera_view có giá trị). Luồng "khách tự tải ảnh phân cảnh" đã ghi thẳng
        // mô tả chuyển động vào scene_description ngay từ bước tạo (không có camera_view), dùng lại
        // luôn, không gọi AI thêm lần nữa.
        let motionPrompt = scene.motion_prompt;
        let motionDurationKey = scene.motion_duration_key;
        let naturalDurationSeconds = scene.natural_duration_seconds;
        if (!motionPrompt) {
          if (scene.camera_view) {
            const previousScene = scenes.find((s) => s.position === scene.position - 1);
            const plan = await generateSceneDescriptionFromImage(
              scene.image_url as string,
              scene.scene_description ?? undefined,
              job.story_description,
              undefined,
              genreStyleGuide,
              miniApp.model_config.motion_planner_prompt,
              { previousCameraView: previousScene?.camera_view, currentCameraView: scene.camera_view },
              naturalDurationSeconds ?? undefined,
              scene.pace as "fast" | "normal" | "slow" | null,
              scene.rotation_degrees,
              hasItemReference,
              // Model tự sinh giọng (H3 Max): KHÔNG áp dụng chỉ dẫn "đừng mô tả nói xuyên suốt" — model
              // này cần nói tự nhiên đúng theo lời thoại thật (tự tạo giọng + khớp môi), khác hẳn nhóm
              // model câm cần giữ miệng nghỉ để chờ Kling LipSync xử lý riêng sau.
              isNativeDialogueModel ? undefined : scene.dialogue_line
            );
            motionPrompt = plan.motionPrompt;
            // Motion Timing Controller: tái dùng đúng lượt gọi AI vừa viết motion_prompt để chọn luôn
            // mức thời lượng phù hợp cho cảnh này, không tốn thêm lượt gọi/chi phí nào. KHÔNG ghi đè
            // nếu bước "Tạo kịch bản" đã khoá sẵn (motion_duration_key có giá trị từ trước) — giá đã
            // hiện cho khách trước khi trả tiền dựa trên mức đó, ghi đè sẽ làm giá thật lệch giá đã hiện.
            if (!motionDurationKey) {
              motionDurationKey = resolveNearestDurationKey(videoEntry?.duration_price_vnd, plan.durationSeconds) ?? null;
              naturalDurationSeconds = plan.durationSeconds ?? null;
            }
          } else {
            motionPrompt = scene.scene_description;
          }
          await supabase
            .from("story_video_scenes")
            .update({ motion_prompt: motionPrompt, motion_duration_key: motionDurationKey, natural_duration_seconds: naturalDurationSeconds })
            .eq("id", scene.id);
        }
        const requestId = await submitSceneVideoForRow(
          {
            id: jobId,
            video_model: job.video_model,
            aspect_ratio: job.aspect_ratio,
            video_duration_key: job.video_duration_key,
            character_sheet_url: job.character_sheet_url,
            character_angle_urls: job.character_angle_urls,
          },
          {
            id: scene.id,
            image_url: scene.image_url,
            scene_description: scene.scene_description,
            motion_prompt: motionPrompt,
            motion_duration_key: motionDurationKey,
            natural_duration_seconds: naturalDurationSeconds,
            end_image_url: scene.end_image_url,
            dialogue_line: scene.dialogue_line,
            camera_movement: scene.camera_movement,
          },
          false
        );
        await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", scene.id);
      })
    );

    // Xoá error_message cũ (nếu đây là lượt thử lại sau khi job từng "failed" ở bước video trước đó) —
    // không xoá thì job chuyển lại "generating_videos" nhưng vẫn còn lỗi cũ trong DB, gây hiểu nhầm job
    // bị kẹt mâu thuẫn (status đang chạy nhưng error_message vẫn còn từ lần lỗi trước).
    await supabase.from("story_video_jobs").update({ status: "generating_videos", error_message: null }).eq("id", jobId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

// Khách chỉ ưng 1 phần video phân cảnh — tạo lại ĐÚNG 1 cảnh (không đụng các cảnh khác), trừ credit
// đúng bằng giá 1 cảnh video (không phải cả N cảnh). Mặc định dùng lại nguyên motion_prompt đã sinh
// sẵn — nhưng cho phép truyền customPrompt để đổi câu mô tả trước khi tạo lại, vì nhiều lỗi (model
// video từ chối nội dung, vd Veo "no_media_generated") lặp lại y hệt nếu gửi lại đúng câu cũ — khách
// cần cơ hội né đúng chỗ bị chặn thay vì tạo lại vô ích với input giống hệt lần fail.
export async function regenerateSceneVideo(
  userId: string,
  sceneId: number,
  idempotencyKey: string,
  customPrompt?: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: sceneData } = await supabase
    .from("story_video_scenes")
    .select("id, job_id, image_url, end_image_url, scene_description, motion_prompt, motion_duration_key, camera_movement, dialogue_line")
    .eq("id", sceneId)
    .single();
  if (!sceneData) throw new Error("Không tìm thấy phân cảnh");
  if (!sceneData.image_url) throw new Error("Cảnh này chưa có ảnh để tạo video");
  if (customPrompt?.trim()) sceneData.motion_prompt = customPrompt.trim();

  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", sceneData.job_id).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với phân cảnh này");
  if (!job.video_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá video của job");
  if (!job.video_model) throw new Error("Không tìm thấy model video của job");

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  let cost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene, marginPercent, vndPerCredit);

  // Cảnh có lời thoại — tạo lại video câm nghĩa là phải lồng tiếng lại từ đầu (applyVideoStageResult
  // tự làm khi nhận video mới), cộng thêm đúng phí lồng tiếng cho 1 cảnh này (không nhân num_scenes
  // như lúc submit batch ở proceedToVideoStage). Model tự sinh giọng (H3 Max) không có bước lồng tiếng
  // riêng nên không cộng phụ phí này.
  if (sceneData.dialogue_line && !NATIVE_DIALOGUE_VIDEO_MODELS.has(job.video_model)) {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    if (miniApp.model_config.lipsync_model && miniApp.model_config.lipsync_provider_cost_vnd) {
      cost += computeDynamicCreditCost(miniApp.model_config.lipsync_provider_cost_vnd, marginPercent, vndPerCredit);
    }
  }

  const deduction = await deductCredit(userId, cost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const requestId = await submitSceneVideoForRow(job, sceneData, true);
    // Xoá bản lồng tiếng cũ (nếu có) — gắn với video câm CŨ, không còn khớp với video mới sắp tạo;
    // để nguyên sẽ khiến stitchAndFinish lỡ dùng nhầm bản lồng tiếng cũ (lipsync_url ?? video_url).
    await supabase
      .from("story_video_scenes")
      .update({
        video_fal_request_id: requestId,
        video_url: null,
        lipsync_url: null,
        lipsync_fal_request_id: null,
        dialogue_audio_url: null,
        ...(customPrompt?.trim() ? { motion_prompt: sceneData.motion_prompt } : {}),
      })
      .eq("id", sceneId);
  } catch (err) {
    if (deduction.txId) await refundCredit(deduction.txId);
    throw err;
  }

  return { newBalance: deduction.newBalance };
}

// Khách bấm "Tạo video" sau khi xem ảnh phân cảnh (job đang ở "images_ready") — trừ riêng phần credit
// video (đã snapshot provider_cost_vnd/cảnh lúc submit, không phụ thuộc catalog hiện tại) rồi mới
// submit các job video.
export async function continueStoryVideoToVideoStage(userId: string, jobId: number, idempotencyKey: string): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  const job = jobData as JobRow;

  if (job.user_id !== userId) throw new Error("Không có quyền với job này");
  if (job.status !== "images_ready") {
    // Cho phép THỬ LẠI khi job đã "failed" nhưng ảnh phân cảnh đã tạo xong đầy đủ trước đó (lỗi xảy
    // ra ở bước tạo VIDEO sau đó, không phải ở bước ảnh) — tránh bắt khách làm lại từ đầu (tải ảnh
    // nhân vật, tạo Character, chia cảnh...) dù ảnh đã có sẵn và còn dùng được.
    const scenes = job.status === "failed" ? await getScenes(jobId) : [];
    const imagesAllReady = scenes.length > 0 && scenes.every((s) => s.image_url);
    if (!imagesAllReady) throw new Error("Job không ở trạng thái sẵn sàng tạo video");
  }
  if (!job.video_provider_cost_vnd_per_scene) throw new Error("Thiếu dữ liệu giá video của job");

  // Luồng "ảnh phân cảnh tự tải lên" (submitStoryVideoJobWithOwnImages) đã trừ credit video ngay lúc
  // submit (không có nấc ảnh riêng để trừ sau) — nếu trừ thêm ở đây sẽ tính tiền 2 lần cho cùng 1 lượt
  // tạo video. Chỉ trừ credit ở đây khi job CHƯA có video_credit_tx_id (đúng luồng AI tự tạo ảnh).
  let newBalance: number;
  const scenes = await getScenes(jobId);
  if (job.video_credit_tx_id) {
    newBalance = await getCreditBalance(userId);
  } else {
    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    // Bước "Tạo kịch bản" đã khoá motion_duration_key riêng từng cảnh TRƯỚC khi tới đây (proceedToVideoStage
    // chưa chạy, chỉ nó mới điền motion_duration_key cho luồng cũ) — nếu MỌI cảnh đã có sẵn, đây chắc
    // chắn là job dùng kịch bản mới -> phải cộng đúng giá thật từng cảnh (mỗi cảnh có thể khác duration_key),
    // không dùng công thức phẳng "1 giá x N cảnh" (sai khi các cảnh dùng mức thời lượng khác nhau).
    const flatVideoProviderCostVndPerScene = job.video_provider_cost_vnd_per_scene;
    let videoProviderCostVndTotal = flatVideoProviderCostVndPerScene * job.num_scenes;
    if (scenes.length > 0 && scenes.every((s) => s.motion_duration_key)) {
      const miniApp = await getMiniAppModelConfig(job.mini_app_id);
      const videoEntry = miniApp.model_config.video_models.find((m) => m.model === job.video_model);
      const durationMap = videoEntry?.duration_price_vnd;
      videoProviderCostVndTotal = scenes.reduce(
        (sum, s) => sum + (durationMap?.[s.motion_duration_key as string] ?? flatVideoProviderCostVndPerScene),
        0
      );
    }
    const videoCost = computeDynamicCreditCost(videoProviderCostVndTotal, marginPercent, vndPerCredit);

    const deduction = await deductCredit(userId, videoCost, job.mini_app_id, idempotencyKey);
    if (!deduction.success) throw new InsufficientCreditError();

    await supabase.from("story_video_jobs").update({ video_credit_tx_id: deduction.txId }).eq("id", jobId);
    newBalance = deduction.newBalance;
  }

  await proceedToVideoStage(jobId, scenes);

  return { newBalance };
}

// Gọi khi 1 clip video (bước 2) của 1 cảnh xong — khi TẤT CẢ cảnh xong mới ghép lại thành video cuối.
// isRegenerate=true khi webhook này đến từ regenerateSceneVideo (tạo lại riêng 1 cảnh sau khi job có
// thể đã "done"/"failed" từ trước) — lỗi ở lượt tạo lại KHÔNG được làm hỏng cả job (failJob sẽ hoàn
// nhầm toàn bộ credit + xoá kết quả các cảnh khác), chỉ log lại rồi dừng. Ngược lại, nếu tạo lại
// THÀNH CÔNG và tất cả cảnh đều đã có video (kể cả job đã "done" từ trước) vẫn ghép lại thành video
// cuối MỚI — để bản tải về luôn khớp với clip mới nhất của từng cảnh, không giữ mãi bản ghép cũ.
export async function applyVideoStageResult(
  jobId: number,
  sceneId: number,
  falPayload: Record<string, unknown>,
  isRegenerate = false
) {
  if (await isJobCancelled(jobId)) return; // khách đã bấm "Dừng tạo" — bỏ qua hoàn toàn kết quả này
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;

  if (isError) {
    // Log FULL payload (không chỉ falPayload.error, chuỗi ngắn kiểu "Unexpected status code: 422"
    // không đủ chẩn đoán được nguyên nhân thật) — mirror đúng cách đã làm cho lỗi tạo ảnh phân cảnh
    // (applyImageStageResult) và lỗi lồng tiếng (applyLipsyncStageResult), bước video trước đây bị sót.
    console.error(`[story-video] Lỗi tạo video cảnh #${sceneId}, full payload:`, JSON.stringify(falPayload));
    if (isRegenerate) {
      console.error(`[story-video] Lỗi tạo lại video cho cảnh #${sceneId}:`, falPayload.error ?? "unknown");
      return;
    }
    await failJob(jobId, `Lỗi tạo video cảnh: ${String(falPayload.error ?? "")}`);
    return;
  }

  const videoUrl = extractVideoUrl(falPayload);
  if (!videoUrl) {
    if (isRegenerate) {
      console.error(`[story-video] Không tìm thấy URL video khi tạo lại cảnh #${sceneId}`);
      return;
    }
    await failJob(jobId, "Không tìm thấy URL video trong phản hồi Fal.ai");
    return;
  }

  await supabase.from("story_video_scenes").update({ video_url: videoUrl }).eq("id", sceneId);

  const { data: job } = await supabase.from("story_video_jobs").select("mini_app_id, frame_chain_mode, video_model").eq("id", jobId).single();

  // Frame-chaining — hoàn toàn tách khỏi luồng song song bên dưới (không chờ "đủ cảnh", tự nối tiếp
  // tuần tự sang cảnh kế bằng khung hình THẬT vừa render ra). "Tạo lại" (isRegenerate) VẪN tiếp tục
  // chuỗi khi an toàn (xem chú thích trong applyFrameChainVideoResult) — hàm đó tự quyết định dừng lại
  // nếu cảnh sau đã có ảnh từ trước (tránh cascade). Lồng tiếng (nếu cảnh có dialogue_line) submit
  // SONG SONG ngay dưới đây, KHÔNG chặn chuỗi — Kling LipSync chỉ chỉnh miệng trên video CÓ SẴN, không
  // đổi khung hình nên không ảnh hưởng continuity; điều kiện "đủ cảnh chưa" trước khi ghép (nhánh cảnh
  // cuối trong applyFrameChainVideoResult + applyLipsyncStageResult) tự chờ đúng cảnh lồng tiếng xong.
  if (job?.frame_chain_mode) {
    await applyFrameChainVideoResult(jobId, sceneId, videoUrl, isRegenerate);

    const lipsyncModel = job ? (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model : undefined;
    const { data: sceneForLipsync } = await supabase
      .from("story_video_scenes")
      .select("id, dialogue_line, dialogue_speaker_position, motion_duration_key")
      .eq("id", sceneId)
      .single();
    if (sceneForLipsync && sceneNeedsLipsync(sceneForLipsync, lipsyncModel, job?.video_model)) {
      try {
        const voiceId = CHARACTER_VOICE_IDS[(sceneForLipsync.dialogue_speaker_position ?? 0) % CHARACTER_VOICE_IDS.length];
        const parsedDuration = sceneForLipsync.motion_duration_key ? Number(sceneForLipsync.motion_duration_key) : NaN;
        await submitSceneLipsyncForRow(
          jobId,
          sceneId,
          lipsyncModel as string,
          videoUrl,
          sceneForLipsync.dialogue_line as string,
          voiceId,
          isRegenerate,
          Number.isFinite(parsedDuration) ? parsedDuration : undefined
        );
      } catch (err) {
        console.error(`[story-video] Lỗi lồng tiếng cảnh #${sceneId} (frame-chain), dùng video câm thay thế:`, err);
        if (!isRegenerate) {
          await supabase.from("story_video_scenes").update({ dialogue_line: null }).eq("id", sceneId);
        }
      }
    }
    return;
  }

  const lipsyncModel = job ? (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model : undefined;

  const scenes = await getScenes(jobId);
  const scene = scenes.find((s) => s.id === sceneId);

  if (scene && sceneNeedsLipsync(scene, lipsyncModel, job?.video_model)) {
    try {
      const voiceId = CHARACTER_VOICE_IDS[(scene.dialogue_speaker_position ?? 0) % CHARACTER_VOICE_IDS.length];
      const parsedDuration = scene.motion_duration_key ? Number(scene.motion_duration_key) : NaN;
      await submitSceneLipsyncForRow(
        jobId,
        sceneId,
        lipsyncModel as string,
        videoUrl,
        scene.dialogue_line as string,
        voiceId,
        isRegenerate,
        Number.isFinite(parsedDuration) ? parsedDuration : undefined
      );
      return; // cảnh này còn chờ bước lồng tiếng, chưa tính là xong
    } catch (err) {
      console.error(`[story-video] Lỗi lồng tiếng cảnh #${sceneId}, dùng video câm thay thế:`, err);
      if (isRegenerate) return;
      // Không lồng tiếng được (vd ElevenLabs hết hạn mức/lỗi tạm thời) — dùng video câm đã có (đã
      // set video_url ở trên), không chặn cả job chỉ vì lỗi ở bước bổ sung này. Null dialogue_line để
      // sceneNeedsLipsync() coi cảnh này đã xong (video_url), không chờ lipsync_url không bao giờ tới.
      await supabase.from("story_video_scenes").update({ dialogue_line: null }).eq("id", sceneId);
      scene.dialogue_line = null;
    }
  }

  if (scenes.length === 0 || scenes.some((s) => (sceneNeedsLipsync(s, lipsyncModel, job?.video_model) ? !s.lipsync_url : !s.video_url))) return; // chờ cảnh còn lại

  await stitchAndFinish(jobId, scenes);
}

// Frame-chaining — cảnh vừa có ảnh xong -> submit video ngay, không có gì để chờ (khác continuous
// motion cần chờ đủ ảnh đầu+cuối trước khi submit video). Dùng cho cả cảnh đầu tiên (runSceneStage)
// lẫn các cảnh sau (applyFrameChainVideoResult gọi lại đúng đường này qua applyImageStageResult).
// Lưới an toàn lớp 2 cho frame-chaining — tối đa số lần vẽ lại (dùng lại đúng khung hình chain cũ) khi
// phát hiện sai danh tính, trước khi chấp nhận quay về ảnh Character gốc (mất liền mạch tư thế/bối
// cảnh ở đúng 1 cảnh đó, nhưng chắc chắn đúng mặt) — xem applyFrameChainImageResult().
const MAX_IDENTITY_RETRY = 2;

// Điều kiện dùng THẲNG ảnh Character gốc (góc "front" sạch) làm ảnh của 1 cảnh Frame-chain, bỏ qua cả
// AI vẽ lại LẪN nối khung hình thật (last-frame) — dùng chung cho MỌI cảnh (không riêng cảnh 1 nữa, xem
// applyFrameChainVideoResult): mỗi cảnh đủ điều kiện đều neo lại đúng 1 ảnh gốc sạch thay vì khung hình
// vừa render (có thể tự trôi nhẹ qua nhiều lượt sinh video liên tiếp — trôi mặt CỘNG DỒN qua chuỗi dài
// là đúng rủi ro cốt lõi của cơ chế frame-chain). Đổi lại: mất tính liền mạch bối cảnh/tư thế giữa cảnh
// đó với cảnh liền trước (model phải tự "dịch chuyển" nhân vật sang bối cảnh mới chỉ từ prompt) — đã
// xác nhận qua test thật là H3 Max làm được việc này tốt (ưu tiên prompt hơn ảnh nền đầu vào). Chỉ áp
// dụng khi: đúng model đã kiểm chứng, có ảnh góc front sạch (character_source="generated"), cảnh này
// không cần đổi trang phục/vật phẩm riêng/địa điểm thật riêng (những thứ cần ghép ảnh, model video
// không tự làm được từ 1 ảnh chân dung đơn).
function resolveCharacterPhotoDirectlyUrl(
  job: Pick<JobRow, "video_model" | "character_angle_urls" | "item_reference_urls" | "location_reference_url">,
  scene: { camera_view: string | null; outfit_override: string | null }
): string | undefined {
  const frontAngleUrl = (job.character_angle_urls as CharacterAngleUrls | null)?.front;
  if (
    job.video_model === "minimax/h3-max/image-to-video" &&
    !!frontAngleUrl &&
    scene.camera_view === "front" &&
    !scene.outfit_override &&
    (job.item_reference_urls?.length ?? 0) === 0 &&
    !job.location_reference_url
  ) {
    return frontAngleUrl;
  }
  return undefined;
}

// Lưới an toàn lớp 2 — dùng chung cho CẢ 2 nơi tạo ảnh cảnh chain: (a) đường vẽ lại bằng AI (khi Vision
// phát hiện sai danh tính, xem bên dưới), (b) đường ghép ảnh THẬT trực tiếp mới thêm (applyFrameChainVideoResult).
// Trả về true = danh tính ổn, cứ submit video luôn; false = đã tự gửi yêu cầu vẽ lại ảnh khác (bằng AI),
// gọi hàm này KHÔNG được submit video — phải đợi webhook ảnh mới quay lại gọi applyFrameChainImageResult.
async function checkFrameChainIdentity(
  jobId: number,
  scene: {
    id: number;
    position: number;
    image_url: string | null;
    scene_description: string | null;
    motion_prompt: string | null;
    camera_view: string | null;
    shot_size: string | null;
    camera_angle: string | null;
    face_view: string | null;
    outfit_override: string | null;
    location: string | null;
    identity_retry_count: number | null;
  },
  job: Pick<
    JobRow,
    | "id"
    | "mini_app_id"
    | "image_model"
    | "aspect_ratio"
    | "image_resolution_key"
    | "character_sheet_url"
    | "character_angle_urls"
    | "location_reference_url"
    | "location_reference_mask_url"
    | "item_reference_urls"
  >
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // Chỉ kiểm tra từ cảnh thứ 2 trở đi (cảnh có thật sự dùng khung hình chain) — cảnh đầu tiên dùng
  // đúng ảnh Character gốc như luồng thường, không có gì để trôi danh tính. Bỏ qua nếu đã vượt số lần
  // thử tối đa (đã dùng phương án dự phòng ở lượt trước) — chấp nhận kết quả hiện có, không lặp vô hạn.
  const retryCount = scene.identity_retry_count ?? 0;
  if (!(scene.position > 0 && job.character_sheet_url && scene.image_url && retryCount <= MAX_IDENTITY_RETRY)) {
    return true;
  }

  let identityOk = true;
  let issue: string | undefined;
  try {
    const faceReference = (job.character_angle_urls as CharacterAngleUrls | null)?.front || job.character_sheet_url;
    const check = await checkSceneIdentityMatch(faceReference, scene.image_url as string, job.mini_app_id);
    identityOk = check.ok;
    issue = check.issue;
  } catch (err) {
    console.error(`[story-video] Lỗi kiểm tra danh tính cảnh #${scene.id}, coi như đạt:`, err);
  }
  if (identityOk) return true;

  try {
    const miniApp = await getMiniAppModelConfig(job.mini_app_id);
    const imageEntry = miniApp.model_config.image_models.find((m) => m.model === job.image_model);
    if (retryCount < MAX_IDENTITY_RETRY) {
      console.error(`[story-video] Frame-chain cảnh #${scene.id} nghi sai danh tính (lần ${retryCount + 1}): ${issue}`);
      const { data: prevScene } = await supabase
        .from("story_video_scenes")
        .select("last_frame_url")
        .eq("job_id", jobId)
        .eq("position", scene.position - 1)
        .maybeSingle();
      const requestId = await submitSceneImageForRow(
        job, scene, imageEntry, true, "image", undefined, undefined, prevScene?.last_frame_url ?? undefined
      );
      await supabase
        .from("story_video_scenes")
        .update({ identity_retry_count: retryCount + 1, image_url: null, image_fal_request_id: requestId })
        .eq("id", scene.id);
    } else {
      // Hết số lần thử — quay về ảnh Character gốc (bỏ khung hình chain) cho ĐÚNG cảnh này, đảm bảo
      // đúng mặt dù mất liền mạch tư thế/bối cảnh ở đúng 1 cảnh đó. Đánh dấu vượt ngưỡng để lần webhook
      // tới (kết quả của lượt vẽ này) không kiểm tra lại nữa, tránh lặp vô hạn nếu vẫn lỡ sai.
      console.error(`[story-video] Cảnh #${scene.id} hết lượt thử, quay về ảnh Character gốc.`);
      const requestId = await submitSceneImageForRow(job, scene, imageEntry, true, "image");
      await supabase
        .from("story_video_scenes")
        .update({ identity_retry_count: MAX_IDENTITY_RETRY + 1, image_url: null, image_fal_request_id: requestId })
        .eq("id", scene.id);
    }
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
  return false;
}

// Motion Timing Controller (Frame-chain) — công bằng theo mức thực dùng: job đã trừ credit lúc submit
// dựa trên đúng 1 mức thời lượng cố định (video_provider_cost_vnd_per_scene, tính theo video_duration_key
// khách chọn). Nếu AI ước lượng ra 1 mức ĐẮT HƠN cho cảnh này, trừ thêm đúng phần chênh lệch trước khi
// dùng mức đó — không đủ credit cho phần chênh thì rơi về null (submitSceneVideoForRow tự dùng lại
// job.video_duration_key khách đã chọn/trả tiền, chấp nhận cảnh đó có thể hơi giật thay vì âm tiền nền tảng).
// Nếu AI ước lượng ra mức RẺ HƠN, dùng thẳng luôn — không hoàn lại phần chênh (khách đã trả trước, giữ
// đơn giản, đúng như luồng mặc định proceedToVideoStage đang chấp nhận).
async function resolveFrameChainDurationKey(
  job: Pick<JobRow, "user_id" | "mini_app_id" | "video_provider_cost_vnd_per_scene">,
  videoEntry: VideoModelEntry | undefined,
  motionDurationKey: string | null,
  sceneId: number
): Promise<string | null> {
  if (!motionDurationKey || !videoEntry?.duration_price_vnd) return motionDurationKey;
  const newCostVnd = videoEntry.duration_price_vnd[motionDurationKey];
  const alreadyPaidVnd = job.video_provider_cost_vnd_per_scene;
  if (!newCostVnd || !alreadyPaidVnd || newCostVnd <= alreadyPaidVnd) return motionDurationKey;
  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  const surcharge = computeDynamicCreditCost(newCostVnd - alreadyPaidVnd, marginPercent, vndPerCredit);
  const deduction = await deductCredit(job.user_id, surcharge, job.mini_app_id, `story-video-duration-${sceneId}`);
  return deduction.success ? motionDurationKey : null;
}

async function applyFrameChainImageResult(jobId: number, sceneId: number) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select(
      "id, user_id, mini_app_id, video_model, aspect_ratio, video_duration_key, image_model, image_resolution_key, character_sheet_url, character_angle_urls, location_reference_url, location_reference_mask_url, item_reference_urls, story_description, genre_key, video_provider_cost_vnd_per_scene"
    )
    .eq("id", jobId)
    .single();
  const { data: scene } = await supabase
    .from("story_video_scenes")
    .select(
      "id, position, image_url, scene_description, motion_prompt, motion_duration_key, natural_duration_seconds, pace, rotation_degrees, camera_view, shot_size, camera_angle, camera_movement, face_view, outfit_override, location, identity_retry_count"
    )
    .eq("id", sceneId)
    .single();
  if (!job || !scene) return;

  if (!(await checkFrameChainIdentity(jobId, scene, job))) return; // đợi webhook ảnh mới, chưa submit video vội

  try {
    // Motion Timing Controller — trước đây chế độ Frame-chain gọi thẳng submitSceneVideoForRow, bỏ qua
    // hoàn toàn bước AI xem ảnh viết mô tả chuyển động + ước lượng thời lượng riêng (chỉ chạy ở
    // proceedToVideoStage, luồng mặc định) — mọi cảnh Frame-chain đều dùng chung đúng 1 mức thời lượng
    // job.video_duration_key, không phân biệt cảnh nào chuyển động ít/nhiều. Bổ sung đúng bước đó ở đây.
    if (!scene.motion_prompt && scene.image_url) {
      const miniApp = await getMiniAppModelConfig(job.mini_app_id);
      const genreStyleGuide = resolveGenreStyleGuide(job.genre_key, miniApp.model_config.genre_style_guides);
      const videoEntry = miniApp.model_config.video_models.find((m) => m.model === job.video_model);
      const plan = await generateSceneDescriptionFromImage(
        scene.image_url,
        scene.scene_description ?? undefined,
        job.story_description,
        undefined,
        genreStyleGuide,
        miniApp.model_config.motion_planner_prompt,
        undefined,
        scene.natural_duration_seconds ?? undefined,
        scene.pace as "fast" | "normal" | "slow" | null,
        scene.rotation_degrees,
        (job.item_reference_urls?.length ?? 0) > 0
      );
      // Bước "Tạo kịch bản" có thể đã khoá sẵn motion_duration_key + trừ đúng giá thật lúc runSceneStage
      // — KHÔNG ước lượng/trừ phụ phí lại ở đây nữa (resolveFrameChainDurationKey có thể trừ thêm tiền,
      // sẽ tính trùng nếu cảnh này đã được tính giá trong plan.totalVideoProviderCostVnd).
      let motionDurationKey = scene.motion_duration_key;
      if (!motionDurationKey) {
        const estimatedDurationKey = resolveNearestDurationKey(videoEntry?.duration_price_vnd, plan.durationSeconds) ?? null;
        motionDurationKey = await resolveFrameChainDurationKey(job, videoEntry, estimatedDurationKey, sceneId);
      }
      scene.motion_prompt = plan.motionPrompt;
      scene.motion_duration_key = motionDurationKey;
      scene.natural_duration_seconds = scene.natural_duration_seconds ?? plan.durationSeconds ?? null;
      await supabase
        .from("story_video_scenes")
        .update({ motion_prompt: plan.motionPrompt, motion_duration_key: motionDurationKey, natural_duration_seconds: scene.natural_duration_seconds })
        .eq("id", sceneId);
    }
    const requestId = await submitSceneVideoForRow(job, scene, false);
    await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", sceneId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

// Cảnh CUỐI chuỗi Frame-chain không có "cảnh kế" để checkFrameChainIdentity gác trước khi dùng khung
// hình vừa tách — nhưng chính khung hình đó (mặt nhân vật) vẫn có thể đã trôi NGAY TRONG LÚC model video
// tự sinh chuyển động (khác lỗi AI vẽ ảnh tĩnh sai mặt, đã có lưới chặn riêng ở checkFrameChainIdentity)
// — xác nhận thật qua job #153 (H3 Max): khung ĐẦU video khớp mặt gốc (đã qua checkFrameChainIdentity ở
// cảnh trước) nhưng khung CUỐI (lúc nhân vật cười to) bị lệch. Vì đây là cảnh cuối, không có ảnh nào để
// "vẽ lại" cho cảnh sau — cách sửa duy nhất là tạo lại chính video này (dùng lại đúng ảnh đầu vào đã xác
// nhận đúng mặt, không vẽ ảnh mới, không tốn thêm credit ảnh). Dùng chung identity_retry_count với
// checkFrameChainIdentity — coi là 1 ngân sách "số lần phải can thiệp vì nghi lệch mặt" cho cả cảnh.
async function checkFinalSceneVideoIdentity(jobId: number, sceneId: number, lastFrameUrl: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select("id, mini_app_id, video_model, aspect_ratio, video_duration_key, character_sheet_url, character_angle_urls")
    .eq("id", jobId)
    .single();
  const { data: scene } = await supabase
    .from("story_video_scenes")
    .select(
      "id, image_url, end_image_url, motion_prompt, scene_description, motion_duration_key, natural_duration_seconds, dialogue_line, identity_retry_count"
    )
    .eq("id", sceneId)
    .single();
  if (!job || !scene || !job.character_sheet_url) return true;
  const retryCount = scene.identity_retry_count ?? 0;
  if (retryCount > MAX_IDENTITY_RETRY) return true;

  let identityOk = true;
  try {
    const faceReference = (job.character_angle_urls as CharacterAngleUrls | null)?.front || job.character_sheet_url;
    const check = await checkSceneIdentityMatch(faceReference, lastFrameUrl, job.mini_app_id);
    identityOk = check.ok;
    if (!identityOk) {
      console.error(`[story-video] Cảnh cuối #${sceneId} nghi mặt trôi trong lúc quay (lần ${retryCount + 1}): ${check.issue}`);
    }
  } catch (err) {
    console.error(`[story-video] Lỗi kiểm tra danh tính khung cuối cảnh #${sceneId}, coi như đạt:`, err);
    return true;
  }
  if (identityOk) return true;

  if (retryCount >= MAX_IDENTITY_RETRY) {
    console.error(`[story-video] Cảnh cuối #${sceneId} hết lượt thử lại video, chấp nhận kết quả hiện có.`);
    await supabase.from("story_video_scenes").update({ identity_retry_count: MAX_IDENTITY_RETRY + 1 }).eq("id", sceneId);
    return true;
  }

  try {
    const requestId = await submitSceneVideoForRow(job, scene, true);
    await supabase
      .from("story_video_scenes")
      .update({ identity_retry_count: retryCount + 1, video_url: null, video_fal_request_id: requestId })
      .eq("id", sceneId);
  } catch (err) {
    console.error(`[story-video] Lỗi tạo lại video cảnh cuối #${sceneId} sau khi phát hiện lệch mặt:`, err);
    return true; // không chặn cứng — dùng video hiện có thay vì kẹt job
  }
  return false; // đã submit lại video, đợi webhook mới, KHÔNG ghép ngay
}

// Video cảnh N vừa render xong -> tách khung hình cuối THẬT (extractLastFrame) -> hoặc submit ảnh cảnh
// N+1 dùng khung hình đó làm mỏ neo (chainedFrameUrl), hoặc nếu là cảnh cuối cùng thì ghép video luôn.
// isRegenerate=true khi gọi từ "Tạo lại" — mặc định KHÔNG tiếp tục chuỗi (cảnh N+1 nếu đã có ảnh sẵn
// là dựa trên khung hình CŨ, ghi đè sẽ làm lệch chuỗi các cảnh sau nó). NHƯNG nếu cảnh N+1 CHƯA TỪNG có
// ảnh (job đang "failed", "Tạo lại" chính là cách duy nhất để job tiến tiếp) thì vẫn phải tiếp tục —
// không có gì để lệch pha, và không tiếp tục sẽ khiến job kẹt vĩnh viễn (xác nhận qua job thật #124:
// "Tạo lại" cảnh 1 thành công nhưng cảnh 2 mãi mãi không có ảnh, job không bao giờ tự hoàn thành).
async function applyFrameChainVideoResult(jobId: number, sceneId: number, videoUrl: string, isRegenerate = false) {
  const supabase = getSupabaseAdmin();
  const { data: scene } = await supabase.from("story_video_scenes").select("id, job_id, position, camera_view").eq("id", sceneId).single();
  if (!scene) return;

  let lastFrameUrl: string;
  try {
    lastFrameUrl = await extractLastFrame(videoUrl, jobId, sceneId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
    return;
  }
  await supabase.from("story_video_scenes").update({ last_frame_url: lastFrameUrl }).eq("id", sceneId);

  const { data: nextScene } = await supabase
    .from("story_video_scenes")
    .select(
      "id, position, image_url, scene_description, motion_prompt, motion_duration_key, natural_duration_seconds, pace, rotation_degrees, camera_view, shot_size, camera_angle, camera_movement, outfit_override, face_view, location, identity_retry_count"
    )
    .eq("job_id", jobId)
    .eq("position", scene.position + 1)
    .maybeSingle();

  if (nextScene?.image_url && isRegenerate) return; // cảnh sau đã có ảnh từ trước -- tránh cascade

  if (nextScene) {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select(
        "id, user_id, mini_app_id, video_model, aspect_ratio, video_duration_key, image_model, image_resolution_key, character_sheet_url, character_angle_urls, location_reference_url, location_reference_mask_url, item_reference_urls, story_description, genre_key, video_provider_cost_vnd_per_scene"
      )
      .eq("id", jobId)
      .single();
    if (!job) return;

    // Cảnh này có đủ điều kiện neo lại đúng ảnh Character gốc sạch không (xem resolveCharacterPhotoDirectlyUrl)
    // — nếu có, dùng thẳng ảnh đó, KHÔNG dùng khung hình thật vừa tách (tránh trôi mặt cộng dồn qua
    // chuỗi dài); ảnh gốc chính là ảnh tham chiếu danh tính nên không cần checkFrameChainIdentity kiểm
    // tra lại (chắc chắn khớp 100%, gọi thêm chỉ tốn 1 lượt gọi Vision vô ích). Nếu KHÔNG đủ điều kiện,
    // giữ nguyên cơ chế cũ: dùng THẲNG khung hình thật vừa tách làm ảnh đầu cảnh kế tiếp — liền mạch
    // tuyệt đối (đúng pixel, không qua AI vẽ lại nên không còn sai số bố cục/góc máy nào cả). Bản trước
    // nhờ AI "vẽ lại 1 ảnh tham khảo" khung hình này — dù đã ép prompt giữ khung hình/góc máy, vẫn chỉ
    // là xác suất theo lời model, không chắc chắn 100% (đúng phản hồi thật của user: ảnh đầu cảnh sau
    // vẫn không giống hệt khung cuối cảnh trước). Đánh đổi: mất bước AI "chỉnh lại cho đúng mặt" mỗi
    // cảnh — bù lại bằng đúng lưới an toàn danh tính đã có (checkFrameChainIdentity), chạy NGAY trên
    // khung hình thật này; nếu model video tự làm trôi mặt trong lúc quay (hiếm nhưng có thể), lưới vẫn
    // bắt được và mới nhờ AI vẽ lại làm phương án dự phòng, y hệt cơ chế cũ.
    const directPhotoUrl = resolveCharacterPhotoDirectlyUrl(job, nextScene);
    const nextImageUrl = directPhotoUrl ?? lastFrameUrl;
    await supabase.from("story_video_scenes").update({ image_url: nextImageUrl }).eq("id", nextScene.id);
    const nextSceneWithImage = { ...nextScene, image_url: nextImageUrl };

    if (!directPhotoUrl && !(await checkFrameChainIdentity(jobId, nextSceneWithImage, job))) return; // đã tự vẽ lại ảnh khác, đợi webhook ảnh mới

    try {
      // Motion Timing Controller — xem chú thích trong applyFrameChainImageResult(), đây là bản mirror
      // cho mọi cảnh TỪ CẢNH THỨ 2 trở đi (được submit từ hàm này, không phải applyFrameChainImageResult).
      if (!nextSceneWithImage.motion_prompt) {
        const miniApp = await getMiniAppModelConfig(job.mini_app_id);
        const genreStyleGuide = resolveGenreStyleGuide(job.genre_key, miniApp.model_config.genre_style_guides);
        const videoEntry = miniApp.model_config.video_models.find((m) => m.model === job.video_model);
        const plan = await generateSceneDescriptionFromImage(
          nextSceneWithImage.image_url,
          nextSceneWithImage.scene_description ?? undefined,
          job.story_description,
          undefined,
          genreStyleGuide,
          miniApp.model_config.motion_planner_prompt,
          { previousCameraView: scene.camera_view, currentCameraView: nextSceneWithImage.camera_view },
          nextSceneWithImage.natural_duration_seconds ?? undefined,
          nextSceneWithImage.pace as "fast" | "normal" | "slow" | null,
          nextSceneWithImage.rotation_degrees,
          (job.item_reference_urls?.length ?? 0) > 0
        );
        // Bước "Tạo kịch bản" có thể đã khoá sẵn motion_duration_key + trừ đúng giá thật lúc runSceneStage
        // — KHÔNG ước lượng/trừ phụ phí lại ở đây (xem chú thích tương tự trong applyFrameChainImageResult).
        let motionDurationKey = nextSceneWithImage.motion_duration_key;
        if (!motionDurationKey) {
          const estimatedDurationKey = resolveNearestDurationKey(videoEntry?.duration_price_vnd, plan.durationSeconds) ?? null;
          motionDurationKey = await resolveFrameChainDurationKey(job, videoEntry, estimatedDurationKey, nextScene.id);
        }
        nextSceneWithImage.motion_prompt = plan.motionPrompt;
        nextSceneWithImage.motion_duration_key = motionDurationKey;
        nextSceneWithImage.natural_duration_seconds = nextSceneWithImage.natural_duration_seconds ?? plan.durationSeconds ?? null;
        await supabase
          .from("story_video_scenes")
          .update({
            motion_prompt: plan.motionPrompt,
            motion_duration_key: motionDurationKey,
            natural_duration_seconds: nextSceneWithImage.natural_duration_seconds,
          })
          .eq("id", nextScene.id);
      }
      const requestId = await submitSceneVideoForRow(job, nextSceneWithImage, false);
      await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", nextScene.id);
    } catch (err) {
      await failJob(jobId, err instanceof Error ? err.message : String(err));
    }
  } else {
    // Cảnh cuối cùng của chuỗi — không có cảnh kế để checkFrameChainIdentity gác trước khi dùng khung
    // hình vừa tách, nên kiểm tra riêng khung cuối của chính cảnh này (xem checkFinalSceneVideoIdentity).
    // Lệch thì đã tự submit lại video, KHÔNG ghép ngay — đợi webhook mới quay lại đúng nhánh này.
    if (!(await checkFinalSceneVideoIdentity(jobId, sceneId, lastFrameUrl))) return;

    // Có thể còn cảnh nào đó (cảnh này hoặc cảnh trước) đang chờ webhook lồng tiếng (xem nhánh
    // frame_chain_mode trong applyVideoStageResult, giờ submit lồng tiếng song song không chặn chuỗi) —
    // dùng chung đúng điều kiện "đủ cảnh chưa" như luồng bình thường (sceneNeedsLipsync), KHÔNG ghép
    // ngay nếu còn cảnh chờ lồng tiếng; webhook lồng tiếng cuối cùng tới sau sẽ tự kiểm tra lại điều
    // kiện này và gọi ghép (xem applyLipsyncStageResult).
    const { data: jobForLipsync } = await supabase.from("story_video_jobs").select("mini_app_id, video_model").eq("id", jobId).single();
    const lipsyncModel = jobForLipsync
      ? (await getMiniAppModelConfig(jobForLipsync.mini_app_id)).model_config.lipsync_model
      : undefined;
    const scenes = await getScenes(jobId);
    if (scenes.some((s) => (sceneNeedsLipsync(s, lipsyncModel, jobForLipsync?.video_model) ? !s.lipsync_url : !s.video_url))) return; // chờ lồng tiếng cảnh còn lại
    await stitchAndFinish(jobId, scenes);
  }
}

// Gọi khi 1 cảnh đã lồng tiếng xong (bước sau video câm) — mirror applyVideoStageResult, dùng chung
// điều kiện "đủ cảnh chưa" (sceneNeedsLipsync) trước khi ghép video cuối.
export async function applyLipsyncStageResult(
  jobId: number,
  sceneId: number,
  falPayload: Record<string, unknown>,
  isRegenerate = false
) {
  if (await isJobCancelled(jobId)) return; // khách đã bấm "Dừng tạo" — bỏ qua hoàn toàn kết quả này
  const supabase = getSupabaseAdmin();
  const isError = falPayload.status === "ERROR" || !!falPayload.error;
  const lipsyncUrl = isError ? undefined : extractVideoUrl(falPayload);

  // Fal.ai từ chối job lồng tiếng (vd 422 do video/audio không khớp giới hạn của Kling LipSync) hoặc
  // không trả URL hợp lệ — cả 2 trường hợp đều chỉ là bước BỔ SUNG thất bại, video câm của đúng cảnh
  // đó (scene.video_url) đã có sẵn từ trước. Không được fail cả job vì lỗi ở bước này (mirror đúng
  // cách applyVideoStageResult xử lý khi submitSceneLipsyncForRow lỗi ngay lúc submit).
  if (isError || !lipsyncUrl) {
    // Log đầy đủ payload + video_url/audio_url đã gửi (không chỉ falPayload.error) — lần lỗi trước chỉ
    // log ra chuỗi ngắn "Unexpected status code: 422" không đủ chẩn đoán được nguyên nhân thật (video/
    // audio không khớp giới hạn Kling LipSync, hay lý do khác).
    const { data: sceneRow } = await supabase
      .from("story_video_scenes")
      .select("video_url, dialogue_audio_url")
      .eq("id", sceneId)
      .single();
    console.error(
      `[story-video] Lỗi lồng tiếng cảnh #${sceneId}, dùng video câm thay thế. video_url=${sceneRow?.video_url} audio_url=${sceneRow?.dialogue_audio_url} payload=`,
      JSON.stringify(falPayload)
    );
    if (isRegenerate) return;
    await supabase.from("story_video_scenes").update({ dialogue_line: null }).eq("id", sceneId);
  } else {
    await supabase.from("story_video_scenes").update({ lipsync_url: lipsyncUrl }).eq("id", sceneId);
  }

  const { data: job } = await supabase.from("story_video_jobs").select("mini_app_id").eq("id", jobId).single();
  const lipsyncModel = job ? (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model : undefined;
  const scenes = await getScenes(jobId);
  if (scenes.length === 0 || scenes.some((s) => (sceneNeedsLipsync(s, lipsyncModel) ? !s.lipsync_url : !s.video_url))) return; // chờ cảnh còn lại

  await stitchAndFinish(jobId, scenes);
}

// Ghép N clip (theo đúng thứ tự "position") thành 1 video liền mạch — dùng lại ffmpeg đã tích hợp
// sẵn cho tính năng "Video đồng nhất nhân vật".
// Kích thước khung ghép cuối theo đúng tỉ lệ job đã chọn — trước đây cố định 720x1280 (9:16) bất kể
// aspect_ratio thật của job, khiến job 16:9/1:1 bị ép sai tỉ lệ ở bước ghép cuối cùng.
// Trần dung lượng video ghép cuối — chừa đệm dưới giới hạn 50MB/file của Supabase Storage gói free.
const STITCH_MAX_OUTPUT_BYTES = 44 * 1024 * 1024;
const STITCH_CANVAS_BY_ASPECT_RATIO: Record<string, { width: number; height: number }> = {
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 720, height: 720 },
};

// Đọc thời lượng + có track âm thanh hay không của 1 clip bằng chính ffmpeg-static đã có sẵn (không
// thêm dependency ffprobe-static mới — dự án từng tốn nhiều công sửa lỗi ffmpeg-static bị mất quyền
// thực thi trên Vercel, không muốn lặp lại rủi ro đó với 1 binary khác). "ffmpeg -i <file>" luôn thoát
// với exit code khác 0 khi không có output, nhưng vẫn in "Duration: ..." + danh sách stream ra stderr.
// Cần biết có audio hay không vì clip video từ Fal.ai thường KHÔNG có track âm thanh (generate_audio:
// false) — chỉ những cảnh có lời thoại lồng tiếng (lipsync_url) mới có; ghép crossfade phải xử lý được
// cả trường hợp lẫn lộn trong cùng 1 job.
async function probeClip(clipPath: string): Promise<{ durationSeconds: number; hasAudio: boolean }> {
  try {
    await execFileAsync(ffmpegPath as string, ["-i", clipPath]);
    throw new Error(`Không đọc được thông tin clip: ${clipPath}`);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) throw new Error(`Không đọc được thông tin clip: ${clipPath}`);
    const durationSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
    return { durationSeconds, hasAudio };
  }
}

// Frame-chaining — tải video vừa render xong, dùng ffmpeg cắt đúng khung hình cuối THẬT (lùi 0.2s so
// với điểm kết thúc tuyệt đối vì vài model kết thúc bằng 1-2 khung đứng hình/mờ), upload lên Supabase
// Storage, trả về URL công khai để dùng làm ảnh tham chiếu cho cảnh kế tiếp. Khác hẳn continuous_motion
// (dùng ảnh AI tự đoán "end_description" TRƯỚC khi có video) — ở đây khung hình lấy từ kết quả THẬT sự
// đã render ra, đảm bảo nối tiếp chính xác 100% vì không có "đích" nào để lệch.
async function extractLastFrame(videoUrl: string, jobId: number, sceneId: number): Promise<string> {
  if (!ffmpegPath) throw new Error("Máy chủ chưa hỗ trợ tách khung hình (thiếu ffmpeg)");
  try {
    chmodSync(ffmpegPath, 0o755);
  } catch {}
  const workDir = await mkdtemp(path.join(tmpdir(), "story-video-frame-"));
  try {
    const videoPath = path.join(workDir, "clip.mp4");
    const framePath = path.join(workDir, "frame.jpg");
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error("Không tải được video để tách khung hình");
    await writeFile(videoPath, Buffer.from(await res.arrayBuffer()));
    await execFileAsync(ffmpegPath, ["-sseof", "-0.2", "-i", videoPath, "-update", "1", "-q:v", "2", "-y", framePath]);
    const frameBuffer = await readFile(framePath);
    const supabase = getSupabaseAdmin();
    const filePath = `${jobId}/last-frame-${sceneId}-${randomUUID()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("story-video-character-angles")
      .upload(filePath, frameBuffer, { contentType: "image/jpeg", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu khung hình: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from("story-video-character-angles").getPublicUrl(filePath);
    return publicUrlData.publicUrl;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Lõi ghép: chuẩn hoá từng clip (scale/pad về khung chuẩn + đồng bộ âm thanh) rồi nối cứng bằng concat demuxer.
// Dùng chung cho ghép các cảnh của 1 job (stitchAndFinish) và ghép video các CHƯƠNG của 1 dự án nhiều chương
// (stitchChapterVideos) — tách ra để 2 nơi không lệch logic. clipPaths bị xoá dần trong lúc chạy (tiết kiệm /tmp).
async function normalizeAndConcatClips(
  clipPaths: string[],
  workDir: string,
  outputPath: string,
  canvas: { width: number; height: number }
): Promise<void> {
  const ffmpeg = ffmpegPath as string;
  const scaleFilter = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  if (clipPaths.length === 1) {
    // Chỉ 1 cảnh (vd khách dùng "Ghép video, bỏ cảnh lỗi" chỉ còn đúng 1 cảnh) — không có điểm ghép
    // nào để chuyển mờ, chỉ cần chuẩn hoá kích thước.
    await execFileAsync(ffmpeg, [
      "-i", clipPaths[0], "-vf", scaleFilter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", outputPath,
    ]);
  } else {
    // Nối CỨNG (hard cut) giữa các cảnh — trước đây dùng chuyển mờ (crossfade) STITCH_FADE_SECONDS,
    // nhưng người dùng test thật (job story-121/123, nối cứng vs 0.6s vs 0.1s) xác nhận nối cứng nhìn
    // tốt hơn — bỏ hẳn crossfade. Mỗi clip chỉ scale + encode ĐÚNG 1 LẦN rồi nối bằng concat demuxer +
    // "-c copy" (không re-encode lần 2, gần như tức thời) — đơn giản và rẻ hơn nhiều so với cơ chế
    // core+transition trước đây (vốn chỉ tồn tại để làm mượt điểm nối chuyển mờ, giờ không cần nữa).
    const clipInfo = await Promise.all(clipPaths.map((p) => probeClip(p)));
    const anyHasAudio = clipInfo.some((c) => c.hasAudio);
    // Video DÀI (nhiều chương): Supabase Storage gói free giới hạn 50MB/file, video ghép ở chất lượng mặc
    // định ~0.4MB/giây (đo từ các job thật) nên quá ~105 giây sẽ vượt và upload thất bại. Chỉ khi tổng thời
    // lượng đủ dài để có nguy cơ vượt mới ép trần bitrate (VBV maxrate) cho vừa ngân sách dung lượng —
    // video ngắn giữ nguyên chất lượng cũ, không đổi gì. Sàn 500kbps để không nát hình quá mức.
    const totalSeconds = clipInfo.reduce((sum, c) => sum + c.durationSeconds, 0);
    const audioBps = anyHasAudio ? 128_000 : 0;
    const videoBudgetBps = Math.max(500_000, Math.floor((STITCH_MAX_OUTPUT_BYTES * 8) / Math.max(totalSeconds, 1)) - audioBps);
    const rateCapArgs = videoBudgetBps < 3_500_000 ? ["-maxrate", String(videoBudgetBps), "-bufsize", String(videoBudgetBps * 2)] : [];
    const encodeArgs = ["-c:v", "libx264", "-preset", "veryfast", ...rateCapArgs, "-pix_fmt", "yuv420p", ...(anyHasAudio ? ["-c:a", "aac"] : ["-an"])];

    const scaledPaths: string[] = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const outPath = path.join(workDir, `scene-${i}.mp4`);
      const filterParts = [`[0:v]${scaleFilter}[vout]`];
      const mapArgs = ["-map", "[vout]"];
      if (anyHasAudio) {
        if (clipInfo[i].hasAudio) {
          filterParts.push(`[0:a]aformat=sample_rates=44100:channel_layouts=stereo[aout]`);
        } else {
          filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${clipInfo[i].durationSeconds.toFixed(3)}[aout]`);
        }
        mapArgs.push("-map", "[aout]");
      }
      await execFileAsync(ffmpeg, [
        "-i", clipPaths[i],
        "-filter_complex", filterParts.join(";"),
        ...mapArgs,
        ...encodeArgs,
        "-y", outPath,
      ]);
      scaledPaths[i] = outPath;
      // Video dài nhiều clip: xoá ngay clip gốc đã mã hoá xong để /tmp của hàm serverless không phình lên.
      await rm(clipPaths[i], { force: true }).catch(() => {});
    }

    const listPath = path.join(workDir, "concat-list.txt");
    const listLines = scaledPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
    await writeFile(listPath, listLines.join("\n"));
    await execFileAsync(ffmpeg, ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", outputPath]);
  }
}

async function stitchAndFinish(jobId: number, scenes: SceneRow[]) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase.from("story_video_jobs").select("user_id, mini_app_id, aspect_ratio").eq("id", jobId).single();
  if (!job) return;
  const canvas = STITCH_CANVAS_BY_ASPECT_RATIO[job.aspect_ratio ?? "9:16"] ?? STITCH_CANVAS_BY_ASPECT_RATIO["9:16"];

  await supabase.from("story_video_jobs").update({ status: "stitching" }).eq("id", jobId);

  if (!ffmpegPath) {
    await failJob(jobId, "Máy chủ chưa hỗ trợ ghép video (thiếu ffmpeg)");
    return;
  }
  // ffmpeg-static hay bị mất quyền thực thi khi Next.js đóng gói binary vào Vercel serverless function
  // (chỉ copy file, không giữ nguyên mode) — chủ động cấp lại quyền trước khi spawn, tránh ENOENT/EACCES.
  try {
    chmodSync(ffmpegPath, 0o755);
  } catch {}

  const workDir = await mkdtemp(path.join(tmpdir(), "story-video-"));
  const outputPath = path.join(workDir, "output.mp4");
  const clipPaths: string[] = [];

  try {
    await Promise.all(
      scenes.map(async (scene, index) => {
        // Cảnh có lời thoại đã lồng tiếng (lipsync_url) thì dùng bản đó thay vì clip câm gốc.
        const res = await fetch(scene.lipsync_url ?? scene.video_url!);
        if (!res.ok) throw new Error(`Không tải được clip cảnh ${index + 1}`);
        let clipPath = path.join(workDir, `clip-${index}.mp4`);
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
        // Cắt bớt phần "giữ nguyên tư thế" dư ra ở cuối clip — CHỈ khi mức duration đã chọn lúc submit
        // (generation, motion_duration_key) dài hơn nhu cầu thật (natural_duration_seconds), đúng đk đã
        // thêm chỉ dẫn "hold pose" ở submitSceneVideoForRow. Không tốn thêm credit (đã trả đúng mức
        // duration này rồi khi submit) — chỉ loại phần đuôi model có thể tự bịa thêm chuyển động thừa.
        const generationSeconds = scene.motion_duration_key ? Number(scene.motion_duration_key) : undefined;
        if (scene.natural_duration_seconds && generationSeconds && generationSeconds > scene.natural_duration_seconds) {
          const targetSeconds = scene.natural_duration_seconds + 0.5; // đệm nhẹ, tránh cắt cụt lúc vừa khựng lại
          const { durationSeconds: actualSeconds } = await probeClip(clipPath);
          if (actualSeconds > targetSeconds + 0.3) {
            const trimmedPath = path.join(workDir, `clip-${index}-trimmed.mp4`);
            await execFileAsync(ffmpegPath!, ["-i", clipPath, "-t", targetSeconds.toFixed(3), "-c", "copy", "-y", trimmedPath]);
            clipPath = trimmedPath;
          }
        }
        clipPaths[index] = clipPath;
      })
    );

    await normalizeAndConcatClips(clipPaths, workDir, outputPath, canvas);

    const outputBuffer = await readFile(outputPath);
    const filePath = `${job.user_id}/story-${jobId}-${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(filePath, outputBuffer, { contentType: "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Lỗi lưu Supabase Storage: ${uploadError.message}`);

    const { data: publicUrlData } = supabase.storage.from("videos").getPublicUrl(filePath);
    await supabase.from("story_video_jobs").update({ status: "done", output_url: publicUrlData.publicUrl }).eq("id", jobId);
    await recordGenerationHistory(job.user_id, job.mini_app_id, "video", publicUrlData.publicUrl);
  } catch (err) {
    // failJob() chỉ lưu lỗi vào DB (job.error_message), không throw/log — log riêng ra đây để lỗi ghép
    // video còn xuất hiện trong Vercel error tracking, tránh lặp lại việc dò lỗi mù như lần ffmpeg ENOENT.
    console.error(`[story-video-stitch] Job #${jobId} lỗi ghép video:`, err);
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Video NHIỀU CHƯƠNG: ghép video hoàn chỉnh của từng chương (đã là mp4 ghép xong sẵn, theo đúng thứ tự
// truyền vào) thành 1 video cuối — dùng lại đúng lõi ghép của stitchAndFinish (chuẩn hoá khung + âm thanh
// im lặng cho chương không có tiếng + trần bitrate theo tổng thời lượng để vừa giới hạn 50MB/file).
export async function stitchChapterVideos(videoUrls: string[], aspectRatio: string): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("Máy chủ chưa hỗ trợ ghép video (thiếu ffmpeg)");
  try {
    chmodSync(ffmpegPath, 0o755);
  } catch {}
  const canvas = STITCH_CANVAS_BY_ASPECT_RATIO[aspectRatio] ?? STITCH_CANVAS_BY_ASPECT_RATIO["9:16"];
  const workDir = await mkdtemp(path.join(tmpdir(), "story-project-"));
  try {
    const clipPaths = await Promise.all(
      videoUrls.map(async (url, i) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Không tải được video chương ${i + 1}`);
        const clipPath = path.join(workDir, `chapter-${i}.mp4`);
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
        return clipPath;
      })
    );
    const outputPath = path.join(workDir, "output.mp4");
    await normalizeAndConcatClips(clipPaths, workDir, outputPath, canvas);
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Khách chấp nhận bỏ qua 1-vài cảnh mãi không tạo video được (vd bị model chặn nội dung, đã thử đổi
// prompt nhiều lần vẫn lỗi) — ghép video CUỐI chỉ từ những cảnh đã có video thật, bỏ hẳn cảnh lỗi thay
// vì chờ mãi không bao giờ đủ N/N cảnh để tự động ghép. stitchAndFinish() vốn chỉ lặp qua mảng scenes
// được truyền vào, không đòi hỏi liền vị trí hay đủ N cảnh — chỉ cần lọc trước khi gọi.
export async function finalizeStoryVideoSkippingFailedScenes(userId: string, jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("user_id, status").eq("id", jobId).single();
  if (!jobData) throw new Error("Không tìm thấy job");
  if (jobData.user_id !== userId) throw new Error("Không có quyền với job này");

  const scenes = await getScenes(jobId);
  const readyScenes = scenes.filter((s) => s.lipsync_url ?? s.video_url);
  if (readyScenes.length === 0) throw new Error("Chưa có cảnh nào có video để ghép");

  await stitchAndFinish(jobId, readyScenes);
}

const STALE_CHECK_MS = 30_000;
// stitchAndFinish() chạy ngay trong webhook nhận video cảnh cuối cùng, route đó giới hạn maxDuration=60s
// — tải N clip + ffmpeg re-encode + upload Storage có thể vượt quá 60s, khiến Vercel ngắt hàm giữa
// chừng và job kẹt vĩnh viễn ở "stitching" (không có cơ chế nào khác theo dõi trạng thái này). Ngưỡng
// đợi dài hơn hẳn 60s để không vô tình gọi ghép trùng khi lượt đầu vẫn đang chạy hợp lệ trong giới hạn.
const STITCH_STALE_CHECK_MS = 90_000;
// Job nhiều cảnh (video dài) ghép lâu hơn hẳn — ngưỡng "coi là kẹt" phải giãn theo số cảnh, không thì
// poll trạng thái sẽ gọi ghép trùng lúc lượt đầu vẫn đang chạy hợp lệ. Trần 330s = maxDuration 300s + đệm.
function stitchStaleThresholdMs(numScenes: number | null | undefined): number {
  return Math.min(330_000, Math.max(STITCH_STALE_CHECK_MS, (numScenes ?? 0) * 6_000 + 60_000));
}

// Xác nhận bằng gọi tay trực tiếp Fal.ai (job #70, model fal-ai/veo3.1/lite/first-last-frame-to-video):
// endpoint status/result CHỈ nhận đúng app id gốc (2 đoạn đầu, vd "fal-ai/veo3.1"), gọi bằng NGUYÊN
// path đầy đủ dùng lúc submit (có thêm "/lite/first-last-frame-to-video") trả về 405 Method Not
// Allowed — khiến hàm này coi job "chưa xong" MÃI MÃI dù Fal.ai đã xử lý xong thật từ lâu. Sửa: thử
// path đầy đủ trước (không đổi hành vi các model đang chạy đúng), chỉ fallback sang app id gốc (2 đoạn
// đầu) khi gặp đúng 405 — không đoán mò áp dụng cho mọi model, chỉ tự sửa khi có bằng chứng rõ (405).
async function pollFalResult(model: string, requestId: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) return null;

  const modelSegments = model.split("/");
  const baseApp = modelSegments.slice(0, 2).join("/");
  const buildUrls = (suffix: string) => [`https://queue.fal.run/${model}${suffix}`, `https://queue.fal.run/${baseApp}${suffix}`];

  async function getWithFallback(suffix: string): Promise<Response | null> {
    const [fullUrl, baseUrl] = buildUrls(suffix);
    const res = await fetch(fullUrl, { headers: { Authorization: `Key ${apiKey}` } });
    if (res.status === 405 && baseUrl !== fullUrl) {
      return fetch(baseUrl, { headers: { Authorization: `Key ${apiKey}` } });
    }
    return res;
  }

  const statusRes = await getWithFallback(`/requests/${requestId}/status`);
  if (!statusRes || !statusRes.ok) return null;
  const statusData = await statusRes.json();
  if (statusData.status !== "COMPLETED") return null;

  const resultRes = await getWithFallback(`/requests/${requestId}`);
  if (!resultRes) return null;
  const resultData = await resultRes.json().catch(() => null);
  if (!resultRes.ok) {
    // Request "COMPLETED" ở tầng queue nhưng bản thân hàm xử lý lỗi (vd 422 sai tham số) — Fal trả
    // thẳng body lỗi kèm mã HTTP lỗi ở đây, KHÔNG phải "chưa xong". Trước đây coi mọi !ok là null
    // (chưa xong) nên lỗi loại này không bao giờ được phát hiện, job kẹt vĩnh viễn.
    return { status: "ERROR", error: resultData ? JSON.stringify(resultData) : `HTTP ${resultRes.status}` };
  }
  return { status: "OK", payload: resultData };
}

// Chủ động hỏi lại Fal.ai nếu job có vẻ "treo" quá lâu mà chưa nhận được webhook — gọi khi frontend
// poll trạng thái, cùng cơ chế resolveDialogueVideoJob() bên lib/dialogue-video.ts. Dùng đúng
// job.image_model/job.video_model đã snapshot lúc submit, KHÔNG tra lại catalog hiện tại (catalog có
// thể đã bị admin sửa/tắt entry đó sau khi job đã chạy). "images_ready" không cần poll — job đang
// dừng chờ khách bấm nút, không có Fal.ai job nào đang treo ở trạng thái đó.
export async function resolveStoryVideoJob(jobId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: jobData } = await supabase.from("story_video_jobs").select("*").eq("id", jobId).single();
  if (!jobData) return;
  const job = jobData as JobRow;

  if (!["generating_character", "generating_images", "generating_videos", "stitching"].includes(job.status)) return;
  const ageMs = Date.now() - new Date(job.updated_at).getTime();
  const staleThreshold = job.status === "stitching" ? stitchStaleThresholdMs(job.num_scenes) : STALE_CHECK_MS;
  if (ageMs < staleThreshold) return;

  if (job.status === "generating_character") {
    if (job.character_fal_request_id) {
      const result = await pollFalResult(CHARACTER_SHEET_MODEL, job.character_fal_request_id);
      if (result) await applyCharacterStageResult(jobId, result);
    } else {
      // Job nhiều nhân vật (không có character_fal_request_id job-level) — poll từng người còn thiếu
      // sheet riêng theo story_video_job_characters.
      const { data: jobCharacters } = await supabase
        .from("story_video_job_characters")
        .select("position, character_sheet_url, character_fal_request_id")
        .eq("job_id", jobId);
      for (const jc of jobCharacters ?? []) {
        if (!jc.character_sheet_url && jc.character_fal_request_id) {
          const result = await pollFalResult(CHARACTER_SHEET_MODEL, jc.character_fal_request_id);
          if (result) await applyCharacterStageResult(jobId, result, jc.position);
        }
      }
    }
    return;
  }

  const scenes = await getScenes(jobId);

  if (job.status === "generating_images" && job.image_model) {
    for (const scene of scenes) {
      if (!scene.image_url && scene.image_fal_request_id) {
        const result = await pollFalResult(job.image_model, scene.image_fal_request_id);
        if (result) await applyImageStageResult(jobId, scene.id, result);
      }
      if (job.continuous_motion && !scene.end_image_url && scene.end_image_fal_request_id) {
        const result = await pollFalResult(job.image_model, scene.end_image_fal_request_id);
        if (result) await applyImageStageResult(jobId, scene.id, result, false, "image_end");
      }
    }
  } else if (job.status === "generating_videos" && job.video_model) {
    const lipsyncModel = (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model;
    for (const scene of scenes) {
      if (!scene.video_url && scene.video_fal_request_id) {
        const result = await pollFalResult(job.video_model, scene.video_fal_request_id);
        if (result) await applyVideoStageResult(jobId, scene.id, result);
      } else if (scene.video_url && sceneNeedsLipsync(scene, lipsyncModel, job.video_model) && !scene.lipsync_url && scene.lipsync_fal_request_id) {
        const result = await pollFalResult(lipsyncModel as string, scene.lipsync_fal_request_id);
        if (result) await applyLipsyncStageResult(jobId, scene.id, result);
      }
    }
  } else if (job.status === "stitching") {
    // Webhook nhận video cảnh cuối đã gọi stitchAndFinish nhưng có thể bị Vercel ngắt giữa chừng (xem
    // giải thích ở STITCH_STALE_CHECK_MS) — job kẹt vĩnh viễn ở "stitching" vì không còn Fal.ai job nào
    // để poll. Nếu tất cả cảnh đã sẵn sàng (video_url, hoặc lipsync_url với cảnh có thoại), thử ghép lại
    // — idempotent (tải/encode/upload lại từ đầu, ghi đè status "done" + output_url khi xong).
    const lipsyncModel = (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model;
    if (scenes.length > 0 && scenes.every((s) => (sceneNeedsLipsync(s, lipsyncModel, job.video_model) ? s.lipsync_url : s.video_url))) {
      await stitchAndFinish(jobId, scenes);
    }
  }
}
