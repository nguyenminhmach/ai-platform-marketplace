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

export type MultiCharacterInput = {
  imageUrls: string[];
  reuseCharacterId?: number;
  skipCharacterCreation?: boolean;
  label?: string;
  // Ảnh THẬT của 1 vật phẩm riêng của nhân vật này (vd đôi giày, túi xách, đồng hồ...) — tuỳ chọn, để
  // AI vẽ đúng y hệt món đó khi truyện tả nhân vật mặc/mang/cầm nó, thay vì tự bịa kiểu dáng khác. Mỗi
  // nhân vật có vật phẩm riêng (khác location_reference_url dùng chung cho cả job).
  itemReferenceUrl?: string;
};

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

const SCENE_SPLIT_SYSTEM_PROMPT = `Bạn là đạo diễn dựng phân cảnh. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (nhân vật đang làm gì, ở đâu, bối cảnh gì), giữ nguyên nhân vật chính xuyên suốt các cảnh.
Với MỖI cảnh, xác định thêm góc camera đang nhìn thấy nhân vật rõ nhất, chỉ được chọn ĐÚNG 1 trong 6 giá trị sau (viết y hệt, chữ thường): "front" (chính diện), "three_quarter_left" (nghiêng 3/4 trái), "three_quarter_right" (nghiêng 3/4 phải), "side" (nhìn ngang hẳn 1 bên), "back" (quay lưng lại camera), "face" (cận mặt).
Quy tắc khi mô tả không nói rõ góc quay: nếu không nói gì đặc biệt về hướng, mặc định "front". Nếu chỉ nói "quay đầu"/"nhìn sang" (không nói "quay người"/"quay lưng"), coi là góc "three_quarter_left" hoặc "three_quarter_right" tương ứng hướng nhìn, KHÔNG phải "back". Chỉ chọn "back" khi mô tả rõ ràng nhân vật quay LƯNG/CẢ NGƯỜI lại camera.
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
Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ gồm đúng N phần tử, mỗi phần tử là 1 object có khoá "description" (chuỗi tiếng Anh mô tả cảnh, dùng để tạo ảnh AI), "camera_view" (1 trong 6 giá trị ở trên), "outfit_override" (tuỳ chọn), "face_view" (tuỳ chọn), "dialogue" (tuỳ chọn), "location" (bắt buộc) và "end_pose" (bắt buộc) như hướng dẫn trên — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích (comment) nào trong JSON.
Ví dụ format: [{"description": "a young woman walking into a coffee shop, morning light", "camera_view": "front", "location": "a cozy coffee shop interior, window table", "end_pose": "she has just sat down and is looking around"}, {"description": "still at the coffee shop, she turns her head and looks outside the window, smiling", "camera_view": "three_quarter_left", "dialogue": "Quán này đẹp thật đấy", "location": "a cozy coffee shop interior, window table", "end_pose": "she is smiling, looking out the window"}, {"description": "later, standing by her front door at home, about to head out", "camera_view": "front", "outfit_override": "a beige knit cardigan over a white t-shirt", "location": "the front door of her home, entryway", "end_pose": "she is about to open the door and step outside"}]`;

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
      30,
      CHARACTER_CLASSIFY_SYSTEM_PROMPT,
      "Phân loại ảnh này.",
      imageUrl
    );
    // maxTokens nhỏ trước đây (10) có thể cắt cụt câu trả lời trước khi ra hết chữ "SHEET" -> nới token
    // + so khớp bằng includes (không chỉ startsWith) để không bỏ lỡ khi model có thêm chữ thừa dù đã
    // yêu cầu trả đúng 1 từ.
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

const SCENE_IDENTITY_CHECK_PROMPT = `Bạn kiểm tra xem 2 ảnh có phải CÙNG 1 người hay không. Ảnh THỨ NHẤT là ảnh gốc chuẩn của nhân vật, ảnh THỨ HAI là ảnh AI vừa vẽ ra cho 1 cảnh khác (khác tư thế/góc máy/ánh sáng).
Trả lời ĐÚNG 1 dòng JSON, không thêm chữ nào khác:
{"ok": true} nếu rõ ràng là CÙNG 1 người (dù khác góc chụp, tư thế, ánh sáng, biểu cảm), hoặc
{"ok": false, "issue": "<mô tả ngắn gọn tiếng Việt điểm khác biệt>"} nếu cấu trúc khuôn mặt (hình dáng mặt, mũi, môi, mắt) RÕ RÀNG là người khác.
Chỉ báo sai khi THẬT SỰ rõ ràng là người khác — không báo sai chỉ vì góc chụp/ánh sáng/biểu cảm khác nhau.`;

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
};

export type SceneRow = {
  id: number;
  job_id: number;
  position: number;
  scene_description: string | null;
  end_description: string | null;
  camera_view: string | null;
  outfit_override: string | null;
  face_view: string | null;
  motion_prompt: string | null;
  motion_duration_key: string | null;
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
  item_reference_url: string | null;
  continuous_motion: boolean;
  frame_chain_mode: boolean;
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
  resolutionKey?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt };
  if (multiImage) body.image_urls = characterImageUrls;
  else body.image_url = characterImageUrls[0];

  if (model === "fal-ai/gpt-image-2/edit") {
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

// Body request Fal.ai theo model video — VEO cần hậu tố "s" cho duration ("6s", không phải "6"),
// Hailuo cố định resolution "768P" để khớp đúng giá đã nghiên cứu, còn lại theo mẫu Kling/LTX sẵn có.
function buildVideoRequestBody(
  model: string,
  prompt: string | null,
  imageUrl: string,
  aspectRatio: string,
  durationKey?: string,
  endImageUrl?: string
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
  if (model === "fal-ai/kling-video/o1/standard/image-to-video") {
    // Kling O1 FLFV (First-Last-Frame-to-Video) — đã tra schema thật: nhận start_image_url (bắt
    // buộc, KHÔNG phải "image_url" như các model khác) + end_image_url (tuỳ chọn — có thì nội suy
    // chuyển động thật giữa 2 khung hình, không có thì chạy như model 1 ảnh bình thường) + duration
    // (enum "3"-"10", KHÔNG có hậu tố "s" khác VEO). Không nhận aspect_ratio (tự theo ảnh đầu vào).
    const body: Record<string, unknown> = { prompt, start_image_url: imageUrl, duration: durationKey ?? "5" };
    if (endImageUrl) body.end_image_url = endImageUrl;
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
const ALLOWED_CHAT_MODELS = ["google/gemini-3-flash-preview", "anthropic/claude-sonnet-4.6"];

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
  outfit_override?: string;
  face_view?: CharacterAngleKey;
  dialogue?: string;
  end_description?: string;
  location: string;
  end_pose: string;
};

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
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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
  frameChainMode?: boolean
): Promise<SceneSplitResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  // "Agent xử lý" — admin thêm hướng dẫn phong cách/chủ đề qua model_config.prompt_helper_instructions
  // (đúng field/UI đã dùng cho nút "AI viết giúp mô tả" ở app video-gen). Nối THÊM vào cuối, không
  // thay hẳn — bắt buộc giữ nguyên yêu cầu "chỉ trả JSON đúng N phần tử" để pipeline không gãy.
  const basePrompt = SCENE_SPLIT_SYSTEM_PROMPT.replace("N phân cảnh", `${numScenes} phân cảnh`);
  let systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  if (continuousMotion) systemPrompt += `\n\n${CONTINUOUS_MOTION_INSTRUCTION}`;
  if (frameChainMode) systemPrompt += `\n\n${FRAME_CHAIN_TURN_INSTRUCTION}`;
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
      ? `[{"description": "${characterLabels[0]} stands alone by the entrance, waiting nervously, morning light", "characters": [0], "dialogue": {"speaker": 0, "line": "Sao mãi chưa thấy ai đến vậy"}, "location": "a wedding venue entrance, evening", "end_pose": "she is glancing anxiously toward the road"}, {"description": "${characterLabels[0]} and ${characterLabels[1]} stand together, holding hands, smiling warmly", "characters": [0, 1], "location": "a wedding venue entrance, evening", "end_pose": "they are smiling at each other, hands still held"}]`
      : `[{"description": "a scene description", "characters": [0], "location": "a scene location", "end_pose": "a brief pose description"}]`;
  return `Bạn là đạo diễn dựng phân cảnh cho 1 video có NHIỀU nhân vật thật cùng xuất hiện. Người dùng đưa 1 ý tưởng truyện/kịch bản ngắn.
Danh sách nhân vật trong video này (đánh số bắt đầu từ 0): ${list}.
Nhiệm vụ: chia thành ĐÚNG N phân cảnh liên tục, mỗi cảnh là 1 khoảnh khắc hình ảnh cụ thể (ai đang làm gì, ở đâu, bối cảnh gì).
Với MỖI cảnh, xác định thêm khoá "characters": 1 mảng các SỐ (đúng chỉ số trong danh sách nhân vật ở trên) — liệt kê TẤT CẢ nhân vật thực sự xuất hiện trong khung hình của cảnh đó, có thể là 1 người hoặc nhiều người cùng lúc. Không tự thêm số ngoài danh sách, không tự bỏ sót người rõ ràng có mặt theo mô tả.
Khi viết "description" (tiếng Anh): mô tả rõ ai đang làm gì, có thể thêm chi tiết điện ảnh (ánh sáng, khung hình, không khí) phù hợp bối cảnh gốc, nhưng KHÔNG bịa thêm tình tiết/hành động/địa điểm không có trong ý tưởng gốc.
Rào chắn giữ đúng danh tính (bắt buộc): không tự đổi giới tính/độ tuổi/kiểu tóc của bất kỳ nhân vật nào đã liệt kê ở trên; không tự thêm nhân vật phụ mới ngoài danh sách; nếu ý tưởng gốc mô tả 1 địa điểm liên tục thì không tự đổi bối cảnh giữa các cảnh.
Trang phục — TUYỆT ĐỐI KHÔNG tự mô tả cụ thể màu sắc/kiểu dáng/chất liệu trang phục của bất kỳ ai trong "description" (ví dụ KHÔNG viết "a white blouse", "a red dress"...). Lý do: bạn KHÔNG nhìn thấy ảnh nhân vật thật — tự bịa màu/kiểu sẽ mâu thuẫn với ảnh tham chiếu thật. Nếu cần nhắc trang phục để giữ liên tục, chỉ viết chung chung "wearing the same outfit as before".
Trạng thái liên tục giữa các cảnh (quan trọng): MỖI cảnh được gửi cho model tạo ảnh RIÊNG BIỆT, độc lập — model đó KHÔNG thấy ảnh của cảnh trước, chỉ thấy đúng "description" của cảnh đang xét. Vì vậy mỗi "description" phải TỰ ĐẦY ĐỦ ngữ cảnh (self-contained): nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 địa điểm kế thừa từ cảnh trước, PHẢI nhắc lại rõ địa điểm/bối cảnh đó trong CHÍNH cảnh đang viết.
Tư thế/hành động nối tiếp (quan trọng, áp dụng cho MỌI cảnh không phải cảnh đầu tiên): "description" của cảnh này PHẢI bắt đầu đúng từ tư thế/hành động mà "end_pose" của cảnh NGAY TRƯỚC nó vừa mô tả — viết liền thành 1 câu tự nhiên, như đó là trạng thái hiện tại (1 khoảnh khắc duy nhất), TUYỆT ĐỐI không viết theo kiểu kể lại 2 mốc thời gian nối nhau (SAI: "she was smiling, and now she stands up"; ĐÚNG: "still smiling as she stands up from the table"). Không tự ý đặt nhân vật về lại tư thế mặc định nếu không có căn cứ đã di chuyển/đổi tư thế giữa 2 cảnh.
Không được bỏ sót hành động đổi tư thế lớn (bắt buộc): nếu ý tưởng gốc có 1 hành động đổi tư thế/trạng thái lớn của bất kỳ nhân vật nào (đứng dậy, ngồi xuống, quay người, bắt đầu di chuyển, dừng lại...), hành động đó PHẢI được thể hiện rõ trong "description" hoặc "end_pose" của ĐÚNG 1 cảnh cụ thể — không được để 2 cảnh liền kề nhảy thẳng từ tư thế này sang tư thế khác mà không cảnh nào thể hiện lúc đang chuyển. Khi số cảnh ít hơn số hành động trong ý tưởng gốc, ưu tiên gộp các hành động KHÔNG đổi tư thế lớn, tuyệt đối không gộp/bỏ qua đúng hành động CÓ đổi tư thế lớn.
Khung hình/bố cục camera nhất quán (bắt buộc, khi nhiều cảnh liên tiếp cùng 1 địa điểm): vị trí các vật thể cố định trong khung hình (bàn, cửa sổ, cửa ra vào...) và mức độ zoom/cỡ cảnh PHẢI giữ nguyên qua các cảnh đó — không được tự đổi bố cục coi như đang quay từ góc khác. Chỉ đổi khi ý tưởng gốc có lý do rõ ràng (nhân vật di chuyển sang vị trí khác, hoặc mô tả rõ máy quay lùi ra/tiến lại gần).
Không tự bịa phụ kiện/biểu cảm không có trong ý tưởng gốc nếu không có căn cứ.
Lời thoại (chỉ áp dụng khi ý tưởng gốc CÓ trích dẫn/thể hiện rõ ràng 1 nhân vật đang NÓI THÀNH LỜI ở đúng cảnh đó): thêm khoá "dialogue" là 1 object {"speaker": số (đúng chỉ số nhân vật đang nói), "line": chuỗi tiếng Việt giữ NGUYÊN VĂN lời nói, KHÔNG dịch/diễn giải lại, dưới khoảng 15 từ}. QUAN TRỌNG: chỉ được thêm "dialogue" khi mảng "characters" của cảnh đó có ĐÚNG 1 phần tử (chỉ 1 người trong khung hình) — lý do kỹ thuật: hệ thống lồng tiếng hiện chỉ khớp môi được cho video có 1 người, cảnh có từ 2 người trở lên LUÔN LUÔN không có khoá "dialogue" dù truyện gốc có viết lời thoại ở đó. Cảnh không có lời nói (hoặc có từ 2 người trở lên) thì KHÔNG thêm khoá "dialogue" (bỏ hẳn khoá này). Không tự bịa thêm lời thoại không có trong ý tưởng gốc.
Bối cảnh vật lý (bắt buộc, MỌI cảnh): thêm khoá "location" (chuỗi tiếng Anh NGẮN GỌN) mô tả nơi cảnh đang diễn ra, BAO GỒM cả ánh sáng/thời điểm trong ngày. Nếu nhiều cảnh liên tiếp cùng diễn ra ở 1 chỗ, "location" của những cảnh đó PHẢI viết Y HỆT NHAU, ĐÚNG TỪNG CHỮ (kể cả phần ánh sáng) — chỉ đổi khi ý tưởng gốc nói RÕ RÀNG có sự di chuyển sang nơi khác hoặc thời gian trôi qua rõ rệt. TUYỆT ĐỐI không tự đổi tông sáng (vd tự thêm hoàng hôn cho cảnh chia tay/rời đi) nếu truyện gốc không nói tới.
Trạng thái kết thúc cảnh (bắt buộc, MỌI cảnh): thêm khoá "end_pose" (chuỗi tiếng Anh NGẮN GỌN) mô tả tư thế/hành động của (các) nhân vật ở khoảnh khắc KẾT THÚC cảnh đó — dùng làm điểm nối sang cảnh kế tiếp.
Chỉ trả về DUY NHẤT 1 mảng JSON hợp lệ gồm đúng N phần tử, mỗi phần tử có khoá "description" (chuỗi tiếng Anh), "characters" (mảng số), "dialogue" (tuỳ chọn), "location" (bắt buộc) và "end_pose" (bắt buộc) như hướng dẫn trên — không kèm markdown fence, không giải thích, không đánh số, không có dòng chú thích (comment) nào trong JSON.
Ví dụ format: ${example}`;
}

export async function splitStoryIntoScenesMulti(
  storyDescription: string,
  numScenes: number,
  characterLabels: string[],
  customInstructions?: string,
  modelChatKey?: string,
  continuousMotion?: boolean
): Promise<MultiSceneSplitResult[]> {
  const chatModel = modelChatKey && ALLOWED_CHAT_MODELS.includes(modelChatKey) ? modelChatKey : ALLOWED_CHAT_MODELS[0];
  const basePrompt = buildMultiSceneSplitPrompt(characterLabels).replace("N phân cảnh", `${numScenes} phân cảnh`);
  let systemPrompt = customInstructions?.trim() ? `${basePrompt}\n\nGhi chú thêm từ admin: ${customInstructions.trim()}` : basePrompt;
  if (continuousMotion) systemPrompt += `\n\n${CONTINUOUS_MOTION_INSTRUCTION_MULTI}`;
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
    // Phòng thủ phía code (không chỉ dựa Agent nghe lời): cảnh ≥2 người LUÔN ép dialogue = null, kể cả
    // khi Agent lỡ trả dialogue cho cảnh đó — giới hạn kỹ thuật lipsync 1 mặt/clip là bắt buộc, không
    // phải gợi ý. Đồng thời chặn trường hợp Agent dịch câu thoại sang tiếng Anh (xem
    // isVerbatimQuoteInStory) — không khớp nguyên văn truyện gốc thì coi như không có thoại.
    return (parsed as MultiSceneSplitResult[]).map((s) => ({
      ...s,
      dialogue:
        s.characters.length === 1 && s.dialogue && isVerbatimQuoteInStory(s.dialogue.line, storyDescription)
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
  | "aspect_ratio"
  | "image_resolution_key"
  | "character_sheet_url"
  | "character_angle_urls"
  | "genre_key"
  | "location_reference_url"
  | "item_reference_url"
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
    | "item_reference_url"
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
  const hasItem = !!job.item_reference_url && (imageEntry?.multi_image ?? false);
  const hasLocation = !chainedFrameUrl && !!job.location_reference_url && (imageEntry?.multi_image ?? false);
  const referenceImages = [...characterImages];
  if (hasItem) referenceImages.push(job.item_reference_url as string);
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
  if (hasItem) {
    const idx = characterImages.length + 1;
    // Xác nhận qua phản hồi thật: câu chỉ dẫn cũ ("depict accurately") quá yếu — model vẫn vẽ ra vật
    // phẩm có kiểu/màu khác (đúng loại đồ vật, sai chi tiết thật), giống hệt lỗi trang phục đã sửa
    // trước đây. Viết mạnh hơn theo đúng công thức đã hiệu quả với outfit_override: gọi thẳng đây là
    // ẢNH THẬT của khách, liệt kê rõ các khía cạnh KHÔNG được đổi (màu/kiểu/hoạ tiết/chất liệu), và cấm
    // rõ việc vẽ 1 phiên bản "giống giống" hoặc chung chung thay cho ảnh thật.
    scenePrompt += ` Reference image #${idx} is a REAL photo of the character's own physical item (e.g. shoes, a bag, an accessory, or another object) — this is not a generic example, it is the customer's actual item. Whenever the scene description mentions the character wearing, holding, or using such an item, you MUST copy this exact real item's appearance precisely: same color, same shape/silhouette, same pattern/design details, same material/texture — exactly as shown in reference image #${idx}. Do NOT substitute a different color, a different style, a generic or similar-looking version, or any item that merely resembles it — treat matching this item's exact real appearance with the same strictness as matching the character's face.`;
  }
  if (hasLocation) {
    const idx = characterImages.length + (hasItem ? 1 : 0) + 1;
    scenePrompt += ` Reference image #${idx} shows a REAL physical location — place this scene at that exact real location, preserving its real appearance (layout, colors, decor, lighting) accurately. Do not invent a different location.`;
  }
  // Ép ảnh chụp thật — model dễ ngả sang phong cách minh hoạ/tranh vẽ khi scene_description dùng
  // ngôn từ giàu chất thơ (hoàng hôn, khu vườn hoa...) mà không có chỉ dẫn phong cách hình ảnh rõ ràng.
  scenePrompt += ` Photorealistic photo, shot on a real camera — not an illustration, painting, drawing, anime, or digital art.`;
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
    job.image_resolution_key ?? undefined
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
  item_reference_url: string | null;
};

// Reference Selector cho job NHIỀU NHÂN VẬT (Bước 2) — đơn giản hơn hẳn selectReferenceImagesForScene
// có chủ đích: mỗi người CHỈ lấy đúng 1 ảnh đại diện (góc "front" đã cắt sẵn, hoặc sheet gộp nếu thiếu
// dữ liệu góc), KHÔNG chọn theo camera_view/face_view như luồng 1 nhân vật — đúng công thức đã kiểm
// chứng qua test thật (ảnh thẳng mặt đơn giản đã ghép chung khung hình tốt, kể cả tư thế phức tạp).
function selectReferenceImagesForMultiScene(
  characterPositions: number[],
  jobCharacters: JobCharacterRefRow[]
): { url: string; label: string; itemUrl: string | null }[] {
  return characterPositions
    .map((pos) => {
      const jc = jobCharacters.find((c) => c.position === pos);
      if (!jc) return null;
      const url = jc.character_angle_urls?.front || jc.character_sheet_url || "";
      if (!url) return null;
      return { url, label: jc.label || `Nhân vật ${pos + 1}`, itemUrl: jc.item_reference_url || null };
    })
    .filter((r): r is { url: string; label: string; itemUrl: string | null } => !!r);
}

type MultiCharacterSceneRefRow = {
  id: number;
  scene_description: string | null;
  character_positions: number[] | null;
  location: string | null;
};

// Build prompt (liệt kê rõ ảnh nào ứng với ai) + submit Fal.ai cho ĐÚNG 1 cảnh nhiều nhân vật — dùng
// chung cho batch tạo lần đầu (runMultiCharacterSceneStage) và tạo lại riêng lẻ sau này (Bước 3).
// previousEndPose (Scene State — chỉ nhánh không continuousMotion mới truyền vào): xem
// buildContinuityPrefix() ở submitSceneImageForRow (cùng cơ chế, dùng chung).
async function submitMultiCharacterSceneImageForRow(
  job: Pick<JobRow, "id" | "mini_app_id" | "image_model" | "aspect_ratio" | "image_resolution_key" | "location_reference_url">,
  row: MultiCharacterSceneRefRow,
  jobCharacters: JobCharacterRefRow[],
  imageEntry: ImageModelEntry | undefined,
  regen: boolean,
  stage: "image" | "image_end" = "image",
  previousEndPose?: string | null,
  propagateToSceneId?: number
): Promise<string> {
  const refs = selectReferenceImagesForMultiScene(row.character_positions ?? [], jobCharacters);
  // Ảnh Vật phẩm riêng của từng nhân vật (tuỳ chọn) — nối vào SAU toàn bộ ảnh mặt/thân, TRƯỚC ảnh
  // Địa điểm. Chỉ những nhân vật CÓ mặt trong cảnh này (đã lọc qua "refs") và CÓ upload vật phẩm mới
  // được nối thêm — không phải cứ có upload là luôn gửi cho mọi cảnh.
  const supportsMultiImage = imageEntry?.multi_image ?? false;
  const itemRefs = supportsMultiImage ? refs.filter((r) => !!r.itemUrl) : [];
  // Ảnh Bối cảnh/Địa điểm (tuỳ chọn, dùng chung cho cả job) — nối THÊM vào cuối cùng, sau ảnh vật
  // phẩm. Chỉ gửi khi model thật sự hỗ trợ đa ảnh, không thì im lặng bỏ qua.
  const hasLocation = !!job.location_reference_url && supportsMultiImage;
  const referenceImages = [
    ...refs.map((r) => r.url),
    ...itemRefs.map((r) => r.itemUrl as string),
    ...(hasLocation ? [job.location_reference_url as string] : []),
  ];
  let scenePrompt = buildContinuityPrefix(row.location, previousEndPose) + (row.scene_description ?? "");
  if (refs.length >= 2) {
    const mapping = refs.map((r, i) => `Image ${i + 1} = ${r.label}`).join(", ");
    scenePrompt += ` Multiple reference images are provided, each showing a DIFFERENT real person: ${mapping}. Combine them so ALL of these people appear together in the scene as described — preserve each person's exact facial identity, hairstyle, and skin tone from their own reference image, do not blend or merge their faces into a single person, do not invent extra people.`;
  } else if (refs.length === 1) {
    scenePrompt += ` Use the reference image to keep ${refs[0].label}'s facial identity accurate and consistent.`;
  }
  itemRefs.forEach((r, i) => {
    const idx = refs.length + i + 1;
    // Mirror đúng câu chỉ dẫn mạnh hơn đã sửa cho luồng 1 nhân vật (submitSceneImageForRow) — cùng
    // nguyên nhân lỗi (vật phẩm ra sai màu/kiểu so với ảnh thật khách tải lên).
    scenePrompt += ` Reference image #${idx} is a REAL photo of ${r.label}'s own physical item — this is not a generic example, it is the customer's actual item. Whenever the scene description mentions ${r.label} wearing, holding, or using such an item, you MUST copy this exact real item's appearance precisely: same color, same shape/silhouette, same pattern/design details, same material/texture — exactly as shown in reference image #${idx}. Do NOT substitute a different color, a different style, a generic or similar-looking version, or any item that merely resembles it.`;
  });
  if (hasLocation) {
    scenePrompt += ` The LAST reference image shows a REAL physical location — place this scene at that exact real location, preserving its real appearance (layout, colors, decor, lighting) accurately. Do not invent a different location.`;
  }
  // Mirror đúng 2 câu chỉ dẫn đã thêm cho luồng 1 nhân vật (xem submitSceneImageForRow) — cùng nguyên
  // nhân lỗi (model tự bịa trang phục khác/gương vẽ sai mặt) cũng có thể xảy ra ở luồng nhiều nhân vật.
  scenePrompt += ` Keep the exact same clothing/outfit (garment type, color, style) for each person as shown in their own reference image — do not substitute different clothing, even if the scene's mood or setting might otherwise suggest different attire.`;
  scenePrompt += ` Photorealistic photo, shot on a real camera — not an illustration, painting, drawing, anime, or digital art.`;
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
    job.image_resolution_key ?? undefined
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
  idempotencyKey: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");
  if (!job.image_provider_cost_vnd_per_scene || !job.video_provider_cost_vnd_per_scene) {
    throw new Error("Thiếu dữ liệu giá của job");
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  // Chuỗi liên tục: N+1 ảnh cho N cảnh (không phải 2N) — xem resolveCosts().
  const imageCallCount = job.continuous_motion ? job.num_scenes + 1 : job.num_scenes;
  const imageCost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene * imageCallCount, marginPercent, vndPerCredit);
  const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

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
    // Skill "story-extractor" — chỉ dùng làm input nội bộ cho chia cảnh, không ghi đè story_description
    // đã lưu ở trên (khách vẫn thấy đúng nguyên văn mình gõ).
    const extractedStory = await extractStoryEssentials(finalStoryDescription, job.mini_app_id, modelChatKey);
    let scenes = await splitStoryIntoScenes(
      extractedStory,
      job.num_scenes,
      combinedInstructions || undefined,
      modelChatKey,
      job.continuous_motion,
      job.frame_chain_mode
    );
    // Skill "story-validator" — kiểm tra bản chia cảnh có phản ánh đúng truyện gốc không, thử chia lại
    // ĐÚNG 1 lần nếu lỗi, không chặn cứng job nếu vẫn lỗi sau lần 2 (tránh false-positive chặn oan).
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
        job.frame_chain_mode
      );
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
          outfit_override: scene.outfit_override ?? null,
          face_view: scene.face_view ?? null,
          dialogue_line: scene.dialogue?.trim() || null,
          location: scene.location,
          end_pose: scene.end_pose,
        }))
      )
      .select("id, position, scene_description, camera_view, outfit_override, face_view, location");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    if (job.frame_chain_mode) {
      // Frame-chaining (dẫn trạng thái qua khung hình THẬT) — chỉ tạo ảnh cho cảnh đầu tiên ngay bây
      // giờ. Các cảnh sau tạo TUẦN TỰ, mỗi ảnh dựa vào khung hình cuối THẬT trích từ video cảnh liền
      // trước (xem applyFrameChainVideoResult) — không thể tạo trước vì video cảnh trước chưa tồn tại.
      const firstRow = sceneRows.find((r) => r.position === 0);
      if (firstRow) {
        const requestId = await submitSceneImageForRow(job, firstRow, imageEntry, false, "image");
        await supabase.from("story_video_scenes").update({ image_fal_request_id: requestId }).eq("id", firstRow.id);
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
  continuousMotion?: boolean,
  // Frame-chaining (chỉ luồng 1 nhân vật ở v1, xem applyFrameChainVideoResult) — bỏ qua hoàn toàn nếu
  // job rơi vào nhánh nhiều nhân vật bên dưới.
  frameChainMode?: boolean,
  // Ảnh Vật phẩm riêng (tuỳ chọn) của nhân vật #1 — chỉ dùng ở nhánh 1 nhân vật bên dưới. Nhánh nhiều
  // nhân vật KHÔNG đọc tham số này — mỗi nhân vật (kể cả #1) tự có itemReferenceUrl riêng trong mảng
  // "characters" (xem MultiCharacterInput), truyền thẳng vào submitMultiCharacterStoryVideoJob.
  itemReferenceUrl?: string
): Promise<{ jobId: number; newBalance: number }> {
  if (numScenes < MIN_SCENES || numScenes > MAX_SCENES) {
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
      continuousMotion
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
  } else if (characterImageUrls.length < MIN_CHARACTER_IMAGES || characterImageUrls.length > MAX_CHARACTER_IMAGES) {
    throw new Error(`Cần từ ${MIN_CHARACTER_IMAGES} đến ${MAX_CHARACTER_IMAGES} ảnh nhân vật`);
  }

  const { imageEntry, videoEntry, imageProviderCostVnd, videoProviderCostVnd, resolvedResolutionKey, resolvedDurationKey } =
    await resolveCosts(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);

  const { data: job, error: insertError } = await supabase
    .from("story_video_jobs")
    .insert({
      user_id: userId,
      mini_app_id: miniAppId,
      status: "pending",
      story_description: storyDescription,
      num_scenes: numScenes,
      character_image_urls: characterImageUrls,
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
      item_reference_url: itemReferenceUrl ?? null,
      continuous_motion: continuousMotion === true,
      frame_chain_mode: frameChainMode === true,
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
    num_scenes: numScenes,
    image_model: imageEntry.model,
    aspect_ratio: aspectRatio,
    image_resolution_key: resolvedResolutionKey ?? null,
    character_sheet_url: null,
    character_angle_urls: null,
    genre_key: resolvedGenreKey,
    location_reference_url: locationReferenceUrl ?? null,
    item_reference_url: itemReferenceUrl ?? null,
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
        return { jobId: job.id, ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey)) };
      }
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
        await supabase
          .from("story_video_jobs")
          .update({
            status: "character_ready",
            character_sheet_url: sheetUrl,
            character_source: skipEntirely ? "skipped" : "uploaded_sheet",
          })
          .eq("id", job.id);
        if (finalStoryDescription) {
          sceneStageJob.character_sheet_url = sheetUrl;
          return { jobId: job.id, ...(await runSceneStage(userId, sceneStageJob, finalStoryDescription, modelChatKey, idempotencyKey)) };
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
  characterSource: "reused" | "uploaded_sheet" | "skipped" | "generated";
  itemReferenceUrl: string | null;
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
  continuousMotion?: boolean
): Promise<{ jobId: number; newBalance: number }> {
  const supabase = getSupabaseAdmin();

  const { imageEntry, videoEntry, imageProviderCostVnd, videoProviderCostVnd, resolvedResolutionKey, resolvedDurationKey } =
    await resolveCosts(miniAppId, numScenes, imageModelKey, videoModelKey, resolutionKey, durationKey);
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
          itemReferenceUrl: c.itemReferenceUrl ?? null,
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
          itemReferenceUrl: c.itemReferenceUrl ?? null,
        };
      }
      return {
        label,
        imageUrls,
        needsGeneration: true,
        initialSheetUrl: null,
        initialAngleUrls: null,
        characterSource: "generated",
        itemReferenceUrl: c.itemReferenceUrl ?? null,
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
      num_scenes: numScenes,
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
      continuous_motion: continuousMotion === true,
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
        item_reference_url: r.itemReferenceUrl,
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
          const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, r.imageUrls, true, "1:1", undefined);
          const requestId = await submitFalJob(
            CHARACTER_SHEET_MODEL,
            body,
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
  idempotencyKey: string
): Promise<{ newBalance: number }> {
  const supabase = getSupabaseAdmin();
  if (!job.image_provider_cost_vnd_per_scene || !job.video_provider_cost_vnd_per_scene) {
    throw new Error("Thiếu dữ liệu giá của job");
  }

  const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
  // Chuỗi liên tục: N+1 ảnh cho N cảnh (không phải 2N) — xem resolveCosts()/runSceneStage() (luồng 1
  // nhân vật đã áp dụng công thức này, đây là mirror cho nhiều nhân vật).
  const imageCallCount = job.continuous_motion ? job.num_scenes + 1 : job.num_scenes;
  const imageCost = computeDynamicCreditCost(job.image_provider_cost_vnd_per_scene * imageCallCount, marginPercent, vndPerCredit);
  const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

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
    // Skill "story-extractor" — chỉ dùng nội bộ cho chia cảnh, không ghi đè story_description đã lưu.
    const extractedStory = await extractStoryEssentials(finalStoryDescription, job.mini_app_id, modelChatKey);
    let scenes = await splitStoryIntoScenesMulti(
      extractedStory,
      job.num_scenes,
      characterLabels,
      combinedInstructions || undefined,
      modelChatKey,
      job.continuous_motion
    );
    // Skill "story-validator" — thử chia lại ĐÚNG 1 lần nếu lỗi, không chặn cứng job nếu vẫn lỗi.
    const validation = await validateSceneSplit(finalStoryDescription, scenes, job.mini_app_id, modelChatKey);
    if (!validation.ok) {
      console.error(`[story-video] story-validator báo lỗi job #${job.id}, thử chia lại 1 lần: ${validation.issue}`);
      const retryInstructions = [combinedInstructions, `Lần chia trước bị lỗi: ${validation.issue}. Sửa lại cho đúng.`]
        .filter((s): s is string => !!s?.trim())
        .join("\n\n");
      scenes = await splitStoryIntoScenesMulti(extractedStory, job.num_scenes, characterLabels, retryInstructions, modelChatKey, job.continuous_motion);
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
          dialogue_line: scene.dialogue?.line?.trim() || null,
          dialogue_speaker_position: scene.dialogue ? scene.dialogue.speaker : null,
          location: scene.location,
          end_pose: scene.end_pose,
        }))
      )
      .select("id, position, scene_description, character_positions, location");
    if (sceneError || !sceneRows) throw new Error(sceneError?.message ?? "Không tạo được phân cảnh");

    if (job.continuous_motion) {
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
    .select("position, label, character_sheet_url, character_angle_urls, item_reference_url")
    .eq("job_id", jobId)
    .order("position", { ascending: true });
  if (jobCharacters && jobCharacters.length >= 2) {
    return runMultiCharacterSceneStage(userId, job, jobCharacters as JobCharacterRefRow[], finalStoryDescription, modelChatKey, idempotencyKey);
  }

  if (!job.character_sheet_url) throw new Error("Thiếu ảnh Character của job");

  return runSceneStage(userId, job, finalStoryDescription, modelChatKey, idempotencyKey);
}

const SCENE_PROMPT_FROM_IMAGE_SYSTEM =
  `You are a screenwriter writing a short motion prompt (1-2 sentences, English) for the given image, to be used as an image-to-video generation prompt. Base it on: what's visible in the image, the overall story context provided, and the customer's hint if given.
Also estimate how many seconds of video this motion naturally needs to look smooth and natural — NOT rushed (too much motion crammed into too little time looks jerky/sped-up) and NOT padded (too little motion stretched over too much time makes the model invent extra filler motion, looking aimless/drifting). A small, subtle motion (a glance, a slight smile, a small hand gesture) typically needs only a few seconds; a larger motion (standing up, walking, turning around, sitting down) needs more.
Return ONLY 1 line of valid JSON, no markdown fence, no explanation, no comment lines: {"motion_prompt": "<the motion description>", "duration_seconds": <integer, your best estimate>}.`;

type SceneMotionPlan = { motionPrompt: string; durationSeconds?: number };

function parseSceneMotionPlan(output: string): SceneMotionPlan {
  const cleaned = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed?.motion_prompt === "string" && parsed.motion_prompt.trim()) {
      const seconds = Number(parsed.duration_seconds);
      return { motionPrompt: parsed.motion_prompt.trim(), durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined };
    }
  } catch {
    // model không trả đúng JSON -> rơi về coi nguyên câu trả lời là motion_prompt, không có gợi ý thời
    // lượng (an toàn hơn báo lỗi cả cảnh chỉ vì thiếu đúng 1 field phụ này).
  }
  return { motionPrompt: cleaned };
}

async function generateSceneDescriptionFromImage(
  imageUrl: string,
  hint: string | undefined,
  storyDescription: string,
  modelChatKey: string | undefined,
  genreStyleGuide?: string,
  skillOverride?: string
): Promise<SceneMotionPlan> {
  let systemPrompt = genreStyleGuide?.trim()
    ? `${SCENE_PROMPT_FROM_IMAGE_SYSTEM}\n\nGhi chú thêm về phong cách/nhịp điệu chuyển động cho đúng thể loại: ${genreStyleGuide.trim()}`
    : SCENE_PROMPT_FROM_IMAGE_SYSTEM;
  // Skill "motion-planner" — admin ghi thêm ghi chú qua /admin (vd luôn nhấn mạnh chuyển động camera).
  if (skillOverride?.trim()) systemPrompt += `\n\nGhi chú thêm từ admin: ${skillOverride.trim()}`;
  const userPrompt = `Ý tưởng truyện tổng thể: ${storyDescription}${hint ? `\nGợi ý riêng cho cảnh này: ${hint}` : ""}\nViết mô tả chuyển động ngắn cho ảnh này.`;
  const { output } = await callOpenRouter(modelChatKey || "google/gemini-3-flash-preview", 150, systemPrompt, userPrompt, imageUrl);
  return parseSceneMotionPlan(output);
}

// Motion Timing Controller: model video chỉ nhận 1 trong các mức thời lượng rời rạc catalog cho phép
// (vd "5"/"8" giây) -- tìm mức GẦN NHẤT với số giây skill motion-planner vừa ước lượng cho đúng cảnh
// đó. Trả undefined nếu model không có bảng giá theo thời lượng (chỉ 1 mức cố định, không có gì để
// chọn) hoặc chưa ước lượng được số giây -- cả 2 trường hợp đều rơi về video_duration_key của job.
function resolveNearestDurationKey(durationPriceMap: Record<string, number> | undefined, seconds: number | undefined): string | undefined {
  if (!durationPriceMap || seconds === undefined) return undefined;
  const keys = Object.keys(durationPriceMap);
  if (keys.length === 0) return undefined;
  return keys.reduce((closest, key) => (Math.abs(Number(key) - seconds) < Math.abs(Number(closest) - seconds) ? key : closest));
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
    .select("id, job_id, position, scene_description, camera_view, outfit_override, face_view, character_positions, location")
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
        .select("position, label, character_sheet_url, character_angle_urls, item_reference_url")
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
        .select("position, label, character_sheet_url, character_angle_urls, item_reference_url")
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
  if (!job.character_image_urls || job.character_image_urls.length === 0) {
    throw new Error("Job này không có ảnh gốc để tạo lại (đang dùng Character đã lưu từ thư viện)");
  }

  const { creditCost } = await computeCharacterCreditCost();
  const deduction = await deductCredit(userId, creditCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const characterPrompt = await resolveCharacterPrompt(job.mini_app_id);
    const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, job.character_image_urls, true, "1:1", undefined);
    const requestId = await submitFalJob(CHARACTER_SHEET_MODEL, body, `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character`);
    await supabase
      .from("story_video_jobs")
      .update({
        status: "generating_character",
        character_source: "generated",
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
    .select("id, source_image_urls")
    .eq("job_id", jobId)
    .eq("position", position)
    .single();
  if (!jobCharacter) throw new Error("Không tìm thấy nhân vật này trong job");
  if (!jobCharacter.source_image_urls || jobCharacter.source_image_urls.length === 0) {
    throw new Error("Nhân vật này không có ảnh gốc để tạo lại (đang dùng Character đã lưu từ thư viện)");
  }

  const { creditCost } = await computeCharacterCreditCost();
  const deduction = await deductCredit(userId, creditCost, job.mini_app_id, idempotencyKey);
  if (!deduction.success) throw new InsufficientCreditError();

  try {
    const characterPrompt = await resolveCharacterPrompt(job.mini_app_id);
    const body = buildImageRequestBody(CHARACTER_SHEET_MODEL, characterPrompt, jobCharacter.source_image_urls, true, "1:1", undefined);
    const requestId = await submitFalJob(
      CHARACTER_SHEET_MODEL,
      body,
      `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&stage=character&characterPosition=${position}`
    );
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
  end_image_url?: string | null;
};

// Build prompt (ưu tiên motion_prompt đã sinh riêng cho video, fallback scene_description nếu thiếu —
// vd job cũ tạo trước khi có cột này) + submit Fal.ai cho ĐÚNG 1 cảnh — dùng chung cho batch tạo lần
// đầu (proceedToVideoStage) và tạo lại riêng lẻ 1 cảnh (regenerateSceneVideo). regen=true thêm cờ
// &regen=1 vào webhook URL để applyVideoStageResult biết đây là tạo lại 1 cảnh, không phải lượt đầu.
async function submitSceneVideoForRow(
  job: Pick<JobRow, "id" | "video_model" | "aspect_ratio" | "video_duration_key">,
  row: VideoSceneRefRow,
  regen: boolean
): Promise<string> {
  const basePrompt = row.motion_prompt ?? row.scene_description;
  // Cảnh có ảnh CUỐI riêng (chế độ chuyển động liên tục, Kling O1 FLFV) — model nội suy chuyển động
  // THẬT giữa 2 khung hình khác nhau, nên KHÔNG dùng câu chỉ dẫn "chỉ hoạt náo nhẹ, giữ nguyên mọi
  // thứ" (mâu thuẫn với việc 2 khung hình vốn khác nhau). Cảnh câm 1 ảnh (đa số model khác) vẫn giữ
  // nguyên câu chỉ dẫn cũ — khách từng phản ánh bối cảnh/nền bị trôi lệch khi model tự "hoạt náo".
  const prompt = row.end_image_url
    ? basePrompt
    : basePrompt
      ? `${basePrompt} Keep the background, environment, lighting, and every object in the scene exactly the same as the reference image — do not change or add anything to the setting, only animate with subtle natural motion.`
      : basePrompt;
  const body = buildVideoRequestBody(
    job.video_model as string,
    prompt,
    row.image_url as string,
    job.aspect_ratio ?? "9:16",
    // Motion Timing Controller: dùng mức thời lượng riêng đã ước lượng cho ĐÚNG cảnh này nếu có, rơi về
    // mức chung của job (hành vi cũ) khi cảnh chưa có/không áp dụng được (vd chế độ chuyển động liên tục).
    row.motion_duration_key ?? job.video_duration_key ?? undefined,
    row.end_image_url ?? undefined
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
  regen: boolean
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const audioUrl = await generateVietnameseSpeech(dialogueLine, voiceId, jobId, sceneId, "story-video");
  const requestId = await submitFalJob(
    lipsyncModel,
    { video_url: videoUrl, audio_url: audioUrl },
    `${SITE_URL}/api/story-video/webhook?jobId=${jobId}&sceneId=${sceneId}&stage=lipsync${regen ? "&regen=1" : ""}`
  );
  await supabase.from("story_video_scenes").update({ dialogue_audio_url: audioUrl, lipsync_fal_request_id: requestId }).eq("id", sceneId);
}

// Cảnh có coi là "cần chờ lồng tiếng mới xong" hay không — cần đồng bộ giữa applyVideoStageResult,
// applyLipsyncStageResult và resolveStoryVideoJob nên tách riêng 1 hàm dùng chung.
function sceneNeedsLipsync(scene: Pick<SceneRow, "dialogue_line">, lipsyncModel: string | undefined): boolean {
  return !!scene.dialogue_line && !!lipsyncModel;
}

async function proceedToVideoStage(jobId: number, scenes: SceneRow[]) {
  const supabase = getSupabaseAdmin();
  try {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select("user_id, mini_app_id, video_model, aspect_ratio, video_duration_key, story_description, genre_key, continuous_motion")
      .eq("id", jobId)
      .single();
    if (!job?.video_model) throw new Error("Không tìm thấy model video của job");

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
    const lipsyncModel = miniApp.model_config.lipsync_model;
    const lipsyncCostVnd = miniApp.model_config.lipsync_provider_cost_vnd;
    const dialogueScenes = lipsyncModel && lipsyncCostVnd ? scenes.filter((s) => s.dialogue_line) : [];
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
        if (!motionPrompt) {
          if (scene.camera_view) {
            const plan = await generateSceneDescriptionFromImage(
              scene.image_url as string,
              scene.scene_description ?? undefined,
              job.story_description,
              undefined,
              genreStyleGuide,
              miniApp.model_config.motion_planner_prompt
            );
            motionPrompt = plan.motionPrompt;
            // Motion Timing Controller: tái dùng đúng lượt gọi AI vừa viết motion_prompt để chọn luôn
            // mức thời lượng phù hợp cho cảnh này, không tốn thêm lượt gọi/chi phí nào.
            motionDurationKey = resolveNearestDurationKey(videoEntry?.duration_price_vnd, plan.durationSeconds) ?? null;
          } else {
            motionPrompt = scene.scene_description;
          }
          await supabase
            .from("story_video_scenes")
            .update({ motion_prompt: motionPrompt, motion_duration_key: motionDurationKey })
            .eq("id", scene.id);
        }
        const requestId = await submitSceneVideoForRow(
          { id: jobId, video_model: job.video_model, aspect_ratio: job.aspect_ratio, video_duration_key: job.video_duration_key },
          {
            id: scene.id,
            image_url: scene.image_url,
            scene_description: scene.scene_description,
            motion_prompt: motionPrompt,
            motion_duration_key: motionDurationKey,
            end_image_url: scene.end_image_url,
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
    .select("id, job_id, image_url, end_image_url, scene_description, motion_prompt, motion_duration_key, dialogue_line")
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
  // như lúc submit batch ở proceedToVideoStage).
  if (sceneData.dialogue_line) {
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
  if (job.video_credit_tx_id) {
    newBalance = await getCreditBalance(userId);
  } else {
    const { marginPercent, vndPerCredit } = await getMediaPricingSettings();
    const videoCost = computeDynamicCreditCost(job.video_provider_cost_vnd_per_scene * job.num_scenes, marginPercent, vndPerCredit);

    const deduction = await deductCredit(userId, videoCost, job.mini_app_id, idempotencyKey);
    if (!deduction.success) throw new InsufficientCreditError();

    await supabase.from("story_video_jobs").update({ video_credit_tx_id: deduction.txId }).eq("id", jobId);
    newBalance = deduction.newBalance;
  }

  const scenes = await getScenes(jobId);
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

  const { data: job } = await supabase.from("story_video_jobs").select("mini_app_id, frame_chain_mode").eq("id", jobId).single();

  // Frame-chaining — hoàn toàn tách khỏi luồng song song bên dưới (không chờ "đủ cảnh", tự nối tiếp
  // tuần tự sang cảnh kế bằng khung hình THẬT vừa render ra). Không hỗ trợ lồng tiếng/tạo lại ở v1.
  if (job?.frame_chain_mode) {
    if (!isRegenerate) await applyFrameChainVideoResult(jobId, sceneId, videoUrl);
    return;
  }

  const lipsyncModel = job ? (await getMiniAppModelConfig(job.mini_app_id)).model_config.lipsync_model : undefined;

  const scenes = await getScenes(jobId);
  const scene = scenes.find((s) => s.id === sceneId);

  if (scene && sceneNeedsLipsync(scene, lipsyncModel)) {
    try {
      const voiceId = CHARACTER_VOICE_IDS[(scene.dialogue_speaker_position ?? 0) % CHARACTER_VOICE_IDS.length];
      await submitSceneLipsyncForRow(jobId, sceneId, lipsyncModel as string, videoUrl, scene.dialogue_line as string, voiceId, isRegenerate);
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

  if (scenes.length === 0 || scenes.some((s) => (sceneNeedsLipsync(s, lipsyncModel) ? !s.lipsync_url : !s.video_url))) return; // chờ cảnh còn lại

  await stitchAndFinish(jobId, scenes);
}

// Frame-chaining — cảnh vừa có ảnh xong -> submit video ngay, không có gì để chờ (khác continuous
// motion cần chờ đủ ảnh đầu+cuối trước khi submit video). Dùng cho cả cảnh đầu tiên (runSceneStage)
// lẫn các cảnh sau (applyFrameChainVideoResult gọi lại đúng đường này qua applyImageStageResult).
// Lưới an toàn lớp 2 cho frame-chaining — tối đa số lần vẽ lại (dùng lại đúng khung hình chain cũ) khi
// phát hiện sai danh tính, trước khi chấp nhận quay về ảnh Character gốc (mất liền mạch tư thế/bối
// cảnh ở đúng 1 cảnh đó, nhưng chắc chắn đúng mặt) — xem applyFrameChainImageResult().
const MAX_IDENTITY_RETRY = 2;

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
    | "item_reference_url"
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

async function applyFrameChainImageResult(jobId: number, sceneId: number) {
  const supabase = getSupabaseAdmin();
  const { data: job } = await supabase
    .from("story_video_jobs")
    .select(
      "id, mini_app_id, video_model, aspect_ratio, video_duration_key, image_model, image_resolution_key, character_sheet_url, character_angle_urls, location_reference_url, item_reference_url"
    )
    .eq("id", jobId)
    .single();
  const { data: scene } = await supabase
    .from("story_video_scenes")
    .select("id, position, image_url, scene_description, motion_prompt, camera_view, face_view, outfit_override, location, identity_retry_count")
    .eq("id", sceneId)
    .single();
  if (!job || !scene) return;

  if (!(await checkFrameChainIdentity(jobId, scene, job))) return; // đợi webhook ảnh mới, chưa submit video vội

  try {
    const requestId = await submitSceneVideoForRow(job, scene, false);
    await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", sceneId);
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

// Video cảnh N vừa render xong -> tách khung hình cuối THẬT (extractLastFrame) -> hoặc submit ảnh cảnh
// N+1 dùng khung hình đó làm mỏ neo (chainedFrameUrl), hoặc nếu là cảnh cuối cùng thì ghép video luôn.
async function applyFrameChainVideoResult(jobId: number, sceneId: number, videoUrl: string) {
  const supabase = getSupabaseAdmin();
  const { data: scene } = await supabase.from("story_video_scenes").select("id, job_id, position").eq("id", sceneId).single();
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
    .select("id, position, scene_description, motion_prompt, camera_view, outfit_override, face_view, location, identity_retry_count")
    .eq("job_id", jobId)
    .eq("position", scene.position + 1)
    .maybeSingle();

  if (nextScene) {
    const { data: job } = await supabase
      .from("story_video_jobs")
      .select(
        "id, mini_app_id, video_model, aspect_ratio, video_duration_key, image_model, image_resolution_key, character_sheet_url, character_angle_urls, location_reference_url, item_reference_url"
      )
      .eq("id", jobId)
      .single();
    if (!job) return;

    // Dùng THẲNG khung hình thật vừa tách làm ảnh đầu cảnh kế tiếp — liền mạch tuyệt đối (đúng pixel,
    // không qua AI vẽ lại nên không còn sai số bố cục/góc máy nào cả). Bản trước nhờ AI "vẽ lại 1 ảnh
    // tham khảo" khung hình này — dù đã ép prompt giữ khung hình/góc máy, vẫn chỉ là xác suất theo lời
    // model, không chắc chắn 100% (đúng phản hồi thật của user: ảnh đầu cảnh sau vẫn không giống hệt
    // khung cuối cảnh trước). Đánh đổi: mất bước AI "chỉnh lại cho đúng mặt" mỗi cảnh — bù lại bằng đúng
    // lưới an toàn danh tính đã có (checkFrameChainIdentity), chạy NGAY trên khung hình thật này; nếu
    // model video tự làm trôi mặt trong lúc quay (hiếm nhưng có thể), lưới vẫn bắt được và mới nhờ AI vẽ
    // lại làm phương án dự phòng, y hệt cơ chế cũ — chỉ khác là giờ đây là NGOẠI LỆ, không phải mặc định.
    await supabase.from("story_video_scenes").update({ image_url: lastFrameUrl }).eq("id", nextScene.id);
    const nextSceneWithImage = { ...nextScene, image_url: lastFrameUrl };

    if (!(await checkFrameChainIdentity(jobId, nextSceneWithImage, job))) return; // đã tự vẽ lại ảnh khác, đợi webhook ảnh mới

    try {
      const requestId = await submitSceneVideoForRow(job, nextSceneWithImage, false);
      await supabase.from("story_video_scenes").update({ video_fal_request_id: requestId }).eq("id", nextScene.id);
    } catch (err) {
      await failJob(jobId, err instanceof Error ? err.message : String(err));
    }
  } else {
    const scenes = await getScenes(jobId);
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
const STITCH_CANVAS_BY_ASPECT_RATIO: Record<string, { width: number; height: number }> = {
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 720, height: 720 },
};

// Thời lượng chuyển mờ giữa 2 cảnh khi ghép — ngắn vừa đủ để che lệch nhỏ ở khung hình cuối/đầu giữa
// 2 clip (model video không luôn bám sát 100% ảnh đích khi tạo 8 giây chuyển động, xem stitchAndFinish),
// không đủ dài để làm mất nội dung cảnh.
const STITCH_FADE_SECONDS = 0.25;

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
        const clipPath = path.join(workDir, `clip-${index}.mp4`);
        await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
        clipPaths[index] = clipPath;
      })
    );

    const scaleFilter = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

    if (clipPaths.length === 1) {
      // Chỉ 1 cảnh (vd khách dùng "Ghép video, bỏ cảnh lỗi" chỉ còn đúng 1 cảnh) — không có điểm ghép
      // nào để chuyển mờ, chỉ cần chuẩn hoá kích thước.
      await execFileAsync(ffmpegPath, [
        "-i", clipPaths[0], "-vf", scaleFilter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", outputPath,
      ]);
    } else {
      // Chuyển mờ ngắn (crossfade) giữa các cảnh thay vì cắt cứng — xem chú thích STITCH_FADE_SECONDS.
      // LƯU Ý (đã sửa lỗi thật): bản đầu tiên gộp DẦN cả khối tích luỹ (accumulator) qua từng bước —
      // mỗi bước re-encode LẠI TOÀN BỘ phần đã ghép trước đó, nên tổng chi phí encode tăng theo cấp số
      // nhân với số cảnh (O(N^2)) — job đủ nhiều cảnh (6-8+) khiến tổng thời gian vượt quá giới hạn 60s
      // của Vercel Hobby, gây timeout dù RAM đã ổn (xem OOM fix trước đó). Sửa lại: mỗi clip chỉ
      // re-encode ĐÚNG 1 LẦN (phần "core" — toàn bộ clip trừ đúng nửa giây giao với clip liền kề), các
      // đoạn chuyển mờ chỉ ghép 2 MẨU NHỎ (đúng STITCH_FADE_SECONDS mỗi bên) — tổng chi phí giờ tuyến
      // tính theo tổng thời lượng video (O(N)), không phụ thuộc số cảnh theo cấp số nhân. Nối các mảnh
      // lại bằng concat demuxer + "-c copy" (không re-encode, gần như tức thời) vì mọi mảnh đều được
      // encode ra cùng 1 bộ tham số codec. Verify thật: 8 cảnh 5s chỉ mất ~10s (so với ~48s cách cũ).
      const clipInfo = await Promise.all(clipPaths.map((p) => probeClip(p)));
      const durations = clipInfo.map((c) => c.durationSeconds);
      const anyHasAudio = clipInfo.some((c) => c.hasAudio);
      const fade = STITCH_FADE_SECONDS;
      const n = clipPaths.length;

      const audioFilterFor = (idx: number, dur: number, outLabel: string) =>
        clipInfo[idx].hasAudio
          ? `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[${outLabel}]`
          : `anullsrc=channel_layout=stereo:sample_rate=44100:d=${dur.toFixed(3)}[${outLabel}]`;
      const encodeArgs = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", ...(anyHasAudio ? ["-c:a", "aac"] : ["-an"])];

      // 1) "core" — thân mỗi clip, trừ đúng nửa giao chuyển mờ với clip liền kề (đầu/cuối). Mỗi clip
      // chỉ encode ĐÚNG 1 LẦN, không phụ thuộc số cảnh còn lại phía sau.
      const corePaths: string[] = [];
      for (let i = 0; i < n; i++) {
        const headTrim = i > 0 ? fade : 0;
        const tailTrim = i < n - 1 ? fade : 0;
        const coreDur = Math.max(0.01, durations[i] - headTrim - tailTrim);
        const outPath = path.join(workDir, `core-${i}.mp4`);
        const filterParts = [`[0:v]${scaleFilter}[vout]`];
        const mapArgs = ["-map", "[vout]"];
        if (anyHasAudio) {
          filterParts.push(audioFilterFor(i, coreDur, "aout"));
          mapArgs.push("-map", "[aout]");
        }
        await execFileAsync(ffmpegPath, [
          "-ss", headTrim.toFixed(3), "-i", clipPaths[i], "-t", coreDur.toFixed(3),
          "-filter_complex", filterParts.join(";"),
          ...mapArgs,
          ...encodeArgs,
          "-y", outPath,
        ]);
        corePaths[i] = outPath;
      }

      // 2) transition — 2 mẩu nhỏ (đuôi clip i + đầu clip i+1) crossfade với nhau, chi phí luôn nhỏ và
      // cố định (đúng "fade" giây), không phụ thuộc độ dài clip hay tổng số cảnh trong job.
      const transitionPaths: string[] = [];
      for (let i = 0; i < n - 1; i++) {
        const j = i + 1;
        const tailPath = path.join(workDir, `tail-${i}.mp4`);
        const headPath = path.join(workDir, `head-${j}.mp4`);
        const transPath = path.join(workDir, `trans-${i}.mp4`);

        const tailFilter = [`[0:v]${scaleFilter}[vout]`];
        const tailMap = ["-map", "[vout]"];
        if (anyHasAudio) {
          tailFilter.push(audioFilterFor(i, fade, "aout"));
          tailMap.push("-map", "[aout]");
        }
        await execFileAsync(ffmpegPath, [
          "-ss", Math.max(0, durations[i] - fade).toFixed(3), "-i", clipPaths[i], "-t", fade.toFixed(3),
          "-filter_complex", tailFilter.join(";"),
          ...tailMap,
          ...encodeArgs,
          "-y", tailPath,
        ]);

        const headFilter = [`[0:v]${scaleFilter}[vout]`];
        const headMap = ["-map", "[vout]"];
        if (anyHasAudio) {
          headFilter.push(audioFilterFor(j, fade, "aout"));
          headMap.push("-map", "[aout]");
        }
        await execFileAsync(ffmpegPath, [
          "-ss", "0", "-i", clipPaths[j], "-t", fade.toFixed(3),
          "-filter_complex", headFilter.join(";"),
          ...headMap,
          ...encodeArgs,
          "-y", headPath,
        ]);

        // "-pix_fmt yuv420p" bắt buộc — filter "xfade" tự chuyển sang không gian màu 4:4:4 khi chuyển
        // mờ, nếu không ép lại libx264 sẽ encode ra profile "High 4:4:4 Predictive" (yuv444p) mà hầu
        // hết trình phát thường (kể cả Windows Media Player mặc định) không phát được.
        const transFilterParts = [`[0:v][1:v]xfade=transition=fade:duration=${fade}:offset=0[vout]`];
        const transMap = ["-map", "[vout]"];
        if (anyHasAudio) {
          transFilterParts.push(`[0:a][1:a]acrossfade=d=${fade}[aout]`);
          transMap.push("-map", "[aout]");
        }
        await execFileAsync(ffmpegPath, [
          "-i", tailPath, "-i", headPath,
          "-filter_complex", transFilterParts.join(";"),
          ...transMap,
          ...encodeArgs,
          "-y", transPath,
        ]);
        transitionPaths[i] = transPath;
      }

      // 3) Nối tất cả mảnh lại bằng concat demuxer + "-c copy" — KHÔNG re-encode, gần như tức thời, an
      // toàn vì mọi mảnh ở trên đều đã encode cùng 1 bộ tham số codec.
      const listPath = path.join(workDir, "concat-list.txt");
      const listLines: string[] = [];
      for (let i = 0; i < n; i++) {
        listLines.push(`file '${corePaths[i].replace(/'/g, "'\\''")}'`);
        if (i < n - 1) listLines.push(`file '${transitionPaths[i].replace(/'/g, "'\\''")}'`);
      }
      await writeFile(listPath, listLines.join("\n"));
      await execFileAsync(ffmpegPath, ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", outputPath]);
    }

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
  const staleThreshold = job.status === "stitching" ? STITCH_STALE_CHECK_MS : STALE_CHECK_MS;
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
      } else if (scene.video_url && sceneNeedsLipsync(scene, lipsyncModel) && !scene.lipsync_url && scene.lipsync_fal_request_id) {
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
    if (scenes.length > 0 && scenes.every((s) => (sceneNeedsLipsync(s, lipsyncModel) ? s.lipsync_url : s.video_url))) {
      await stitchAndFinish(jobId, scenes);
    }
  }
}
