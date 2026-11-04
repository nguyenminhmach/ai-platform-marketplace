"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

// SỬA (phản hồi thật user: "đưa người 3D từ bên tạo ánh sáng sang thay" — khối mannequin đơn giản
// buildMannequin() quá thô so với model người thật dùng bên khung ánh sáng/camera) — dùng chung đúng 1
// model .glb ("Man" by Quaternius, CC0, public/models/man.glb — xem components/story-video/
// LightSphereModal.tsx đã dùng model này trước). Tải 1 LẦN DUY NHẤT (Promise cache module-level, không
// phải mỗi lần đổi characters lại tải lại), các nhân vật sau nhân bản từ cùng 1 template bằng
// SkeletonUtils.clone (an toàn cho cả model có rig/skeleton, khác .clone() thường dễ vỡ xương).
// SỬA (phản hồi thật user: trang "3D Builder" cần 4 dáng người khác nhau — Nữ/Nam/Thanh niên/Trẻ em,
// lấy từ Mixamo rồi xuất qua Blender, xem public/models/{female,man-adult,youth,child}.glb) — đổi từ
// 1 model CỐ ĐỊNH sang cache theo TỪNG đường dẫn model (Map thay vì 1 Promise đơn), vẫn giữ nguyên hành
// vi cũ cho mọi nơi gọi KHÔNG truyền modelUrl (mặc định "/models/man.glb" — Story Video/LightSphereModal
// không đổi gì cả, chỉ "3D Builder" mới dùng đường dẫn khác qua PositionedCharacter.modelUrl).
// SỬA (phản hồi thật user: "chưa cho nhân vật vào 3D được" — gốc lỗi THẬT SỰ: 4 model Mixamo mới
// (female/man-adult/youth/child) xuất qua Blender có bật nén Draco (xem scratchpad/fbx_to_glb_compressed.py
// — export_draco_mesh_compression_enable=True, để giảm dung lượng ~55MB xuống còn vài MB), nhưng
// GLTFLoader() ở đây trước giờ KHÔNG gắn DRACOLoader — tải model nào có nén Draco sẽ LUÔN reject (model cũ
// man.glb không nén Draco nên trước giờ không lộ lỗi này), bị effect gọi .catch(() => null) NUỐT ÂM THẦM,
// nên nhân vật biến mất khỏi khung 3D mà không báo lỗi gì. Gắn thêm DRACOLoader trỏ tới file giải mã đã
// copy sẵn từ node_modules/three vào public/draco/ (tự host, không phụ thuộc mạng ngoài).
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/");
const modelPromiseCache = new Map<string, Promise<THREE.Group>>();
function loadManModel(modelUrl: string = "/models/man.glb"): Promise<THREE.Group> {
  let cached = modelPromiseCache.get(modelUrl);
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.load(
        modelUrl,
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => reject(err)
      );
    });
    modelPromiseCache.set(modelUrl, cached);
  }
  return cached;
}

// SỬA (phản hồi thật user: kéo nhân vật ra xa trong ô 3D làm chấm trên ảnh 2D bị đẩy vọt lên TRỜI, vượt
// quá cả đường chân trời thật của ảnh) — công thức cũ quy đổi độ sâu 3D -> toạ độ y ảnh 2D TUYẾN TÍNH
// (coi "xa vô hạn" luôn tiến thẳng tới mép TRÊN cùng, y=0), không biết chân trời thật nằm đâu trong ảnh.
// Đổi sang công thức "mặt phẳng nền" kiểu pinhole camera: độ sâu 0 (ngay trước camera) -> y=1 (mép dưới,
// như cũ), độ sâu tiến ra xa -> y tụ dần về ĐÚNG horizonY (vị trí chân trời thật, do AI ước lượng riêng
// cho từng ảnh — xem lib/story-video.ts estimateLocationHorizon), không bao giờ vượt qua nó nữa.
// DEPTH_SCALE là hằng số định hình tốc độ tụ (không phải thông số camera thật đo được, chỉ là xấp xỉ
// cảm quan) — chọn bằng nửa SPREAD_Z=5 hiện có để ở độ sâu tối đa (5) vẫn còn cách chân trời 1 khoảng rõ
// rệt (y vẫn cách horizonY một đoạn ~1/3 còn lại), tránh dính sát chân trời ngay cả khi đã kéo hết cỡ.
const DEPTH_SCALE = 2.5;

function depthToY2D(depth: number, horizonY: number): number {
  const d = Math.max(0, depth);
  return horizonY + (1 - horizonY) * (DEPTH_SCALE / (DEPTH_SCALE + d));
}

// Chiều ngược: từ điểm bấm trên ảnh 2D (y 0..1) suy ra độ sâu 3D tương ứng. Bấm đúng hoặc phía TRÊN
// đường chân trời (vùng trời/quá xa) không có độ sâu hữu hạn thật — trả về độ sâu tối đa cho phép.
function y2DToDepth(y2D: number, horizonY: number, maxDepth: number): number {
  if (y2D <= horizonY) return maxDepth;
  const depth = ((1 - horizonY) * DEPTH_SCALE) / (y2D - horizonY) - DEPTH_SCALE;
  return Math.min(maxDepth, Math.max(0, depth));
}

export type PositionedCharacter = {
  url: string;
  name: string;
  color: string;
  // Toạ độ chuẩn hoá 0..1 đã chọn trên ảnh 2D (xem locationPositions ở VideoTuYTuongClient.tsx) — x:
  // trái(0)->phải(1), y: xa(0, gần đỉnh ảnh)->gần(1, gần đáy ảnh).
  x: number;
  y: number;
  // SỬA (phản hồi thật user: "di chuyển được nhưng không xoay được, tạo 2 mũi tên vòng tròn quanh nhân
  // vật để xoay") — góc xoay quanh trục đứng Y (radian), lưu lại để không mất khi dựng lại mannequin
  // (characters đổi reference liên tục, xem effect "Dựng lại mannequin" bên dưới). Chỉ ẢNH HƯỞNG HIỂN
  // THỊ 3D, KHÔNG gửi vào mask lúc tạo ảnh/video thật (mask chỉ là 1 vùng trắng hình chữ nhật, không
  // biểu đạt được hướng quay) — thuần công cụ xem trước/dàn cảnh.
  rotationY?: number;
  // SỬA (phản hồi thật user, gửi ảnh mẫu "Edit Pose": "vòng cung màu đỏ để nhân vật xoay tròn theo kiểu
  // nằm ngửa, vòng cung màu xanh xoay nhân vật theo kiểu nằm nghiêng") — 2 trục xoay thêm, cùng đơn vị
  // radian như rotationY, lưu lại để không mất khi dựng lại mannequin (giống rotationY).
  rotationX?: number; // ngả người trước/sau (gật đầu) — tay cầm đỏ
  rotationZ?: number; // nghiêng người trái/phải (lật người) — tay cầm xanh dương
  // SỬA (phản hồi thật user: "3D Builder" cần 4 dáng người khác nhau) — đường dẫn .glb riêng cho nhân
  // vật này, tuỳ chọn. Bỏ trống thì dùng mặc định "/models/man.glb" (hành vi cũ, không đổi gì cho các
  // nơi gọi hiện có — Story Video/LightSphereModal không truyền field này).
  modelUrl?: string;
  // SỬA (phản hồi thật user: "không có chiều lên xuống à" — xác nhận muốn thêm mũi tên lên/xuống để
  // nhấc nhân vật khỏi mặt sàn, vd đứng lên bậc thang) — độ cao world unit so với mặt sàn (0 = đứng
  // ngay trên sàn, mặc định khi bỏ trống). Chỉ ảnh hưởng hiển thị 3D, không đụng tới x/y (vị trí ngang
  // trên ảnh 2D) hay groundOffset riêng của từng model (chân vẫn chạm đúng world Y=elevationY).
  elevationY?: number;
  // SỬA (phản hồi thật user, gửi ảnh mẫu panel thông số nhân vật kiểu TopView: "Transform > Scale") —
  // tỉ lệ co giãn riêng từng trục, mặc định 1 (kích thước gốc) nếu bỏ trống. Áp lên group CHA (không đụng
  // tới model.scale — đã dùng riêng để chuẩn hoá chiều cao thật giữa các model .glb khác nhau, xem
  // templateMeta ở effect "Dựng lại mannequin") nên 2 lớp scale độc lập, không chồng chéo ý nghĩa.
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  // SỬA (phản hồi thật user, cùng ảnh mẫu: toggle "Show label" trong panel thông số) — hiện/ẩn nhãn tên
  // nổi phía trên đầu nhân vật, mặc định true (hiện) nếu bỏ trống, khớp đúng trạng thái mặc định trong
  // ảnh mẫu (toggle đang bật sẵn).
  showLabel?: boolean;
  // SỬA (phản hồi thật user, panel thông số nhân vật: "làm luôn Material") — màu tint dạng hex (vd
  // "#ff0000"), nhân màu đè lên TOÀN BỘ vật liệu model — xem chỗ áp dụng ở effect "Dựng lại mannequin".
  // Mặc định "#ffffff" (không đổi màu gì, giữ nguyên gốc) nếu bỏ trống.
  tintColor?: string;
};

type Props = {
  locationUrl: string;
  characters: PositionedCharacter[];
  // Ảnh độ sâu Fal trả về (xem nút "Dựng khối 3D" ở VideoTuYTuongClient.tsx) — tuỳ chọn, nếu chưa gọi
  // hoặc chưa xong thì khung 3D vẫn hiển thị bình thường (chỉ mannequin + sàn phẳng), không chặn gì cả.
  // KHÔNG còn dùng để dựng lưới địa hình gồ ghề nữa (đã bỏ hẳn, luôn sàn phẳng — xem ghi chú ở
  // buildGroundDepthCalibration) — chỉ dùng để hiệu chuẩn vị trí 2D<->3D thật cho chính xác.
  depthImageUrl?: string | null;
  // Mask PNG "mặt đất" từ fal-ai/sam-3/image (prompt "ground", alpha>0 = thuộc vùng mặt đất) — dùng cho
  // buildGroundDepthCalibration để hiệu chuẩn vị trí 2D<->3D chính xác theo đúng hình học thật của ảnh.
  // Tuỳ chọn, null thì rơi về công thức horizonY xấp xỉ (xem y2DToDepthResolved/depthToY2DResolved).
  groundMaskUrl?: string | null;
  // SỬA (phản hồi thật user: muốn kiểm chứng trực quan điểm 2D nào tương ứng điểm nào trong 3D, không
  // cần gắn hẳn 1 nhân vật thật) — danh sách điểm test tạm thời (không lưu DB, không liên quan nhân
  // vật), hiện thành chấm đỏ đánh số 1,2,3... tại đúng vị trí tương ứng trong khung 3D, dùng công thức
  // world-mapping Y HỆT nhân vật thật (xem mannequin-building effect bên dưới).
  testPoints?: { x: number; y: number }[];
  // SỬA (phản hồi thật user: muốn nút "Di chuyển" hiện gizmo mũi tên XYZ kéo nhân vật trực tiếp trong
  // khung 3D, kéo xong thì vị trí trên ảnh 2D cũng cập nhật theo — tham khảo TopView Film Studio) — báo
  // ngược lên component cha (VideoTuYTuongClient.tsx) mỗi khi kéo xong vị trí 1 nhân vật, để cập nhật
  // locationPositions giữ đồng bộ với chấm đánh dấu trên ảnh 2D. Không bắt buộc — thiếu thì nút "Di
  // chuyển" vẫn hiện nhưng kéo xong không lưu lại vị trí mới.
  onCharacterMove?: (characterUrl: string, pos: { x: number; y: number }) => void;
  // Báo ngược lên component cha khi khách xoay 1 nhân vật qua gizmo xoay (chế độ "Di chuyển" -> bấm
  // chuyển sang "Xoay") — tách riêng khỏi onCharacterMove vì đây là 1 giá trị khác (radian), không phải
  // toạ độ x/y, để component cha gộp đúng vào đúng field rotationY khi lưu locationPositions.
  onCharacterRotate?: (characterUrl: string, rotationY: number) => void;
  // Tương tự onCharacterRotate nhưng cho 2 trục mới (xem rotationX/rotationZ ở PositionedCharacter).
  onCharacterRotateX?: (characterUrl: string, rotationX: number) => void;
  onCharacterRotateZ?: (characterUrl: string, rotationZ: number) => void;
  // SỬA (phản hồi thật user: "không có chiều lên xuống à" — thêm mũi tên trục Y kéo nhân vật cao/thấp
  // hơn mặt sàn) — báo ngược độ cao mới (world unit, 0 = sàn) tương tự onCharacterMove/onCharacterRotate,
  // để component cha lưu lại elevationY, không mất khi dựng lại mannequin.
  onCharacterElevate?: (characterUrl: string, elevationY: number) => void;
  // SỬA (phản hồi thật user, gửi ảnh mẫu panel thông số nhân vật kiểu TopView) — báo ngược tỉ lệ co giãn
  // mới lên component cha, tương tự onCharacterElevate, để lưu lại scaleX/Y/Z không mất khi dựng lại
  // mannequin. Component cha gọi khi khách gõ số vào ô Scale ở panel (không có gizmo kéo scale trong
  // khung 3D, chỉ nhập số).
  onCharacterScale?: (characterUrl: string, scale: { x: number; y: number; z: number }) => void;
  // SỬA (cùng ảnh mẫu panel) — báo ngược lên component cha mỗi khi khách CHỌN/BỎ CHỌN 1 nhân vật (bấm
  // trúng nhân vật, bấm "Bỏ chọn", bấm chỗ trống, hoặc nhân vật đang chọn bị xoá khỏi danh sách) — để cha
  // biết hiện panel thông số của ai, hoặc ẩn hẳn panel khi không còn chọn ai. url=null nghĩa là bỏ chọn.
  onCharacterSelect?: (characterUrl: string | null) => void;
  // SỬA (cùng ảnh mẫu panel) — báo ngược TOẠ ĐỘ THẾ GIỚI thật (world unit/radian) của nhân vật ĐANG CHỌN
  // mỗi khi nó đổi (dựng lại mannequin, kéo gizmo dịch chuyển/xoay) — để panel "Transform" hiện đúng số
  // LIVE theo đúng những gì gizmo đang làm, không cần cha tự quy đổi lại từ x/y chuẩn hoá 0..1 (vốn cần
  // đúng groundCalib nội bộ của component này mới chính xác tuyệt đối — xem y2DToDepthResolved).
  onCharacterTransform?: (
    characterUrl: string,
    transform: {
      worldX: number;
      worldY: number;
      worldZ: number;
      rotationX: number;
      rotationY: number;
      rotationZ: number;
      scaleX: number;
      scaleY: number;
      scaleZ: number;
    }
  ) => void;
  // Vị trí đường chân trời ước lượng cho ảnh này (0..1, 0=mép trên, 1=mép dưới) — xem depthToY2D/
  // y2DToDepth phía trên. Mặc định 0.5 (giữa ảnh) nếu chưa có dữ liệu (ảnh chưa "Dựng khối 3D" lần nào).
  horizonY?: number;
  // SỬA (phản hồi thật user: trang "3D Builder" độc lập cần nút "Export" chụp lại đúng khung nhìn 3D
  // hiện tại thành PNG) — báo ngược canvas thật (renderer.domElement) ra component cha ngay sau khi
  // dựng renderer xong, để cha tự gọi canvas.toDataURL() bất kỳ lúc nào muốn xuất ảnh (không cần
  // component này tự có nút Export riêng, giữ đúng vai trò "khung xem/chỉnh sửa", xuất ảnh là việc của
  // nơi gọi nó).
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  // SỬA (phản hồi thật user ở "3D Builder": "cho hình người nhỏ hơn anh thấy to quá") — chiều cao mannequin
  // (đơn vị world, lưới 5x5) từng cố định 1.6 cho MỌI nơi gọi. Tuỳ chọn, mặc định vẫn 1.6 (giữ nguyên
  // Video từ ý tưởng/LightSphereModal không đổi gì) — "3D Builder" truyền riêng giá trị nhỏ hơn.
  characterHeightUnits?: number;
};

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load fail"));
    img.src = url;
  });
}

// Ảnh độ sâu Midas (fal-ai/imageutils/depth) — độ sáng CÀNG CAO = CÀNG GẦN máy ảnh (dùng ở
// buildGroundDepthCalibration bên dưới). SỬA (phản hồi thật user: quyết định bỏ hẳn việc dựng lưới địa
// hình gồ ghề từ ảnh độ sâu — kỹ thuật heightmap-từ-độ-sâu liên tục gây lỗi qua nhiều vòng sửa trong
// suốt quá trình làm tính năng này (phẳng + 1 góc vênh, nhiễu "rừng gai nhọn", méo "phễu" cho ảnh phố,
// rồi lại "rừng gai nhọn" cho ảnh thiên nhiên sương mù nhiều cây) — và quan trọng nhất: lưới đó CHỈ
// MANG TÍNH HIỂN THỊ, không ảnh hưởng gì tới độ chính xác đặt vị trí nhân vật (bảng hiệu chuẩn
// buildGroundDepthCalibration bên dưới đọc THẲNG từ depthImageUrl/groundMaskUrl, không đọc gì từ lưới
// 3D) — bỏ hẳn phần dựng địa hình gồ ghề (sampleBrightnessAveraged/smoothGrid/loadGroundWeightGrid/
// buildTerrainGeometry, chỉ được dùng cho việc đó), LUÔN dùng sàn phẳng (buildFlatGroundGeometry bên
// dưới) cho mọi ảnh, không còn phân biệt "tự nhiên/nhân tạo" nữa.

// SỬA (phản hồi thật user: công thức chân trời horizonY cải thiện nhưng vẫn chưa khớp sát mặt đất thật
// — vì nó chỉ là đường cong xấp xỉ chung (1 hằng số DEPTH_SCALE đoán sẵn), không phản ánh đúng hình học
// thật của riêng từng ảnh) — thay bằng hiệu chuẩn THẬT, lấy trực tiếp từ chính ảnh độ sâu + mặt nạ đất
// đã có sẵn (không tốn thêm tiền AI): với mỗi HÀNG pixel của ảnh, lấy độ sáng trung bình các điểm THUỘC
// vùng đất (theo mask) ở đúng hàng đó — ảnh độ sâu Midas "càng sáng càng gần máy ảnh" (xem ghi chú ở
// loadImageEl phía trên) nên độ sáng trung bình mỗi hàng chính là 1 proxy thật cho độ gần/xa của MẶT ĐẤT
// tại đúng hàng ảnh đó, phản ánh đúng góc nghiêng/độ cao camera thật của ảnh này — không còn là đường
// cong đoán chung cho mọi ảnh nữa.
type GroundCalibration = {
  rows: Float32Array; // chỉ số hàng ảnh (0=mép trên) có đủ dữ liệu đất, tăng dần
  nearness: Float32Array; // 0..1 cùng độ dài với rows — 0=xa nhất biết được, 1=gần nhất biết được, TĂNG DẦN theo rows (ép đơn điệu)
  imgHeight: number;
};

function movingAverage1D(arr: number[], radius: number): number[] {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j++) {
      sum += arr[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// Dựng bảng hiệu chuẩn "hàng ảnh <-> độ gần/xa thật" cho 1 ảnh bối cảnh — gọi 1 lần khi ảnh có
// depthImageUrl, cache lại trong state, dùng cho MỌI lượt quy đổi 2D<->3D sau đó (đặt nhân vật từ ảnh
// 2D, đọc lại vị trí khi kéo gizmo trong 3D, và từ giờ CẢ texture phủ sàn — xem buildFlatGroundGeometry).
// SỬA (phản hồi thật user, đo thật bằng script và phát hiện): bản cũ CHỈ lấy dữ liệu depth map ở những
// hàng mà SAM-3 coi là "đất" (groundMaskUrl, alpha > 5%) — trên ảnh nhiều sương mù/núi xa, dải "đất chắc
// chắn" đó có khi chỉ chiếm ~36% chiều cao ảnh, khiến 64% còn lại (trời, núi xa, cây mờ sương) HOÀN TOÀN
// không có dữ liệu, mọi điểm bấm trong vùng đó đều bị kẹp về cùng 1 giá trị "xa nhất", không phân biệt
// được gì (đã đo và vẽ biểu đồ xác nhận). Giờ dùng TOÀN BỘ depth map (mọi hàng, không lọc qua mask) —
// model depth (fal-ai/imageutils/depth) vốn đã ước lượng độ sâu tương đối cho MỌI pixel kể cả trời/cây,
// không chỉ riêng vùng đất — đổi lại độ chính xác tuyệt đối ở vùng đất thật để lấy ĐỘ PHỦ ĐẦY ĐỦ cho
// toàn ảnh, đúng mục đích mới (dùng để đặt camera, cần liên tục/trực quan hơn là chính xác tuyệt đối).
async function buildGroundDepthCalibration(depthUrl: string): Promise<GroundCalibration | null> {
  try {
    const depthImg = await loadImageEl(depthUrl);
    const w = depthImg.naturalWidth || depthImg.width;
    const h = depthImg.naturalHeight || depthImg.height;
    if (!w || !h) return null;

    const dCanvas = document.createElement("canvas");
    dCanvas.width = w;
    dCanvas.height = h;
    const dCtx = dCanvas.getContext("2d");
    if (!dCtx) return null;
    dCtx.drawImage(depthImg, 0, 0);
    const depthData = dCtx.getImageData(0, 0, w, h).data;

    // Không còn lọc theo mask -- lấy độ sáng trung bình CẢ HÀNG, cho MỌI hàng ảnh (rows = 0..h-1 đủ hết).
    const rowBrightness: number[] = new Array(h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        sum += (depthData[idx] + depthData[idx + 1] + depthData[idx + 2]) / 3;
      }
      rowBrightness[y] = sum / w;
    }

    // Độ sáng CÀNG CAO = CÀNG GẦN (quy ước Midas, xem ghi chú ở loadImageEl) -- nearnessRaw tăng dần theo
    // độ gần, đúng chiều mong muốn luôn, không cần tự dò chiều. Cửa sổ làm mượt rộng hơn bản cũ (9 thay vì
    // 5) để giảm hiện tượng "đoạn phẳng" (plateau) do nhiễu điểm ảnh cục bộ tạo ra khi ép đơn điệu bên
    // dưới (đã đo thấy xảy ra thật trên dải dữ liệu hẹp trước đây, vẫn có thể xảy ra dù hiếm hơn khi phủ
    // toàn bộ ảnh).
    const nearnessRaw = movingAverage1D(rowBrightness, 9);

    // Ép ĐƠN ĐIỆU TĂNG DẦN theo thứ tự hàng (ảnh thật luôn có nhiễu cục bộ phá vỡ tính đơn điệu lý
    // thuyết của 1 mặt phẳng đất hoàn hảo) — bắt buộc để nghịch đảo (độ sâu -> hàng) có nghĩa. Dùng
    // running max đơn giản hoá cho pool-adjacent-violators.
    let runningMax = -Infinity;
    const monotone = nearnessRaw.map((v) => {
      runningMax = Math.max(runningMax, v);
      return runningMax;
    });

    // Co giãn percentile 5-95 (cùng cách xử lý outlier như buildTerrainGeometry) rồi chuẩn hoá 0..1.
    const sorted = [...monotone].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
    const lo = pct(0.05);
    const hi = pct(0.95);
    const range = hi - lo || 1;
    const rows = new Float32Array(h);
    const nearness = new Float32Array(h);
    for (let i = 0; i < h; i++) {
      rows[i] = i;
      nearness[i] = Math.min(1, Math.max(0, (monotone[i] - lo) / range));
    }

    return { rows, nearness, imgHeight: h };
  } catch {
    return null; // lỗi tải/đọc ảnh -- nơi dùng tự rơi về công thức horizonY
  }
}

// Từ điểm bấm trên ảnh 2D (y 0..1) suy ra độ sâu 3D (0..maxDepth), dùng bảng hiệu chuẩn thật nếu có —
// nội suy tuyến tính giữa 2 hàng hiệu chuẩn gần nhất; nếu không có hiệu chuẩn (ảnh thiếu mask/chưa đủ
// dữ liệu đất) rơi về công thức phối cảnh xấp xỉ theo horizonY như trước.
function y2DToDepthResolved(y2D: number, calib: GroundCalibration | null, horizonY: number, maxDepth: number): number {
  if (!calib || calib.rows.length < 2) return y2DToDepth(y2D, horizonY, maxDepth);
  const targetRow = y2D * (calib.imgHeight - 1);
  const { rows, nearness } = calib;
  let nearnessAtRow: number;
  if (targetRow <= rows[0]) nearnessAtRow = nearness[0];
  else if (targetRow >= rows[rows.length - 1]) nearnessAtRow = nearness[rows.length - 1];
  else {
    let lo = 0;
    let hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] <= targetRow) lo = mid;
      else hi = mid;
    }
    const t = (targetRow - rows[lo]) / (rows[hi] - rows[lo] || 1);
    nearnessAtRow = nearness[lo] + t * (nearness[hi] - nearness[lo]);
  }
  return (1 - nearnessAtRow) * maxDepth; // nearness cao (gần) -> độ sâu thấp
}

// Chiều ngược: từ độ sâu 3D (sau khi kéo gizmo) suy ra lại toạ độ y trên ảnh 2D, dùng bảng hiệu chuẩn
// thật nếu có — tìm kiếm nhị phân trong mảng nearness (đã ép đơn điệu tăng dần theo rows khi dựng bảng).
function depthToY2DResolved(depth: number, calib: GroundCalibration | null, horizonY: number, maxDepth: number): number {
  if (!calib || calib.rows.length < 2) return depthToY2D(depth, horizonY);
  const targetNearness = Math.min(1, Math.max(0, 1 - depth / maxDepth));
  const { rows, nearness } = calib;
  let row: number;
  if (targetNearness <= nearness[0]) row = rows[0];
  else if (targetNearness >= nearness[nearness.length - 1]) row = rows[rows.length - 1];
  else {
    let lo = 0;
    let hi = nearness.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (nearness[mid] <= targetNearness) lo = mid;
      else hi = mid;
    }
    const t = (targetNearness - nearness[lo]) / (nearness[hi] - nearness[lo] || 1);
    row = rows[lo] + t * (rows[hi] - rows[lo]);
  }
  return Math.min(1, Math.max(0, row / (calib.imgHeight - 1)));
}

// Sàn phẳng DUY NHẤT cho mọi ảnh bối cảnh (không còn nhánh địa hình gồ ghề nữa, xem ghi chú ở
// buildGroundDepthCalibration phía trên) — dựng 1 mặt lưới phẳng RÕ RÀNG, cùng kích thước footprint
// (5x5) và phong cách màu nhất quán (xám sáng + khung dây), worldY luôn = 0 (KHÔNG lồi lõm gì, vẫn đúng
// quyết định cũ "luôn giữ sàn phẳng") — cho khung 3D luôn có mặt sàn rõ để nhân vật đứng lên.
// SỬA (phản hồi thật user: "texture và vị trí nhân vật không trùng toạ độ" — đo thật và xác nhận đúng,
// texture bản cũ dùng công thức TUYẾN TÍNH cho Z trong khi vị trí nhân vật dùng bảng hiệu chuẩn PHI
// TUYẾN TÍNH thật, 2 công thức khác nhau trên cùng 1 trục) — giờ truyền calib/horizonY vào đây, dùng
// ĐÚNG 1 hàm y2DToDepthResolved duy nhất (giống hệt hàm tính vị trí nhân vật) để suy Z cho từng HÀNG lưới
// — khoảng cách giữa các hàng không còn đều nhau nữa (co giãn theo đúng bảng thật), nhưng sàn vẫn phẳng
// tuyệt đối (Y=0), không phải lưới địa hình gồ ghề. UV giữ nguyên tuyến tính theo v gốc (không đổi) vì đó
// chỉ là toạ độ LẤY MẪU trên ảnh texture (không gian pixel ảnh, độc lập với vị trí thế giới 3D).
// SỬA (phản hồi thật user, chốt lại: "xóa sam đi mà hiệu ứng trên thảm 3D vẫn còn" — tắt texture rồi mà
// dải sương mù vẫn hiện trên chính sàn xám, vì mist trộn thẳng vào màu đỉnh lưới của CẢ sàn gốc, không
// riêng gì lớp texture đã tắt) — bỏ hẳn hiệu ứng màu sương, sàn luôn 1 màu xám đồng nhất, không gradient.
function buildFlatGroundGeometry(
  gridW = 24,
  gridH = 20,
  calib: GroundCalibration | null = null,
  horizonY = 0.5,
  maxDepth = 5,
  nearColor = new THREE.Color(0x475569)
): THREE.BufferGeometry {
  const positions = new Float32Array(gridW * gridH * 3);
  const colors = new Float32Array(gridW * gridH * 3);
  const uvs = new Float32Array(gridW * gridH * 2);
  for (let iy = 0; iy < gridH; iy++) {
    for (let ix = 0; ix < gridW; ix++) {
      const u = ix / (gridW - 1);
      const v = iy / (gridH - 1);
      const vi = (iy * gridW + ix) * 3;
      const z = -y2DToDepthResolved(v, calib, horizonY, maxDepth);
      positions[vi] = (u - 0.5) * 5;
      positions[vi + 1] = 0;
      positions[vi + 2] = z;
      colors[vi] = nearColor.r;
      colors[vi + 1] = nearColor.g;
      colors[vi + 2] = nearColor.b;
      const ui = (iy * gridW + ix) * 2;
      uvs[ui] = u;
      // Three.js mẫu texture với v=0 ở MÉP DƯỚI ảnh (quy ước flipY mặc định), còn v hình học ở đây ứng
      // với MÉP TRÊN ảnh gốc (v=0 -> xa/horizon, xem Z bên trên) -- phải lật lại mới khớp đúng ảnh gốc.
      uvs[ui + 1] = 1 - v;
    }
  }
  const indices: number[] = [];
  for (let iy = 0; iy < gridH - 1; iy++) {
    for (let ix = 0; ix < gridW - 1; ix++) {
      const a = iy * gridW + ix;
      const b = a + 1;
      const c = a + gridW;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// SỬA (phản hồi thật user: "kẻ lưới ô vuông bỏ lưới chéo đi" rồi "để cho nhân vật hiển thị đúng tâm thì
// em phải cho 2 lưới ngang dọc tại tâm, và từ đó mới phát triển lưới ra") — bản trước chia đều lưới theo
// CHỈ SỐ hàng/cột trong hệ toạ độ ảnh (u/v) rồi mới quy đổi sang thế giới 3D qua y2DToDepthResolved —
// công thức này PHI TUYẾN theo chiều sâu (dồn cụm gần mép xa khi chưa có ảnh bối cảnh thật để hiệu
// chuẩn), nên tâm hình học của lưới (v=0.5) KHÔNG trùng với tâm thật của thảm theo world Z (nơi nhân vật
// mặc định đứng — xem addCharacter() ở ThreeDBuilderClient.tsx, world Z=-2.5 ứng với y2D=0.75, không phải
// v=0.5). Đổi hẳn sang dựng lưới TRỰC TIẾP trong toạ độ thế giới (world space), đều tăm tắp theo đơn vị
// thật, XUẤT PHÁT từ đúng tâm thảm (centerX, centerZ) rồi lan đều ra 2 bên — đảm bảo LUÔN có đúng 1 đường
// ngang và 1 đường dọc đi qua chính giữa, bất kể chia bao nhiêu ô. Không còn phụ thuộc groundCalib/
// horizonY nữa (đây chỉ là lưới tham chiếu trực quan, không phải geometry sàn thật — sàn thật vẫn dùng
// buildFlatGroundGeometry với công thức hiệu chuẩn riêng, không đổi gì).
function buildGridLines(halfWidth: number, centerZ: number, depth: number, step: number): THREE.LineSegments {
  const positions: number[] = [];
  const minX = -halfWidth;
  const maxX = halfWidth;
  const minZ = -depth;
  const maxZ = 0;

  // Đường dọc (X cố định, chạy dọc theo Z) — bắt đầu từ centerX=0, lan ra 2 bên theo step cho tới khi
  // chạm biên thảm.
  for (let x = 0; x <= maxX + 1e-6; x += step) {
    positions.push(x, 0, minZ, x, 0, maxZ);
    if (x > 1e-6) positions.push(-x, 0, minZ, -x, 0, maxZ);
  }
  // Đường ngang (Z cố định, chạy ngang theo X) — bắt đầu từ centerZ (đúng tâm thật, nơi nhân vật mặc định
  // đứng), lan ra 2 bên theo step cho tới khi chạm biên thảm (kẹp trong [minZ, maxZ] vì centerZ có thể
  // không nằm giữa tuyệt đối khoảng đó).
  for (let z = centerZ; z <= maxZ + 1e-6; z += step) {
    positions.push(minX, 0, z, maxX, 0, z);
  }
  for (let z = centerZ - step; z >= minZ - 1e-6; z -= step) {
    positions.push(minX, 0, z, maxX, 0, z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xa1a1aa, transparent: true, opacity: 0.55 }));
}

// SỬA (phản hồi thật user: muốn 1 viền tím bao 3 cạnh trái/dưới/phải quanh ảnh 2D VÀ quanh mép khối
// 3D, để khách dễ đối chiếu hướng nhìn giữa 2 bên — đúng kiểu user tự vẽ tay bằng bút đỏ để kiểm chứng)
// — lấy ĐÚNG toạ độ các đỉnh biên của lưới đã dựng (bám theo độ cao thật tại từng điểm, không vẽ phẳng
// cứng) để viền không bị lơ lửng/chìm vào địa hình khi địa hình có độ cao thật. Thứ tự điểm: TRÁI (từ xa
// về gần) -> DƯỚI/GẦN (trái sang phải) -> PHẢI (gần ra xa) — đúng 1 nét liền, không vẽ cạnh TRÊN (ứng
// với mép xa/đỉnh ảnh 2D, cũng không viền trong bản gốc user vẽ tay).
function buildEdgeOutline(positions: Float32Array, gridW: number, gridH: number): THREE.Line {
  const pts: THREE.Vector3[] = [];
  for (let iy = 0; iy < gridH; iy++) {
    const vi = (iy * gridW + 0) * 3;
    pts.push(new THREE.Vector3(positions[vi], positions[vi + 1], positions[vi + 2]));
  }
  for (let ix = 0; ix < gridW; ix++) {
    const vi = ((gridH - 1) * gridW + ix) * 3;
    pts.push(new THREE.Vector3(positions[vi], positions[vi + 1], positions[vi + 2]));
  }
  for (let iy = gridH - 1; iy >= 0; iy--) {
    const vi = (iy * gridW + (gridW - 1)) * 3;
    pts.push(new THREE.Vector3(positions[vi], positions[vi + 1], positions[vi + 2]));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x8b5cf6, linewidth: 2 }));
  return line;
}

// SỬA (phản hồi thật user, gửi ảnh mẫu "khối cầu 3 vòng tròn": "hôm qua mình đã thiết kế các mũi tên để
// xoay nhân vật nhưng vẫn thấy chưa ổn nên mình sẽ thiết kế lại...bây giờ anh sẽ đưa cho em hình này để
// xoay nhân vật. Khi bấm vào nhân vật thì hình này hiện ra bên cạnh. Hình màu đỏ sẽ dùng để xoay nhân
// vật nằm ngửa, hình màu xanh lá sẽ xoay nhân vật nằm nghiêng (2 kiểu xoay này dùng tâm là gốc của
// vector di chuyển), hình màu xanh dương sẽ xoay nhân vật theo trục Y" — bỏ hẳn 2 kiểu thiết kế cũ
// (2 nửa cung + mũi tên kiểu Y, và 2 đường cong mảnh kiểu X/Z), thay bằng 3 VÒNG TRÒN ĐẦY ĐỦ lồng vào
// nhau tạo hình khối cầu, giống hệt ảnh mẫu — mỗi vòng là 1 "đường tròn lớn" (great circle) của hình
// cầu, nằm trong mặt phẳng VUÔNG GÓC với trục xoay mà nó đại diện. Dựng 1 hàm DÙNG CHUNG cho cả 3 trục:
// vẽ 1 vòng tròn đầy đủ (360°) nằm trong mặt phẳng XZ cục bộ (giả định trục xoay là Y cục bộ), rồi bọc
// trong 1 group NGOÀI xoay bằng quaternion để trục Y cục bộ đó trùng với trục xoay THẬT mong muốn (axis)
// — same kỹ thuật tái dùng hình học đã chứng minh hiệu quả ở các bản thiết kế trước, không cần tính lại
// công thức riêng cho từng trục.
// SỬA (phản hồi thật user: "bất kể lưới 3D đang ở vị trí nào khối hình cầu cũng phải theo chiều Z" + xác
// nhận "luôn quay mặt về camera (billboard)") — bỏ hẳn quaternion CỐ ĐỊNH gán 1 lần lúc tạo (world-aligned
// theo trục axis truyền vào) — giờ hướng của cả 3 vòng được tính lại MỖI KHUNG HÌNH dựa theo trục camera
// (xem updateGizmoBillboard, gọi trong loop() render), không phụ thuộc trục world X/Y/Z hay vị trí nhân
// vật/lưới 3D nữa — tham số `axis` ở đây chỉ còn dùng để set hướng ban đầu (tránh lóe hình 1 khung lúc mới
// tạo), updateGizmoBillboard sẽ ghi đè ngay khung hình kế tiếp.
// SỬA (phản hồi thật user: "cho các đường của hình cầu đậm nét thêm" — THREE.Line mảnh dùng LineBasicMaterial
// không thể chỉnh độ dày thật trên web (thuộc tính linewidth bị hầu hết trình duyệt/driver WebGL bỏ qua,
// luôn vẽ 1px bất kể set gì) — đổi hẳn sang ống (TubeGeometry) quét quanh đúng đường tròn cũ, có bề dày
// THẬT điều chỉnh được qua tubeRadius, nhìn đậm nét rõ ràng ở mọi trình duyệt/độ phân giải màn hình.
// SỬA (phản hồi thật user, gửi ảnh mẫu 1 vòng tròn chia 3 đoạn màu quanh nhân vật: "bây giờ không làm
// xoay theo hình cầu nữa mà em tạo 3 đoạn để tạo thành vòng tròn quanh nhân vật gồm 3 màu") — bỏ hẳn kiểu
// cũ "3 vòng tròn ĐẦY ĐỦ 360°, mỗi vòng nằm trên 1 mặt phẳng trục khác nhau tạo hình quả cầu" (khó bắt
// chuột vì có vòng nhìn gần như nghiêng hẳn cạnh tuỳ góc camera). Đổi sang "1 vòng tròn DUY NHẤT, chia 3
// CUNG 120° màu khác nhau, cả 3 cung CÙNG nằm trên 1 mặt phẳng LUÔN quay mặt thẳng về camera (billboard)"
// — luôn hiện tròn đều 100%, không bao giờ bị nhìn nghiêng cạnh dù ở góc camera gizmo nào, giải quyết dứt
// điểm việc khó bắt chuột do hình dạng elip méo. buildArcRing thay cho buildCircleRing cũ: chỉ vẽ 1 cung
// từ startAngle đến endAngle (radian) thay vì quét đủ 360°; quaternion căn hướng (facing) do nơi gọi
// truyền vào — DÙNG CHUNG CHO CẢ 3 CUNG để chúng luôn đồng phẳng, ghép lại thành 1 vòng tròn hoàn chỉnh.
// SỬA (lỗi thật phát hiện qua video màn hình user quay: "di chuột gần TÂM vòng tròn mới bắt trúng đường
// đỏ" — nguyên nhân KHÔNG phải thuật toán bắt chuột, mà là 2 chỗ định nghĩa kích thước khung gizmo LỆCH
// NHAU: effect dựng renderer dùng SIZE=220 (đã tăng từ 160 theo yêu cầu trước "to hơn hẳn"), nhưng div
// bọc ngoài (gizmoRingWrapRef, nơi pickGizmoRingAt đọc getBoundingClientRect() để tính toạ độ) vẫn còn
// hardcode width/height=160 — SÓT lại khi đổi SIZE, không có ai cập nhật theo. Canvas thật vẽ to 220px
// (tràn ra ngoài khung 160px khai báo), nhưng vùng bắt chuột lại tính theo khung 160px nhỏ hơn — khiến
// toàn bộ "vùng bắt" bị co lại còn ~73% và lệch về phía góc trên-trái so với hình vẽ thật mắt nhìn thấy,
// đúng y hệt triệu chứng "gần tâm mới bắt trúng cung ở rìa". Gộp về 1 hằng số DUY NHẤT dùng chung cho cả
// renderer lẫn CSS div để không thể lệch nhau lần nữa.
export const GIZMO_RING_SIZE = 220;

function buildArcRing(radius: number, color: number, startAngle: number, endAngle: number, facing: THREE.Quaternion): THREE.Group {
  const SEGMENTS = 32;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = startAngle + ((endAngle - startAngle) * i) / SEGMENTS;
    points.push(new THREE.Vector3(Math.cos(t) * radius, 0, Math.sin(t) * radius));
  }
  const curve = new THREE.CatmullRomCurve3(points, false); // cung hở, KHÔNG khép kín như vòng tròn đầy đủ
  // SỬA LẦN 3 (phản hồi thật user: "em cho nét nhỏ lại đi" — 0.3×radius quá to, user muốn nhỏ lại) — giảm
  // về 0.06×radius (≈6.6px đường kính — mỏng hơn hẳn bản 0.3, vẫn dày hơn bản gốc 0.035 một chút).
  // SỬA LẦN 4 (phản hồi thật user: "nét đậm quá" — giảm tiếp 0.06 -> 0.035×radius, mỏng hẳn lại.
  // SỬA LẦN 5 (phản hồi thật user: "mỏng thêm 1 nửa nữa" — giảm tiếp 0.035 -> 0.0175×radius).
  const tubeRadius = radius * 0.0175;
  const geo = new THREE.TubeGeometry(curve, SEGMENTS, tubeRadius, 8, false);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  const outer = new THREE.Group();
  outer.add(mesh);
  outer.quaternion.copy(facing);
  outer.visible = false;
  // SỬA (phản hồi thật user, test trên điện thoại thật: "lưới hình cầu rất khó bám chuột, băt chuôt khó
  // và không chính xác" — bản trước thêm 1 ống vô hình to hơn để raycast dễ trúng hơn, NHƯNG 3 ống vô
  // hình to của 3 trục chồng lấn nhau ngay gần tâm, raycast trả về trục đầu tiên trúng theo THỨ TỰ mảng
  // (x→y→z) chứ không phải trục GẦN NHẤT — bấm gần ranh giới 2 vòng dễ trúng nhầm trục kia ("không chính
  // xác"). Đổi hẳn cách bắt: lưu bán kính thật (radius) vào userData để pickGizmoRingAt tự tính khoảng
  // cách từ tia chuột tới ĐƯỜNG TRÒN của cả 3 trục rồi chọn trục GẦN NHẤT trong 1 ngưỡng rộng rãi — vừa dễ
  // bắt (ngưỡng rộng) vừa luôn đúng trục gần chuột nhất (không còn phụ thuộc thứ tự mảng).
  outer.userData.radius = radius;
  outer.userData.startAngle = startAngle;
  outer.userData.endAngle = endAngle;
  return outer;
}

// Xem trước 3D NHIỀU nhân vật cùng lúc, đặt đúng vị trí tương đối đã chọn trên ảnh bối cảnh 2D — mở
// rộng từ components/MannequinPreviewCard.tsx (vốn chỉ có 1 mannequin xoay tại chỗ). Khác biệt chính:
// (1) nhiều mannequin, mỗi cái nhân bản từ CÙNG 1 hình buildMannequin() (xem mục 18.3 kế hoạch đã lưu
// memory — không cần tạo model mới cho từng người), đặt vào world-position tính từ x/y; (2) địa hình
// (dựng từ Fal depth, xem buildTerrainGeometry) LUÔN ĐỨNG YÊN — camera cố định, không orbit cả cảnh
// nữa (bản trước làm vậy, user phản hồi không đúng ý: "đừng cho mô hình phong cảnh quay") — khách chỉ
// bấm-kéo TRÚNG 1 mannequin mới xoay riêng người đó tại chỗ (raycasting, xem pickMannequinAt), giống
// đúng cách mannequin đơn cũ hoạt động, áp dụng cho từng người khi có nhiều người.
export function LocationPositionStage3D({
  characters,
  depthImageUrl,
  groundMaskUrl,
  testPoints = [],
  onCharacterMove,
  onCharacterRotate,
  onCharacterRotateX,
  onCharacterRotateZ,
  onCharacterElevate,
  onCharacterScale,
  onCharacterSelect,
  onCharacterTransform,
  horizonY = 0.5,
  onCanvasReady,
  characterHeightUnits = 1.6,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // SỬA (phản hồi thật user: gửi ảnh mẫu gizmo trục X/Y/Z tự xoay theo góc camera, kiểu Blender/phần mềm
  // CAD, kèm nút "Reset view" — xác nhận qua AskUserQuestion: muốn bản TỰ XOAY THEO CAMERA THẬT, không
  // phải bản tĩnh) — mount riêng cho mini-scene gizmo (renderer/scene/camera THỨ HAI, độc lập hoàn toàn
  // với renderer chính, xem useEffect dựng gizmo bên dưới).
  const gizmoMountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // Raycast tìm nhân vật bị bấm trúng (xem pickMannequinAt/handlePointerDown) — bấm trúng LUÔN gắn gizmo
  // TransformControls ngay (không còn kiểu "kéo xoay tại chỗ" thô sơ cũ nữa). Dùng chung cho cả
  // pickRotateRingAt — SỬA (phản hồi thật user: "bỏ mũi tên...tạo 2 đường màu đỏ và xanh" — 2 cung
  // đỏ/xanh dương đổi từ ống Mesh dày sang THREE.Line mảnh, xem buildFixedArcHandle) — Line mặc định
  // ngưỡng bắt trúng (Line.threshold) rất nhỏ/khó bấm vì không còn "độ dày" vật lý như Mesh, phải tăng
  // ngưỡng lên thủ công mới bấm trúng dễ dàng được.
  const raycasterRef = useRef(
    (() => {
      const rc = new THREE.Raycaster();
      rc.params.Line = { threshold: 0.3 };
      return rc;
    })()
  );
  // SỬA (phản hồi thật user: "muốn xoay 3d chỉ cần giữ chuột phải và trái là xoay" — orbit giờ LUÔN bật,
  // không còn là 1 "chế độ" riêng phải bật/tắt nữa, xem updateCamera/handlePointerDown) — các ref dưới
  // đây vẫn giữ nguyên (azimuth/pitch/distance quanh INSPECT_TARGET, điều khiển bằng kéo chuột/lăn chuột),
  // chỉ bỏ state bật/tắt inspectMode vì không cần phân nhánh theo chế độ nữa.
  const INSPECT_TARGET = { x: 0, y: 0.4, z: -2.3 }; // trùng điểm ngắm mặc định, xem updateCamera bên dưới
  // SỬA (phản hồi thật user, gửi ảnh mẫu khối cầu 3 vòng: "khối cầu luôn phải có góc nhìn thế này" — xoay
  // góc nhìn mặc định sang phải 1 chút (azimuth > 0) để khối cầu hiện ra đúng kiểu ảnh mẫu (vòng xanh lá to
  // tròn, xanh dương/đỏ rõ 2 elip) ngay khi vào trang — KHÔNG đụng tới toạ độ trục X/Y/Z thật của gizmo hay
  // công thức xoay, chỉ đổi góc camera mặc định.
  // SỬA (phản hồi thật user: "đường tròn màu đỏ đang bị camera chiếu thẳng chỉ cho ra 1 đường thẳng, cho
  // camera xoay lệch sang bên phải 1 chút" — vòng đỏ (trục X world cố định, xem updateGizmoBillboard) vẫn
  // còn gần như edge-on ở azimuth 20°, tăng thêm lên 35° để nhìn xéo rõ hơn, không còn dẹt thành 1 đường.
  const INSPECT_DEFAULTS = { azimuth: (35 * Math.PI) / 180, pitch: (43.2 * Math.PI) / 180, distance: 6.72 }; // khớp đúng góc nhìn mặc định
  const inspectAzimuthRef = useRef(INSPECT_DEFAULTS.azimuth);
  const inspectPitchRef = useRef(INSPECT_DEFAULTS.pitch);
  const inspectDistanceRef = useRef(INSPECT_DEFAULTS.distance);
  const orbitDragRef = useRef<{ dragging: boolean; startX: number; startY: number; startAzimuth: number; startPitch: number }>({
    dragging: false,
    startX: 0,
    startY: 0,
    startAzimuth: 0,
    startPitch: 0,
  });
  // SỬA (phản hồi thật user: "khi nhấp chuột trái vào nhân vật cho mũi tên vector để di chuyển" — bấm
  // trúng nhân vật LUÔN gắn ngay gizmo TransformControls, không cần bật chế độ gì trước, xem
  // handlePointerDown) — showY=false, chỉ cho kéo ngang mặt đất X/Z, không kéo lên trời được (đúng ràng
  // buộc nhân vật luôn đứng trên sàn). draggingTransformRef để tạm NGƯNG effect dựng lại mannequin (bên
  // dưới) trong lúc đang kéo — nếu không ngưng, mỗi lần gọi onCharacterMove cập nhật locationPositions ở
  // component cha sẽ làm characters đổi reference, effect dựng lại chạy lại, PHÁ HUỶ đúng group đang gắn
  // gizmo giữa chừng cú kéo.
  const transformControlsRef = useRef<TransformControls | null>(null);
  const draggingTransformRef = useRef(false);
  const attachedCharacterUrlRef = useRef<string | null>(null);
  // SỬA (phản hồi thật user: "cho vector di chuyển này lên ngang hông của người" — TransformControls gắn
  // thẳng vào group nhân vật trước đây vẽ tay cầm ngay tại CHÂN (group.position luôn ở y=0, xem effect
  // dựng mannequin) vì đó là gốc toạ độ group) — không gắn trực tiếp vào group nữa, mà gắn vào 1
  // "handle" rỗng (Object3D không có hình, chỉ dùng làm điểm neo) đặt cao hơn group đúng bằng
  // HIP_HEIGHT_FRACTION chiều cao nhân vật, giữ group lại để biết object nào đang được NHẮM (đọc/ghi vị
  // trí thật) — objectChange/dragging-changed đọc toạ độ X/Z từ handle (không đổi theo chiều cao nên vẫn
  // đúng vị trí mặt đất) rồi tự đồng bộ NGƯỢC sang group.position để nhân vật thật di chuyển theo.
  const gizmoHandleRef = useRef<THREE.Object3D | null>(null);
  const attachedGroupRef = useRef<THREE.Group | null>(null);
  const HIP_HEIGHT_FRACTION = 0.52;
  // SỬA (phản hồi thật user: "kéo gốc của tay cầm nên ngang hông nấy đó làm tâm" — xác nhận qua
  // AskUserQuestion: muốn tay cầm dịch chuyển quay LẠI ngang hông, không còn ở mắt cá chân nữa (bản mắt cá
  // chân trước đó chỉ để tránh z-fighting với sàn, nhưng user ưu tiên tay cầm ở hông hơn) — dùng CHUNG
  // fraction với khối cầu (HIP_HEIGHT_FRACTION), tay cầm và khối cầu lại cùng ở 1 độ cao như trước.
  const HANDLE_HEIGHT_FRACTION = HIP_HEIGHT_FRACTION;
  // SỬA (phản hồi thật user: "vòng tròn xoay chỉ để gần 2 nửa đường tròn và có mũi tên xoay thôi") — tự
  // vẽ vòng cung xoay (xem buildAxisRotateHandle), KHÔNG dùng rotate-mode của TransformControls nữa —
  // ringDragRef theo dõi kéo thủ công (dx chuột -> góc xoay), giống hệt công thức kéo-xoay-tại-chỗ cũ
  // đã dùng trước khi có TransformControls (xem lịch sử handlePointerMove).
  // rotateRingRef: trục Y (quay đứng tại chỗ, màu cyan, đặt dưới CHÂN — giữ nguyên như cũ).
  // SỬA (phản hồi thật user, gửi ảnh mẫu "Edit Pose": "lấy gốc của vector di chuyển làm tâm, hãy tạo
  // vòng cung màu đỏ...nằm ngửa, vòng cung màu xanh...nằm nghiêng") — pitchRingRef (trục X, đỏ, "nằm
  // ngửa"/ngả trước-sau) và rollRingRef (trục Z, xanh dương, "nằm nghiêng"/lật trái-phải), CẢ 2 đặt
  // ngang HÔNG (trùng gốc tay cầm dịch chuyển gizmoHandleRef), khác với rotateRingRef (ở chân).
  const rotateRingRef = useRef<THREE.Group | null>(null);
  const pitchRingRef = useRef<THREE.Group | null>(null);
  const rollRingRef = useRef<THREE.Group | null>(null);
  // SỬA (phản hồi thật user: "em phải tách cho khối cầu ra 1 camera riêng biệt, khi xoay khối 3D mới
  // không ảnh hưởng tới khối cầu được" — xác nhận qua AskUserQuestion: muốn khối cầu ĐÓNG BĂNG hoàn toàn,
  // luôn hiện đúng 1 hình dạng cố định) — mount/renderer/scene/camera THỨ HAI, hoàn toàn độc lập với
  // renderer chính, chỉ để vẽ riêng 3 vòng xoay — camera này KHÔNG BAO GIỜ đổi hướng (dựng 1 lần, đứng
  // yên mãi mãi), nên khối cầu luôn hiện đúng 1 hình dạng dù camera chính xoay góc nào. Mỗi khung hình chỉ
  // cập nhật VỊ TRÍ (CSS, qua gizmoRingWrapRef) của khung canvas nhỏ này sao cho trùng đúng điểm hông nhân
  // vật đang chọn chiếu lên màn hình (tính bằng camera CHÍNH — xem effect "ring gizmo" bên dưới).
  const gizmoRingWrapRef = useRef<HTMLDivElement | null>(null);
  const gizmoRingMountRef = useRef<HTMLDivElement | null>(null);
  const gizmoRingRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const gizmoRingSceneRef = useRef<THREE.Scene | null>(null);
  const gizmoRingCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // SỬA (phản hồi thật user: "làm 2 nút tạm thời Di chuyển và Xoay phía trên màn hình bên trái để tách
  // riêng 2 cái, khi nào nhấn vào nút nào thì cái đó hiện ra để thử" — thêm chế độ xem riêng TẠM THỜI để
  // test độ chính xác từng tay cầm độc lập, không chồng lẫn 2 gizmo cùng lúc như mặc định hiện tại.
  // SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả tay cầm dịch chuyển + vòng xoay cùng lúc,
  // hover bên nào ẩn bớt bên kia" — bỏ hẳn khái niệm mode (gizmoModeRef đã xoá), cả 2 bộ tay cầm giờ LUÔN
  // được gắn + hiện cùng lúc khi chọn nhân vật, việc ẩn/hiện qua lại chuyển hẳn sang syncGizmoVisibility()
  // (dựa theo hover, chạy mỗi khung hình trong loop() của renderer chính).
  // SỬA (phản hồi thật user: "các đường tròn của hình cầu rất khó bắt chuột, khi chuột vào đường tròn nào
  // thì đường tròn đó chuyển sang màu vàng để nhận biết, các đường tròn khác tạm thời ẩn đi cho màn hình
  // đỡ rối" — theo dõi trục đang được RÊ CHUỘT QUA (hover, khác với đang KÉO) để đổi màu + ẩn/hiện, xem
  // updateRingHover.
  const hoveredRingAxisRef = useRef<"x" | "y" | "z" | null>(null);
  // SỬA (phản hồi thật user: "khi xoay nằm ngửa và nằm nghiêng lấy gốc vector làm tâm" — bản trước xoay
  // quanh GỐC GROUP (luôn ở y=0, ngang CHÂN), khiến nhân vật "quay như cây cột cắm đất" thay vì ngả quanh
  // hông) — thêm pivotWorld: toạ độ THẾ GIỚI của điểm hông, chốt lại ngay lúc BẮT ĐẦU kéo, dùng suốt quá
  // trình kéo để tính lại group.position mỗi khung sao cho đúng điểm hông đó luôn đứng yên khi xoay (xem
  // công thức pivot ở handlePointerMove).
  const ringDragRef = useRef<{
    dragging: boolean;
    axis: "x" | "y" | "z";
    startX: number;
    startRotation: number;
    pivotWorld: THREE.Vector3;
  }>({
    dragging: false,
    axis: "y",
    startX: 0,
    startRotation: 0,
    pivotWorld: new THREE.Vector3(),
  });
  // SỬA (phản hồi thật user: "mũi tên này hiện ngay cùng nhân vật chỉ cần chỏ chuột vào di chuyển thôi
  // không cần qua nút xoay nữa" — trước đây phải bấm nút "Xoay" mới hiện tay cầm xoay, giờ CẢ 2 tay cầm
  // (dịch chuyển + xoay) LUÔN hiện cùng lúc ngay khi chọn nhân vật, xem selectCharacter) — bỏ hẳn khái
  // niệm "chế độ" (translate/rotate), không còn cần chuyển qua lại nữa.
  const [, forceRerender] = useState(0);
  // Đọc horizonY mới nhất trong objectChange handler (effect setup chính có deps []) mà không cần re-run
  // toàn bộ effect (tạo lại renderer/scene) mỗi khi horizonY đổi.
  const horizonYRef = useRef(horizonY);
  horizonYRef.current = horizonY;
  // Bảng hiệu chuẩn "hàng ảnh <-> độ gần/xa thật" dựng từ depth map + ground mask thật của ảnh này (xem
  // buildGroundDepthCalibration) — chính xác hơn hẳn công thức horizonY xấp xỉ, dùng khi có đủ dữ liệu.
  const [groundCalib, setGroundCalib] = useState<GroundCalibration | null>(null);
  const groundCalibRef = useRef<GroundCalibration | null>(null);
  groundCalibRef.current = groundCalib;

  useEffect(() => {
    let cancelled = false;
    if (!depthImageUrl) {
      setGroundCalib(null);
      return;
    }
    buildGroundDepthCalibration(depthImageUrl).then((calib) => {
      if (!cancelled) setGroundCalib(calib);
    });
    return () => {
      cancelled = true;
    };
  }, [depthImageUrl]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // SỬA (phản hồi thật user: trang "3D Builder" cần xuất PNG từ đúng khung nhìn đang hiển thị) —
    // preserveDrawingBuffer: true để canvas.toDataURL() đọc được đúng khung hình vừa vẽ (mặc định
    // WebGL tự xoá buffer ngay sau mỗi khung hình để tiết kiệm bộ nhớ, toDataURL() gọi sau đó sẽ ra ảnh
    // trống/đen nếu không bật cờ này). Không ảnh hưởng hiệu năng đáng kể ở quy mô 1 khung 3D nhỏ này.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    // SỬA (phản hồi thật user: "vẫn nhoè" sau khi đã bật anisotropic filtering) — renderer.setPixelRatio
    // chưa từng được gọi, Three.js mặc định render ở tỉ lệ 1:1 pixel bất kể màn hình thật có mật độ điểm
    // ảnh cao hơn (Windows scale 125%/150%, màn Retina...), khiến CẢ KHUNG 3D (không riêng texture) bị
    // render ở độ phân giải thấp hơn thật rồi phóng to lên — đây mới là nguyên nhân chính của nhoè chung,
    // anisotropy chỉ xử lý được phần nhoè do góc nhìn chéo. Giới hạn ở 2 để tránh quá tải GPU trên màn
    // hình có pixel ratio rất cao.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    onCanvasReady?.(renderer.domElement);

    const scene = new THREE.Scene();
    // SỬA (phản hồi thật user: "cho sáng lên tí nữa") — tăng nhẹ cả 2 nguồn sáng.
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 3, 2);
    scene.add(dirLight);

    // Mặt đất mờ — chỉ để mắt có điểm neo chiều sâu khi xoay, không phải khối 3D thật dựng từ Fal.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(6, 32),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 1, transparent: true, opacity: 0.35 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    cameraRef.current = camera;
    sceneRef.current = scene;

    // SỬA (phản hồi thật user: "em vẽ chưa đạt", khối 3D hiện ra như 1 lát mỏng/dẹt thay vì địa hình)
    // — camera cũ gần như NGANG TẦM với lưới địa hình (chỉ cao 3.4, nhìn thẳng dọc trục Z, đúng trục
    // chiều sâu của lưới) nên toàn bộ chiều sâu Z (5 đơn vị) bị "ép dẹt" về gần như 1 điểm trên màn
    // hình theo hướng nhìn — chỉ còn thấy bề rộng X và chiều cao Y mỏng, giống đúng hình lát dẹt user
    // chụp. Nâng camera cao hẳn lên (góc nhìn chéo từ trên xuống, kiểu bản đồ nổi) + ngắm vào giữa lưới
    // địa hình (Z=-2.5, không phải mép gần Z=0) để chiều sâu hiện rõ thành khoảng cách trên màn hình
    // thay vì chồng lên hướng nhìn. KHÔNG đổi azimuth (vẫn 0, cố định) — giữ đúng tương ứng trái/phải
    // giữa ảnh 2D và khung 3D cho vị trí nhân vật.
    // SỬA (biên độ cao tăng 2.2 -> 3.6, đỉnh cao hơn trước) — nâng camera + điểm ngắm lên chút để đỉnh
    // cao nhất không bị khung hình cắt mất, vẫn giữ nguyên azimuth=0 (tương ứng trái/phải với ảnh 2D).
    // SỬA (phản hồi thật user: "cho full khung 3d" — sau khi phóng to khung hiển thị, khối địa hình
    // trông nhỏ lọt thỏm giữa nhiều khoảng tối trống xung quanh) — đo thử bằng script riêng (đếm % pixel
    // thật sự có vẽ khối trong khung, xem file test đã dùng) để tìm đúng thông số thay vì đoán mò: kéo
    // camera gần hơn KHÔNG ĐỦ (chỉ zoom, khoảng trống phía TRÊN khối vẫn y nguyên tỷ lệ vì góc nhìn
    // không đổi) — phải NGHIÊNG CAMERA XUỐNG SÂU HƠN (hạ bớt khoảng cách ngang theo Z so với độ cao,
    // nhìn gần như từ trên xuống hơn) để giảm hẳn khoảng trời trống phía trên khối, đo được tăng từ
    // ~27% lấp đầy khung lên ~43%. KHÔNG đổi azimuth (vẫn 0, tương ứng trái/phải với ảnh 2D).
    function updateCamera() {
      // SỬA (phản hồi thật user: "muốn xoay 3d chỉ cần giữ chuột phải và trái là xoay" — trước đây phải
      // bấm bật "Xem chi tiết" hoặc "Di chuyển" mới xoay được, mặc định camera CỐ ĐỊNH) — bỏ hẳn nhánh
      // camera cố định cũ, LUÔN dùng công thức orbit quanh INSPECT_TARGET theo azimuth/pitch/distance (xem
      // handlePointerDown/handlePointerMove — giờ kéo chuột ở vùng trống BẤT KỲ lúc nào cũng xoay, không
      // cần bật chế độ nào nữa). INSPECT_DEFAULTS đã được đo khớp đúng góc nhìn cố định cũ (xem khai báo),
      // nên lần hiện đầu tiên KHÔNG đổi gì so với trước, chỉ khác là giờ kéo được.
      const az = inspectAzimuthRef.current;
      const pitch = inspectPitchRef.current;
      const dist = inspectDistanceRef.current;
      camera.position.set(
        INSPECT_TARGET.x + Math.sin(az) * Math.cos(pitch) * dist,
        INSPECT_TARGET.y + Math.sin(pitch) * dist,
        INSPECT_TARGET.z + Math.cos(az) * Math.cos(pitch) * dist
      );
      camera.lookAt(INSPECT_TARGET.x, INSPECT_TARGET.y, INSPECT_TARGET.z);
    }
    updateCamera();

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // Gizmo mũi tên XYZ kéo nhân vật, gắn ngay khi bấm trúng (xem handlePointerDown). SỬA (phản hồi thật
    // user: "không có chiều lên xuống à" — xác nhận muốn thêm trục Y để nhấc nhân vật khỏi mặt sàn, vd
    // đứng lên bậc thang) — showY=true, cho kéo cả lên/xuống (xem elevationY ở PositionedCharacter).
    // Thêm getHelper() vào scene (bản three.js mới, API tách riêng phần hiển thị khỏi logic điều khiển),
    // chưa gắn vào object nào (object=undefined) cho tới khi khách bấm trúng 1 nhân vật.
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode("translate");
    transformControls.showY = true;
    // SỬA (phản hồi thật user: "mũi tên của tay cầm ngắn và đang nằm trong khối cầu" — xác nhận qua
    // AskUserQuestion: muốn mũi tên dài hơn, thò ra ngoài khối cầu — tăng size 0.8 -> 1.5 để đầu mũi tên
    // vượt ra ngoài bán kính khối cầu (0.5), dễ nhìn thấy và dễ bấm trúng hơn.
    transformControls.size = 1.5;
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    // "Handle" rỗng làm điểm neo cho gizmo — xem ghi chú ở khai báo gizmoHandleRef phía trên.
    const gizmoHandle = new THREE.Object3D();
    scene.add(gizmoHandle);
    gizmoHandleRef.current = gizmoHandle;

    // SỬA (phản hồi thật user: "em phải tách cho khối cầu ra 1 camera riêng biệt, khi xoay khối 3D mới
    // không ảnh hưởng tới khối cầu được" — xác nhận qua AskUserQuestion: muốn khối cầu ĐÓNG BĂNG hoàn
    // toàn, luôn hiện đúng 1 hình dạng cố định bất kể camera chính xoay góc nào) — bỏ hẳn việc dựng 3 vòng
    // NGAY TRONG scene chính này (vốn dùng chung camera chính nên không thể tách biệt hoàn toàn được) —
    // chuyển sang dựng ở 1 mini-scene + camera THỨ HAI, hoàn toàn độc lập (xem effect "ring gizmo" riêng
    // bên dưới, cùng kiểu với gizmoMountRef/compass góc phải).

    // SỬA (phản hồi thật user: "khoá không cho nhân vật bị kéo vượt ra khỏi thảm") — thảm 3D rộng đúng
    // X: -2.5..2.5, Z: -5..0 (xem buildFlatGroundGeometry/công thức (u-0.5)*5 và -(1-v)*5 ở trên) — nhân
    // vật kéo ra ngoài vùng này sẽ "lơ lửng" ngoài thảm, không hợp lý. KHÔNG kẹp biên ngay trong lúc kéo
    // (objectChange) vì bài học cũ: ghi đè obj.position giữa chừng phá vỡ cách TransformControls tự tính
    // delta bước kéo tiếp theo, gây lệch trục Z (xem comment "kéo về trục Z thì ảnh 2D vị trí sai" bên
    // dưới) — chỉ kẹp biên 1 LẦN DUY NHẤT ngay khi BUÔNG TAY (dragging-changed, value=false), không còn
    // ảnh hưởng gì tới các bước kéo giữa chừng nữa.
    const MAT_HALF_WIDTH = 2.5; // X: -2.5..2.5
    const MAT_DEPTH = 5; // Z: -5..0
    // SỬA (phản hồi thật user: "không có chiều lên xuống à" — thêm trục Y, giới hạn 0..3 world unit để
    // không kéo xuyên sàn (âm) hay bay quá cao mất kiểm soát).
    const MIN_ELEVATION = 0;
    const MAX_ELEVATION = 3;
    transformControls.addEventListener("dragging-changed", (event) => {
      draggingTransformRef.current = !!event.value;
      if (event.value) return; // vừa bắt đầu kéo -- không kẹp, chỉ kẹp lúc buông tay
      // SỬA (phản hồi thật user: "mũi tên vừa kéo di chuyển vừa xoay nhân vật" — race condition: listener
      // pointerdown NỘI BỘ của TransformControls gắn thẳng vào canvas, chạy TRƯỚC handlePointerDown React
      // (bubble phase), nên dù handlePointerDown phát hiện trúng ring và tắt tc.enabled NGAY, sự kiện
      // "dragging-changed(true)" của TransformControls đôi khi đã kịp nổ ra 1 lần. Nếu để handler này chạy
      // tiếp, nó sẽ ghi obj.position (vị trí CŨ, chưa đổi vì enabled=false đã chặn pointermove tiếp theo)
      // ĐÈ LÊN group.position — có thể xoá mất độ dịch chuyển mà pivot xoay X/Z vừa tạo ra. Bỏ qua hẳn nếu
      // đang trong 1 lượt kéo ring (ringDragRef.dragging) hoặc tc đang bị tắt — chắc chắn đây không phải
      // 1 cú kéo dịch chuyển thật.
      if (ringDragRef.current.dragging || !transformControls.enabled) return;
      const obj = transformControls.object; // = gizmoHandle (xem ghi chú gizmoHandleRef)
      const url = attachedCharacterUrlRef.current;
      const group = attachedGroupRef.current;
      if (!obj || !group) return;
      // SỬA (phản hồi thật user: "khối tay cầm gắn vào trong tâm nhân vật tách biệt không dính vào khối
      // cầu" — tay cầm dịch chuyển (gizmoHandle) giờ gắn gần gốc nhân vật (+ handleOffsetY nhỏ, xem
      // HANDLE_HEIGHT_FRACTION — chỉ đủ cao để tránh z-fighting với sàn, SỬA LẦN 2: "khó bắt chuột để di
      // chuyển" phát hiện mũi tên trùng y=0 với mặt sàn), tách hẳn khỏi khối cầu xoay (vẫn ở ngang hông —
      // xem pivot X/Z và gizmoRing loop, KHÔNG đổi) — 2 tay cầm không còn chồng lên nhau.
      // SỬA LẦN 3 (phản hồi thật user, gửi ảnh chụp nhân vật nằm ngửa: "gốc của tay kéo không gắn vào
      // trong tâm nhân vật" — offset trước đây CỘNG THẲNG vào world Y, không xoay theo group.rotation, nên
      // khi nhân vật đã xoay (nằm ngửa/nghiêng qua vòng xoay riêng), tay cầm vẫn trôi theo true-vertical
      // thay vì bám đúng hướng "lên" cục bộ của thân người — tách hẳn khỏi tâm nhân vật nhìn thấy. Xoay
      // offset theo group.rotation (công thức y hệt hipWorld/rotatedHip ở applyRingDrag) — offset giờ có
      // thể có cả thành phần X/Z (không chỉ Y) khi nhân vật nằm nghiêng, nên phải trừ lại ĐỦ CẢ 3 TRỤC khi
      // quy đổi obj.position (tay cầm, đã lệch theo offset) về group.position (chân THẬT) — không chỉ trừ
      // mỗi Y như code cũ (chỉ đúng khi offset thuần đứng, nhân vật chưa xoay gì).
      const handleOffsetY = (group.userData.handleOffsetY as number) ?? 0;
      const rotatedOffset = new THREE.Vector3(0, handleOffsetY, 0).applyEuler(group.rotation);
      const clampedX = Math.min(MAT_HALF_WIDTH, Math.max(-MAT_HALF_WIDTH, obj.position.x - rotatedOffset.x));
      const clampedZ = Math.min(0, Math.max(-MAT_DEPTH, obj.position.z - rotatedOffset.z));
      const clampedElevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, obj.position.y - rotatedOffset.y));
      obj.position.x = clampedX + rotatedOffset.x;
      obj.position.z = clampedZ + rotatedOffset.z;
      obj.position.y = clampedElevation + rotatedOffset.y;
      // Đồng bộ ngược sang group THẬT.
      group.position.x = clampedX;
      group.position.z = clampedZ;
      group.position.y = clampedElevation;
      if (!url) return;
      onCharacterElevate?.(url, clampedElevation);
      if (!onCharacterMove) return;
      const x = Math.min(1, Math.max(0, clampedX / 5 + 0.5));
      const depth = Math.min(5, Math.max(0, -clampedZ));
      const y = depthToY2DResolved(depth, groundCalibRef.current, horizonYRef.current, 5);
      onCharacterMove(url, { x, y });
    });
    transformControls.addEventListener("objectChange", () => {
      const obj = transformControls.object; // = gizmoHandle
      const url = attachedCharacterUrlRef.current;
      const group = attachedGroupRef.current;
      if (!obj || !url || !group) return;
      // SỬA (phản hồi thật user: "vòng tròn xoay chỉ để gần 2 nửa đường tròn và có mũi tên xoay thôi") —
      // TransformControls giờ CHỈ còn dùng cho dịch chuyển (luôn setMode("translate") cố định, xem effect
      // dựng renderer) — chế độ xoay tự vẽ riêng (ringDragRef/pickRotateRingAt), không qua đây nữa.
      // Đồng bộ X/Z/Y sang group THẬT mỗi khung kéo. SỬA (phản hồi thật user: "tay cầm gắn vào tâm nhân
      // vật tách biệt không dính khối cầu" + "khó bắt chuột để di chuyển") — handle giờ gắn gần gốc nhân
      // vật (+ handleOffsetY nhỏ, tránh z-fighting với sàn) — xem ghi chú ở attachTranslateHandle.
      // SỬA LẦN 2 (phản hồi thật user: "gốc của tay kéo không gắn vào trong tâm nhân vật" khi nhân vật đã
      // xoay — xem ghi chú đầy đủ ở "dragging-changed" phía trên) — offset giờ XOAY theo group.rotation
      // (có thể lệch cả X/Z, không chỉ Y), nên phải trừ ĐỦ CẢ 3 TRỤC khi quy obj.position (tay cầm) về
      // group.position (chân THẬT), không chỉ trừ mỗi Y như trước.
      const handleOffsetY = (group.userData.handleOffsetY as number) ?? 0;
      const rotatedOffset = new THREE.Vector3(0, handleOffsetY, 0).applyEuler(group.rotation);
      group.position.x = obj.position.x - rotatedOffset.x;
      group.position.z = obj.position.z - rotatedOffset.z;
      group.position.y = obj.position.y - rotatedOffset.y;
      onCharacterElevate?.(url, group.position.y);
      reportTransform(group, url);
      if (!onCharacterMove) return;
      // SỬA (phản hồi thật user: "kéo về trục Z thì ảnh 2D vị trí sai") — bản trước GHI ĐÈ NGƯỢC LẠI
      // obj.position ngay trong lúc đang kéo (để kẹp biên) — TransformControls tự theo dõi vị trí nội
      // bộ để tính delta cho bước kéo TIẾP THEO (dựa trên con trỏ chuột di chuyển bao nhiêu so với vị
      // trí NÓ nhớ), nếu mình chen vào đổi obj.position giữa chừng thì làm lệch hẳn phép tính nội bộ đó
      // ở bước sau — lệch rõ nhất ở trục Z vì biên hẹp hơn X (-5..0 so với -2.5..2.5) nên bị ghi đè
      // thường xuyên hơn. SỬA: không đụng vào obj.position nữa trong lúc kéo — chỉ ĐỌC (không ghi), kẹp
      // biên cho dữ liệu x,y gửi SANG 2D thôi, để nguyên vị trí 3D thật cho thư viện tự quản lý.
      // SỬA LẦN 2 (phản hồi thật user: chấm 2D bay lên trời khi kéo xa) — y không còn tính tuyến tính
      // theo obj.position.z nữa. SỬA LẦN 3 (phản hồi thật user: "cải thiện nhưng chưa sát mặt đất") —
      // dùng bảng hiệu chuẩn thật (groundCalibRef, dựng từ depth map + ground mask thật của ảnh) thay vì
      // công thức horizonY xấp xỉ chung khi có đủ dữ liệu — xem depthToY2DResolved ở đầu file.
      // SỬA LẦN 4 (cùng lý do offset xoay ở trên) — dùng group.position.x/z (đã trừ đúng offset xoay) thay
      // vì obj.position.x/z thẳng, nếu không toạ độ 2D sẽ lệch theo đúng hướng offset khi nhân vật nghiêng.
      const x = Math.min(1, Math.max(0, group.position.x / 5 + 0.5));
      const depth = Math.min(5, Math.max(0, -group.position.z));
      const y = depthToY2DResolved(depth, groundCalibRef.current, horizonYRef.current, 5);
      onCharacterMove(url, { x, y });
    });

    let raf = 0;
    function loop() {
      updateCamera();
      syncGizmoVisibility();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      transformControls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SỬA (phản hồi thật user: gizmo "Di chuyển" kẹt ở trạng thái "đang kéo" mãi mãi, tự trôi vị trí) —
  // "an toàn kép" thứ 2: ngoài việc gọi pointerUp(null) ở handlePointerUp của chính khung 3D (bắt được
  // hầu hết trường hợp), lắng nghe THÊM pointerup trên CẢ CỬA SỔ (window) — phòng trường hợp khách thả
  // chuột HẲN RA NGOÀI khung 3D (ra cả phần ảnh 2D, hoặc ngoài trình duyệt) khiến cả canvas lẫn div bọc
  // ngoài đều không bắt được sự kiện thả chuột, this.dragging kẹt true vĩnh viễn.
  useEffect(() => {
    const onWindowPointerUp = () => {
      const tc = transformControlsRef.current;
      if (!tc) return;
      tc.pointerUp(null);
      // SỬA (phản hồi thật user: "mũi tên vừa kéo di chuyển vừa xoay") — an toàn kép, phòng trường hợp
      // thả chuột ngoài khung 3D NGAY lúc đang kéo ring (tc.enabled đã tắt tạm ở handlePointerDown) mà
      // không đi qua handlePointerUp/Leave để bật lại.
      // SỬA (giữ nhất quán với handlePointerUp/Leave, bỏ hẳn khái niệm mode) — chỉ bật lại khi còn nhân
      // vật đang được chọn.
      tc.enabled = !!attachedGroupRef.current;
      ringDragRef.current.dragging = false;
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    return () => window.removeEventListener("pointerup", onWindowPointerUp);
  }, []);

  // SỬA (phản hồi thật user: gửi ảnh mẫu gizmo trục X/Y/Z tự xoay theo góc camera + nút "Reset view",
  // xác nhận muốn bản TỰ XOAY THEO CAMERA THẬT kiểu Blender/CAD, không phải bản tĩnh) — dựng 1 renderer +
  // scene + camera trực giao (orthographic) THỨ HAI, hoàn toàn độc lập với renderer chính (khung 3D lớn),
  // chỉ để vẽ 6 quả cầu trục ±X/±Y/±Z. Mỗi khung hình đọc CHÍNH inspectAzimuthRef/inspectPitchRef (dùng
  // chung với camera chính, xem updateCamera ở effect [] phía trên) để đặt camera gizmo cùng góc — gizmo
  // tự xoay khớp 100% với góc nhìn chính mà không cần đồng bộ state/props gì thêm. Bấm vào 1 quả cầu ->
  // raycast trong scene NHỎ này -> set thẳng inspectAzimuthRef/inspectPitchRef sang góc chuẩn tương ứng
  // (camera CHÍNH đọc đúng 2 ref này mỗi khung hình nên tự nhảy theo ngay, không cần gọi gì thêm).
  useEffect(() => {
    const mount = gizmoMountRef.current;
    if (!mount) return;
    const SIZE = 84;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(SIZE, SIZE);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const FRUSTUM = 2.6;
    const camera = new THREE.OrthographicCamera(-FRUSTUM / 2, FRUSTUM / 2, FRUSTUM / 2, -FRUSTUM / 2, 0.1, 10);

    type AxisDef = { label: string; dir: THREE.Vector3; color: string; solid: boolean; azimuth: number; pitch: number };
    // SIDE_PITCH: góc nghiêng nhẹ cho các hướng ngang (X/-X/Z/-Z) — không dùng pitch=0 tuyệt đối vì
    // handleWheel/MIN_PITCH đã giới hạn pitch thật trong [10°, 85°], tránh camera chính "giật" về biên
    // ngay sau khi bấm. TOP_PITCH=85° đứng cho cả Y/-Y vì cảnh chỉ có 1 mặt sàn, không có "góc nhìn từ
    // dưới sàn lên" có ý nghĩa gì để phân biệt riêng 2 hướng này.
    const SIDE_PITCH = (20 * Math.PI) / 180;
    const TOP_PITCH = (85 * Math.PI) / 180;
    const axes: AxisDef[] = [
      { label: "Y", dir: new THREE.Vector3(0, 1, 0), color: "#4ade80", solid: true, azimuth: 0, pitch: TOP_PITCH },
      { label: "-Y", dir: new THREE.Vector3(0, -1, 0), color: "#4ade80", solid: false, azimuth: 0, pitch: TOP_PITCH },
      { label: "X", dir: new THREE.Vector3(1, 0, 0), color: "#f87171", solid: true, azimuth: Math.PI / 2, pitch: SIDE_PITCH },
      { label: "-X", dir: new THREE.Vector3(-1, 0, 0), color: "#f87171", solid: false, azimuth: -Math.PI / 2, pitch: SIDE_PITCH },
      { label: "Z", dir: new THREE.Vector3(0, 0, 1), color: "#60a5fa", solid: true, azimuth: 0, pitch: SIDE_PITCH },
      { label: "-Z", dir: new THREE.Vector3(0, 0, -1), color: "#60a5fa", solid: false, azimuth: Math.PI, pitch: SIDE_PITCH },
    ];

    function makeBallTexture(label: string, color: string, solid: boolean): THREE.CanvasTexture {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(32, 32, 27, 0, Math.PI * 2);
      if (solid) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.fillStyle = "#18181b";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.fillStyle = solid ? "#09090b" : color;
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 32, 34);
      return new THREE.CanvasTexture(canvas);
    }

    const ballSprites: { sprite: THREE.Sprite; axis: AxisDef }[] = [];
    for (const axis of axes) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), axis.dir.clone().multiplyScalar(0.8)]);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: axis.color }));
      scene.add(line);

      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeBallTexture(axis.label, axis.color, axis.solid), depthTest: false }));
      sprite.scale.set(0.46, 0.46, 1);
      sprite.position.copy(axis.dir).multiplyScalar(0.95);
      scene.add(sprite);
      ballSprites.push({ sprite, axis });
    }

    const GIZMO_DIST = 2.2;
    let raf = 0;
    function loop() {
      const az = inspectAzimuthRef.current;
      const pitch = inspectPitchRef.current;
      camera.position.set(
        Math.sin(az) * Math.cos(pitch) * GIZMO_DIST,
        Math.sin(pitch) * GIZMO_DIST,
        Math.cos(az) * Math.cos(pitch) * GIZMO_DIST
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }
    loop();

    const raycaster = new THREE.Raycaster();
    function onPointerDown(e: PointerEvent) {
      e.stopPropagation();
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(ballSprites.map((b) => b.sprite));
      if (hits.length === 0) return;
      const hitBall = ballSprites.find((b) => b.sprite === hits[0].object);
      if (!hitBall) return;
      inspectAzimuthRef.current = hitBall.axis.azimuth;
      inspectPitchRef.current = hitBall.axis.pitch;
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // SỬA (phản hồi thật user: "em phải tách cho khối cầu ra 1 camera riêng biệt nữa, khi xoay khối 3D mới
  // không ảnh hưởng tới khối cầu được" — xác nhận qua AskUserQuestion: muốn khối cầu ĐÓNG BĂNG hoàn toàn,
  // dù xoay camera chính góc nào cũng hiện đúng 1 hình dạng cố định) — dựng renderer/scene/camera THỨ BA
  // (độc lập hoàn toàn với renderer chính VÀ với renderer của compass góc phải ở effect trên), chỉ để vẽ
  // 3 vòng tròn xoay — camera ở đây CHỈ đặt vị trí 1 LẦN DUY NHẤT lúc mount rồi đứng yên MÃI MÃI (không
  // đọc inspectAzimuthRef/inspectPitchRef như camera chính hay camera compass), nên hình chiếu luôn giống
  // hệt nhau bất kể camera chính xoay góc nào. Canvas nhỏ này được đặt bằng CSS (left/top, tính bằng cách
  // chiếu toạ độ hông nhân vật đang chọn lên màn hình qua camera CHÍNH) để luôn "dính" đúng vị trí nhân
  // vật, dù bản thân nó render hoàn toàn tách biệt.
  useEffect(() => {
    const mount = gizmoRingMountRef.current;
    const wrap = gizmoRingWrapRef.current;
    if (!mount || !wrap) return;
    // SỬA (phản hồi thật user, gửi ảnh mẫu khối cầu rõ ràng: "khối cầu thay đổi góc nhìn cho dễ nhận biết
    // hơn" — tăng khung hiển thị to hơn hẳn (160 -> 220) để nhìn rõ 3 vòng, không còn lẫn vào các chi tiết
    // khác xung quanh.
    const SIZE = GIZMO_RING_SIZE;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(SIZE, SIZE);
    mount.appendChild(renderer.domElement);
    gizmoRingRendererRef.current = renderer;

    const scene = new THREE.Scene();
    gizmoRingSceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 10);
    // Đặt camera 1 LẦN DUY NHẤT rồi đứng yên mãi mãi — KHÔNG đọc ref nào của camera chính (đây chính là
    // điểm mấu chốt khiến khối cầu đứng yên tuyệt đối dù camera chính xoay góc nào). SỬA (phản hồi thật
    // user: "đặt hình cầu theo trục z" — azimuth = 0 nghĩa là camera nằm ĐÚNG trên trục Z (vị trí
    // (0, y, dist)), nhìn thẳng dọc trục Z vào gốc toạ độ — vòng xanh lá (vuông góc trục Z) nhờ vậy đối
    // diện thẳng camera, hiện ra tròn đều HOÀN HẢO, không méo chút nào. Vẫn giữ pitch để vòng đỏ/xanh
    // dương đủ nghiêng, hiện rõ dạng elip thay vì dẹt thành đường thẳng.
    // SỬA (phản hồi thật user: "đặt thấp xuống thêm 1 ít" — giảm pitch 28° -> 18° để camera hạ thấp độ
    // cao xuống (y ≈ sin(pitch)*GIZMO_DIST), nhìn gần ngang tầm khối cầu hơn. SỬA LẦN 2 (phản hồi thật
    // user: "thêm 1 chút xíu nữa") — giảm tiếp 18° -> 12°.
    // SỬA (phản hồi thật user: "xoay sang trái 1 tý xíu" — thêm góc azimuth nhỏ, lệch khỏi đúng trục Z).
    // SỬA LẦN 3 (phản hồi thật user: "độ cao em cho cao bằng tâm vòng tròn" — từ khi đổi sang 1 vòng tròn
    // 3 cung LUÔN billboard quay mặt thẳng về camera (facing = hướng từ gốc tới camera), pitch không còn
    // cần thiết để tránh vòng bị dẹt/degenerate như thiết kế 3-vòng-360° cũ nữa — vòng luôn tròn đều bất
    // kể pitch. Đặt pitch=0: camera đứng NGANG TÂM vòng tròn (y=0, đúng độ cao gốc toạ độ nơi vòng nằm),
    // không còn nhìn chếch từ trên xuống.
    const az = (-12 * Math.PI) / 180;
    const pitch = 0;
    const GIZMO_DIST = 1.7;
    camera.position.set(Math.sin(az) * Math.cos(pitch) * GIZMO_DIST, Math.sin(pitch) * GIZMO_DIST, Math.cos(az) * Math.cos(pitch) * GIZMO_DIST);
    camera.lookAt(0, 0, 0);
    gizmoRingCameraRef.current = camera;

    const RADIUS = 0.5;
    // SỬA (phản hồi thật user, gửi ảnh mẫu: "1 vòng tròn chia 3 đoạn màu quanh nhân vật") — cả 3 cung
    // dùng CHUNG 1 hướng facing (quay mặt thẳng về camera gizmo — camera đứng yên mãi mãi nên chỉ cần
    // tính 1 lần duy nhất ở đây, không cần cập nhật mỗi khung hình) để luôn ghép liền thành 1 vòng tròn
    // hoàn chỉnh, tròn đều 100% bất kể góc camera gizmo. Chừa khe hở nhỏ (GAP) giữa các cung cho rõ ràng,
    // khớp đúng ảnh mẫu user gửi.
    const facing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), camera.position.clone().normalize());
    const GAP = (6 * Math.PI) / 180;
    const THIRD = (Math.PI * 2) / 3;
    // SỬA (phản hồi thật user: "xoay vòng tròn 1/4 vòng từ phải sang trái, nghĩa là màu xanh dương chạm
    // vào trục Y" — dịch cả 3 cung đi 90° để cyan di chuyển sang vị trí mới) — test thực tế để xác định
    // đúng hướng trước khi chốt giá trị cuối.
    const START = Math.PI / 2 - Math.PI / 2; // bắt đầu từ đỉnh (12 giờ), quét theo chiều kim đồng hồ, khớp ảnh mẫu
    // buildArcRing mặc định visible=false (thiết kế cũ dựa vào showRotateRingsFor bật lại khi chọn nhân
    // vật); giờ việc hiện/ẩn đã chuyển sang điều khiển display của gizmoRingWrapRef (div bọc ngoài canvas
    // mini), nên bản thân 3 cung phải LUÔN visible=true ngay từ lúc tạo.
    // Giữ ĐÚNG mapping ref↔trục đã có từ trước (pitchRingRef=X, rotateRingRef=Y, rollRingRef=Z — xem các
    // chỗ dùng mảng ["x", pitchRingRef]/["y", rotateRingRef]/["z", rollRingRef] bên dưới), chỉ đổi hình
    // dạng (cung thay vì vòng tròn đầy) + màu Y từ xanh dương sang cyan cho khớp ảnh mẫu.
    const pitchRing = buildArcRing(RADIUS, 0xef4444, START + GAP / 2, START + THIRD - GAP / 2, facing); // đỏ — X, "nằm ngửa"
    pitchRing.visible = true;
    scene.add(pitchRing);
    pitchRingRef.current = pitchRing;
    const rotateRing = buildArcRing(RADIUS, 0x22d3ee, START - THIRD + GAP / 2, START - GAP / 2, facing); // cyan — Y, "quay đứng"
    rotateRing.visible = true;
    scene.add(rotateRing);
    rotateRingRef.current = rotateRing;
    const rollRing = buildArcRing(RADIUS, 0x22c55e, START + THIRD + GAP / 2, START + 2 * THIRD - GAP / 2, facing); // xanh lá — Z, "nằm nghiêng"
    rollRing.visible = true;
    scene.add(rollRing);
    rollRingRef.current = rollRing;

    // SỬA (phản hồi thật user: "khi mũi tên và quả cầu sáng lên điều khiển chuột như bị đơ" — khung
    // overlay 220×220 (gizmoRingWrapRef) có pointer-events:auto nên CHẶN HẾT sự kiện chuột trong cả vùng
    // hình vuông đó, kể cả chỗ không có vòng tròn nào (canvas nền trong suốt) — vì tay cầm dịch chuyển vừa
    // quay lại ngang hông (trùng vị trí overlay này), mũi tên bên dưới bị overlay "nuốt" mất click/hover,
    // tưởng như bị đơ. Bỏ hẳn listener trên canvas mini này — overlay giờ pointer-events:none (xem JSX),
    // việc bấm/kéo ring chuyển hẳn sang xử lý từ canvas CHÍNH (xem handlePointerDown/Move chính, vẫn dùng
    // pickGizmoRingAt/beginRingDrag/applyRingDrag y hệt, chỉ đổi nơi gọi).
    const mainMount = mountRef.current;
    const hipWorld = new THREE.Vector3();
    const ndc = new THREE.Vector3();
    let raf = 0;
    function loop() {
      if (!wrap) return;
      const group = attachedGroupRef.current;
      const mainCamera = cameraRef.current;
      // SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả 2" — khối cầu giờ hiện LUÔN khi có
      // nhân vật được chọn, không còn phụ thuộc mode nữa; việc ẩn/hiện qua lại giữa tay cầm dịch chuyển và
      // vòng xoay chuyển hẳn sang syncGizmoVisibility() (dựa theo HOVER), xem hàm đó.
      if (group && mainCamera && mainMount) {
        // SỬA (phản hồi thật user: "gắn tâm khối cầu nằm trên tâm nhân vật để khi xoay khối cầu không dời
        // khỏi nhân vật" — bản trước CỘNG THẲNG hipOffsetY theo true world Y, không tính tới hướng XOAY
        // hiện tại của nhân vật (group.rotation) — khi nhân vật đã xoay (nằm ngửa/nằm nghiêng), điểm hông
        // THẬT trong không gian lệch khỏi công thức cũ, khiến khối cầu trôi khỏi đúng vị trí hông. Xoay
        // offset theo group.rotation trước khi cộng — công thức y hệt pivotWorld ở beginRingDrag/
        // applyRingDrag, đảm bảo khối cầu luôn bám đúng hông dù nhân vật ở tư thế nào.
        // SỬA LẦN 2 (phản hồi thật user: "chuyển vòng tròn xuống dưới chân" — CHỈ đổi vị trí HIỂN THỊ của
        // vòng tròn (overlay theo dõi) xuống ngang chân (y=0, gốc group) thay vì ngang hông — KHÔNG đụng
        // tới điểm TÂM XOAY thật (pivotWorld ở beginRingDrag/applyRingDrag vẫn giữ nguyên ở hông theo đúng
        // yêu cầu trước đó "lấy gốc vector làm tâm"), 2 việc độc lập nhau.
        // SỬA LẦN 3 (phản hồi thật user: "chuyển lên tâm của nhân vật" — đổi lại vị trí HIỂN THỊ lên ngang
        // hipOffsetY (≈52% chiều cao, xem HIP_HEIGHT_FRACTION — đúng tâm thân người), vẫn CHỈ đổi overlay
        // hiển thị, không đụng tới pivotWorld (tâm xoay thật) ở beginRingDrag/applyRingDrag.
        const hipOffsetY = (group.userData.hipOffsetY as number) ?? 0;
        hipWorld.set(0, hipOffsetY, 0).applyEuler(group.rotation).add(group.position);
        ndc.copy(hipWorld).project(mainCamera);
        if (ndc.z < 1) {
          const rect = mainMount.getBoundingClientRect();
          const px = ((ndc.x + 1) / 2) * rect.width;
          const py = ((1 - ndc.y) / 2) * rect.height;
          wrap.style.display = "block";
          wrap.style.left = `${px - SIZE / 2}px`;
          wrap.style.top = `${py - SIZE / 2}px`;
        } else {
          wrap.style.display = "none";
        }
      } else {
        wrap.style.display = "none";
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }
    loop();

    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // Dựng lại mannequin mỗi khi danh sách nhân vật/vị trí đổi — xoá hết group cũ, thêm lại từ đầu (đơn
  // giản hơn diff từng người, số lượng tối đa 5 nên không đáng lo hiệu năng — xem mục 18.4).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Đang kéo gizmo "Di chuyển" (xem transformControls ở trên) — KHÔNG dựng lại mannequin giữa chừng,
    // vì mỗi lần kéo đều gọi onCharacterMove cập nhật locationPositions ở cha, khiến characters đổi
    // reference liên tục; dựng lại sẽ phá huỷ đúng group đang gắn gizmo, làm gizmo "rơi" khỏi người
    // đang kéo. Bỏ qua lần này, effect sẽ tự chạy lại đúng 1 lần sau khi thả chuột (characters đổi).
    // SỬA (phản hồi thật user: "vòng cung không xoay theo nhân vật" — kéo cung đỏ/xanh dương cũng gọi
    // onCharacterRotateX/Z mỗi khung hình y hệt translate, nên CŨNG phải chặn dựng lại mannequin giữa
    // chừng, nếu không showRotateRingsFor trong nhánh "dựng lại" bên dưới sẽ VÔ TÌNH đồng bộ lại hướng
    // cung theo nhân vật mỗi khung, phá mất đúng yêu cầu "đứng yên, không xoay theo").
    if (draggingTransformRef.current || ringDragRef.current.dragging) return;
    let cancelled = false;
    (async () => {
      // SỬA (phản hồi thật user: "3D Builder" mỗi nhân vật có thể dùng 1 model .glb khác nhau, không
      // còn chắc chắn CHUNG 1 template nữa) — tải TRƯỚC mọi model khác nhau đang được dùng tới (thường
      // chỉ 1, như mọi nơi gọi cũ; "3D Builder" có thể có nhiều), Map theo modelUrl -> template.
      const distinctModelUrls = Array.from(new Set(characters.map((ch) => ch.modelUrl ?? "/models/man.glb")));
      const templates = new Map<string, THREE.Group>();
      await Promise.all(
        distinctModelUrls.map(async (modelUrl) => {
          const t = await loadManModel(modelUrl).catch(() => null);
          if (t) templates.set(modelUrl, t);
        })
      );
      if (cancelled) return;
      const sc = sceneRef.current;
      if (!sc) return;
      const old = sc.children.filter((c) => c.userData.isCharacterMannequin);
      old.forEach((c) => sc.remove(c));
      if (templates.size === 0) return; // không model .glb nào tải được — bỏ qua, không chặn khung 3D còn lại

      const SPREAD_X = 5;
      const SPREAD_Z = 5;
      // Scale theo CHIỀU CAO thật của TỪNG model (đo riêng mỗi template, vì các model Mixamo có thể cao
      // thấp khác nhau — Trẻ em thấp hơn Người lớn thật) — TARGET_HEIGHT=1.6 khớp đúng cỡ mannequin cũ
      // (3.8 đơn vị gốc × scale 0.42 ≈ 1.6), không đổi tỉ lệ so với lưới địa hình 5×5 đã quen mắt.
      // SỬA (phản hồi thật user: "phải lấy mặt đất gốc toạ độ y bằng 0") — trước đây TIN gốc model đã
      // nằm đúng ở chân (min.y≈0, dựa theo ghi chú ở LightSphereModal.tsx) nên đặt thẳng position.y=0,
      // KHÔNG tự đo lại — không chắc chắn, rủi ro model/máy nhân bản (SkeletonUtils.clone trên rig) lệch
      // gốc khiến chân lơ lửng hoặc chìm xuống đất. Giờ ĐO LẠI min.y thật của model rồi tính groundOffset
      // bù trực tiếp, đảm bảo chân LUÔN chạm đúng y=0 world, không phụ thuộc giả định về gốc toạ độ gốc.
      const TARGET_HEIGHT = characterHeightUnits;
      const templateMeta = new Map<string, { scale: number; groundOffset: number }>();
      for (const [modelUrl, template] of templates) {
        const box = new THREE.Box3().setFromObject(template);
        const size = new THREE.Vector3();
        box.getSize(size);
        const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
        templateMeta.set(modelUrl, { scale, groundOffset: -box.min.y * scale });
      }

      let justAttachedGroup: THREE.Group | null = null;
      for (const ch of characters) {
        const modelUrl = ch.modelUrl ?? "/models/man.glb";
        const template = templates.get(modelUrl);
        if (!template) continue; // đúng model này lỗi/không tải được — bỏ qua riêng người này, không chặn cả cảnh
        const meta = templateMeta.get(modelUrl)!;
        const group = new THREE.Group();
        group.userData.isCharacterMannequin = true;
        group.userData.characterUrl = ch.url; // dùng để tra lại đúng nhân vật khi bấm chọn
        // SỬA (phản hồi thật user, gửi ảnh mẫu panel thông số nhân vật kiểu TopView: "Transform > Scale")
        // — tỉ lệ co giãn riêng của NGƯỜI DÙNG đặt (xem PositionedCharacter.scaleX/Y/Z), áp lên group CHA
        // — độc lập hoàn toàn với meta.scale (chuẩn hoá chiều cao GIỮA các model .glb khác nhau, áp lên
        // `model` con bên dưới) nên 2 lớp scale không chồng chéo ý nghĩa, mặc định (1,1,1) = không đổi gì
        // so với hành vi cũ.
        const scaleX = ch.scaleX ?? 1;
        const scaleY = ch.scaleY ?? 1;
        const scaleZ = ch.scaleZ ?? 1;
        group.scale.set(scaleX, scaleY, scaleZ);
        // SỬA (phản hồi thật user: "cho vector di chuyển này lên ngang hông của người") — lưu lại offset
        // chiều cao thật (world unit, không phải tỉ lệ) để handlePointerDown/effect này đặt gizmoHandle
        // đúng ngang hông, xem khai báo HIP_HEIGHT_FRACTION.
        // SỬA LẦN 2 (cùng lý do scale ở trên) — nhân thêm scaleY: nhân vật co giãn theo chiều cao thì
        // điểm hông/tay cầm phải theo đúng tỉ lệ mới, không còn "lệch ngang hông" khi đã scale.
        group.userData.hipOffsetY = TARGET_HEIGHT * HIP_HEIGHT_FRACTION * scaleY;
        // SỬA (tay cầm dịch chuyển tách khỏi khối cầu, xem HANDLE_HEIGHT_FRACTION) — lưu thêm offset
        // riêng cho tay cầm, thấp hơn hẳn hông, chỉ vừa đủ cao hơn mặt sàn để tránh z-fighting.
        group.userData.handleOffsetY = TARGET_HEIGHT * HANDLE_HEIGHT_FRACTION * scaleY;
        const model = cloneSkeleton(template) as THREE.Group;
        model.scale.setScalar(meta.scale);
        // SỬA (cùng lý do scale ở trên) — groundOffset tính sẵn cho scale gốc (group.scale=1); group CHA
        // giờ có thể co giãn theo scaleY, Three.js tự nhân local position của `model` (con) với scale của
        // group (cha) khi render — chia ngược trước cho scaleY để sau khi nhân lại đúng y hệt groundOffset
        // gốc trong world space, chân luôn chạm sàn dù co giãn cỡ nào.
        model.position.y = scaleY !== 0 ? meta.groundOffset / scaleY : meta.groundOffset;
        group.add(model);

        // SỬA (phản hồi thật user: "bỏ hình tròn chứ đâu phải bỏ vòng tròn" — chấm tròn màu dưới chân
        // từng nhân vật gây nhầm lẫn với tay cầm xoay tự vẽ, xem buildRotateRingHandle) — bỏ hẳn, không
        // còn chấm tròn màu nào dưới chân nhân vật nữa.
        // SỬA (phản hồi thật user, panel thông số nhân vật: "làm luôn Material" — thêm màu tint (nhân màu
        // đè lên TOÀN BỘ vật liệu model, giữ nguyên hoạ tiết/texture gốc, chỉ ngả màu theo tintColor chọn,
        // giống kiểu "đổi màu đội" trong game chứ không phải đổi hẳn chất liệu/texture thật — hệ thống
        // chưa có kho texture/PBR để làm material editor đầy đủ) — mặc định #ffffff (không đổi gì, giữ
        // nguyên màu da/trang phục gốc từ file .glb, KHỚP hành vi cũ). SkeletonUtils.clone chỉ nhân bản
        // hình học/khung xương, VẬT LIỆU (material) vẫn CHUNG THAM CHIẾU với template gốc + mọi bản sao
        // khác dùng chung model — phải tự CLONE riêng material cho bản sao này trước khi đổi màu, nếu
        // không sẽ tô màu luôn mọi nhân vật khác đang dùng chung model (vd 2 "Nam" cùng lúc).
        if (ch.tintColor && ch.tintColor.toLowerCase() !== "#ffffff") {
          const tint = new THREE.Color(ch.tintColor);
          model.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh) return;
            const applyTint = (mat: THREE.Material) => {
              const cloned = mat.clone();
              const colored = cloned as THREE.Material & { color?: THREE.Color };
              if (colored.color) colored.color.multiply(tint);
              return cloned;
            };
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(applyTint) : applyTint(mesh.material);
          });
        }

        // SỬA (phản hồi thật user: chấm 2D bay lên trời khi kéo nhân vật ra xa, rồi "chưa sát mặt đất")
        // — worldZ không còn tính tuyến tính theo ch.y nữa, dùng y2DToDepthResolved (ưu tiên bảng hiệu
        // chuẩn thật từ depth map + ground mask, rơi về công thức horizonY khi thiếu dữ liệu).
        const worldX = (ch.x - 0.5) * SPREAD_X;
        const worldZ = -y2DToDepthResolved(ch.y, groundCalib, horizonY, SPREAD_Z);
        // SỬA (phản hồi thật user: "không có chiều lên xuống à") — group.position.y giờ đọc từ
        // ch.elevationY (đã lưu lại qua onCharacterElevate), mặc định 0 (đứng ngay trên sàn) nếu chưa
        // từng kéo trục Y.
        group.position.set(worldX, ch.elevationY ?? 0, worldZ);
        // SỬA (phản hồi thật user: xoay nhân vật qua gizmo xong bị mất góc xoay mỗi khi dựng lại
        // mannequin) — áp lại góc xoay đã lưu (nếu có), giữ nguyên hướng đứng giữa các lần dựng lại. SỬA
        // (phản hồi thật user, gửi ảnh mẫu "Edit Pose": thêm trục X "nằm ngửa" + Z "nằm nghiêng") — áp
        // lại cả 3 trục, không chỉ Y.
        group.rotation.set(ch.rotationX ?? 0, ch.rotationY ?? 0, ch.rotationZ ?? 0);
        sc.add(group);
        if (ch.url === attachedCharacterUrlRef.current) {
          justAttachedGroup = group;
          reportTransform(group, ch.url);
        }

        // SỬA (phản hồi thật user, gửi ảnh mẫu panel thông số nhân vật: toggle "Show label") — nhãn tên
        // nổi phía trên đầu, LUÔN đứng thẳng quay mặt camera (Sprite tự làm điều này) — đặt THẲNG vào
        // scene (không phải con của group) và tính world position TRỰC TIẾP từ group.position (không xoay
        // theo group.rotation) để nhãn luôn lơ lửng phía trên nhân vật trong world-space thật, không bị
        // "chạy" sang bên cạnh khi nhân vật nằm ngửa/nghiêng — khác với offset hông/tay cầm (cố tình xoay
        // theo thân người, xem ghi chú ở attachTranslateHandle). Mặc định hiện (showLabel !== false).
        if (ch.showLabel !== false) {
          const labelCanvas = document.createElement("canvas");
          labelCanvas.width = 256;
          labelCanvas.height = 64;
          const lctx = labelCanvas.getContext("2d")!;
          lctx.fillStyle = "rgba(24, 24, 27, 0.75)";
          lctx.beginPath();
          lctx.roundRect(4, 12, 248, 40, 12);
          lctx.fill();
          lctx.fillStyle = "#ffffff";
          lctx.font = "bold 26px sans-serif";
          lctx.textAlign = "center";
          lctx.textBaseline = "middle";
          lctx.fillText(ch.name, 128, 33, 232);
          const labelTexture = new THREE.CanvasTexture(labelCanvas);
          const labelSprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: labelTexture, depthTest: false, transparent: true })
          );
          labelSprite.position.set(worldX, (ch.elevationY ?? 0) + TARGET_HEIGHT * scaleY + 0.18, worldZ);
          labelSprite.scale.set(0.9, 0.225, 1);
          labelSprite.renderOrder = 999;
          labelSprite.userData.isCharacterMannequin = true; // dọn cùng lúc với mannequin ở lần dựng lại kế tiếp
          sc.add(labelSprite);
        }
      }

      // SỬA LẠI (phản hồi thật user: "mũi tên hiện ra rồi biến mất, không di chuyển được") — bản DEBUG
      // trước đây gỡ gizmo HOÀN TOÀN mỗi khi effect này chạy, mà `characters` là mảng MỚI (object mới)
      // mỗi lần component cha re-render (do `.map()` tạo lại), nên effect này chạy lại rất thường xuyên,
      // kể cả ngay sau khi khách vừa bấm CHỌN nhân vật (trước khi kịp kéo) — gỡ luôn gizmo vừa gắn, trông
      // như "hiện ra rồi biến mất". Đã xác nhận KHÔNG phải nguyên nhân gây lỗi "vị trí 2D bị ghi đè" ở
      // thời điểm debug trước, nên giờ khôi phục đúng hành vi mong muốn: nếu đang có nhân vật được chọn
      // (attachedCharacterUrlRef) và nhân vật đó vẫn còn trong danh sách, GẮN LẠI gizmo vào group MỚI
      // vừa dựng (group cũ đã bị xoá nên object cũ trong transformControls.object không còn hợp lệ) —
      // chỉ detach khi nhân vật đó không còn (bị xoá khỏi scene).
      if (justAttachedGroup) {
        // SỬA (phản hồi thật user: "mũi tên này hiện ngay cùng nhân vật...không cần qua nút xoay nữa" —
        // group CŨ (đang gắn tay cầm) đã bị xoá, group MỚI vừa dựng lại cần gắn lại CẢ 2 tay cầm (dịch
        // chuyển + xoay) vào group mới, luôn hiện cùng lúc.
        attachedGroupRef.current = justAttachedGroup;
        attachGizmos(justAttachedGroup);
        showRotateRingsFor();
      } else {
        attachedGroupRef.current = null;
        const tc = transformControlsRef.current;
        tc?.detach();
        if (tc) tc.getHelper().visible = false;
        hideRotateRings();
        attachedCharacterUrlRef.current = null;
        onCharacterSelect?.(null);
      }

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [characters, horizonY, groundCalib, characterHeightUnits]);

  // SỬA (phản hồi thật user: muốn kiểm chứng điểm 2D nào ứng điểm nào trong 3D, không cần gắn nhân vật
  // thật) — chấm đỏ đánh số, dùng ĐÚNG công thức world-mapping như mannequin thật ở trên (SPREAD_X/Z=5,
  // cùng 1 hệ toạ độ) để chấm luôn khớp đúng, không lệch so với nhân vật thật nếu có.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.children.filter((c) => c.userData.isTestMarker).forEach((c) => scene.remove(c));

    const SPREAD_X = 5;
    const SPREAD_Z = 5;
    testPoints.forEach((p, i) => {
      const worldX = (p.x - 0.5) * SPREAD_X;
      const worldZ = -y2DToDepthResolved(p.y, groundCalib, horizonY, SPREAD_Z);

      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
      dot.position.set(worldX, 0.12, worldZ);
      dot.userData.isTestMarker = true;
      scene.add(dot);

      // Nhãn số — vẽ lên canvas 2D rồi dùng làm texture cho Sprite (luôn quay mặt về camera, đọc được
      // dù xoay góc nhìn nào), đặt lơ lửng phía trên chấm đỏ.
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(32, 32, 28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), 32, 34);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
      sprite.position.set(worldX, 0.55, worldZ);
      sprite.scale.set(0.4, 0.4, 1);
      sprite.renderOrder = 999;
      sprite.userData.isTestMarker = true;
      scene.add(sprite);
    });
    forceRerender((n) => n + 1);
  }, [testPoints, horizonY, groundCalib]);

  // Dựng sàn phẳng (worldY luôn = 0) từ bảng hiệu chuẩn thật (groundCalib) khi có, hoặc công thức
  // horizonY đơn giản khi chưa có — ĐÚNG 1 nguồn duy nhất, cùng hàm y2DToDepthResolved mà vị trí nhân vật
  // đang dùng (xem SỬA ở buildFlatGroundGeometry phía trên). Trước đây effect này chỉ chạy 1 lần lúc mount
  // (deps []), dùng công thức tuyến tính cứng — giờ phải chạy lại mỗi khi groundCalib/horizonY đổi (ảnh
  // vừa dựng khối 3D xong, hoặc đổi sang ảnh khác) để sàn luôn khớp đúng vị trí nhân vật.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.children.filter((c) => c.userData.isLocationBlock).forEach((c) => scene.remove(c));
    const flatGeo = buildFlatGroundGeometry(24, 20, groundCalib, horizonY, 5);
    const flatSolid = new THREE.Mesh(
      flatGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide })
    );
    flatSolid.userData.isLocationBlock = true;
    scene.add(flatSolid);
    // SỬA (phản hồi thật user, 4 lượt liên tiếp: "kẻ lưới lên thảm 3D" -> "cho không gian lưới to ra" ->
    // "kẻ lưới ô vuông bỏ lưới chéo đi" -> "để nhân vật hiển thị đúng tâm thì phải cho 2 lưới ngang dọc
    // tại tâm, từ đó mới phát triển lưới ra") — buildGridLines() giờ dựng thẳng trong world space, xuất
    // phát từ ĐÚNG tâm thảm centerZ=-2.5 (khớp world Z nơi nhân vật mặc định đứng — xem addCharacter() ở
    // ThreeDBuilderClient.tsx, x=0.5,y=0.75) rồi lan đều ra 2 bên theo step=0.625, đảm bảo luôn có 1
    // đường dọc tại X=0 và 1 đường ngang tại Z=-2.5 cắt nhau đúng tâm. Nâng lên y=0.006 (dưới lớp phủ ảnh
    // đất groundTexture ở y=0.01) để không z-fighting với flatSolid.
    const gridLines = buildGridLines(2.5, -2.5, 5, 0.625);
    gridLines.position.y = 0.006;
    gridLines.userData.isLocationBlock = true;
    scene.add(gridLines);
    const flatOutline = buildEdgeOutline(flatGeo.getAttribute("position").array as Float32Array, 24, 20);
    flatOutline.userData.isLocationBlock = true;
    scene.add(flatOutline);
    forceRerender((n) => n + 1);
  }, [groundCalib, horizonY]);

  // Phủ ảnh đất thật (groundMaskUrl, đã được SAM-3 cắt theo đúng vùng đất) lên trên mặt sàn xám -- yêu cầu
  // thật user ban đầu: "trải lên trên thảm 3D". SỬA (phản hồi thật user mới nhất: "cho khối lưới 3D thành
  // màu xám không có hiệu ứng làm lóa mắt") -- sau khi sửa 1 lỗi hiển thị (bóng cây mờ lem nhem) thì PHÁT
  // SINH lỗi khác trên 1 ảnh khác (mảng tam giác trắng chói mắt rải rác, do mask SAM-3 của ảnh đó có nhiều
  // vùng "đất" nhỏ lẻ/nhiễu rải rác thay vì 1 khối liền) -- quyết định TẮT HẲN tính năng phủ texture này
  // (quay lại đúng sàn xám đơn giản + lớp sương, vốn ổn định không lỗi), vì độ ổn định quan trọng hơn hiệu
  // ứng trực quan phụ này. Giữ nguyên code bên dưới (không xoá) để bật lại dễ dàng nếu cần.
  // SỬA (phản hồi thật user: "em phải giữ sam lại, đằng này em đã xóa nó đi") -- bật lại, giữ texture.
  const ENABLE_GROUND_TEXTURE_OVERLAY = true;
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.children.filter((c) => c.userData.isGroundTexture).forEach((c) => scene.remove(c));
    if (!groundMaskUrl || !ENABLE_GROUND_TEXTURE_OVERLAY) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(groundMaskUrl, (texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      // SỬA (phản hồi thật user: "ảnh SAM nhòe") — sàn nhìn CHÉO XUỐNG (góc nhìn gần như song song mặt
      // sàn), đúng trường hợp dễ bị nhoè nhất với texture 3D (mipmap lọc đều mọi hướng dù 1 trục trong
      // ảnh bị nén mạnh hơn trục kia theo góc nhìn) — bật anisotropic filtering (lọc có hướng) theo đúng
      // mức tối đa GPU hỗ trợ để giữ nét khi nhìn chéo, thay vì mặc định blur đều.
      texture.anisotropy = rendererRef.current?.capabilities.getMaxAnisotropy() ?? 1;
      // SỬA (phản hồi thật user: "cho nét hơn được không") — tắt hẳn mipmap (texture.generateMipmaps),
      // bắt GPU luôn lấy mẫu ở ĐÚNG độ phân giải gốc của ảnh SAM-3 thay vì tự chọn mipmap level thấp hơn
      // (vốn luôn mờ hơn gốc, dù có anisotropy). Chấp nhận đánh đổi: có thể hơi lấm tấm (aliasing/shimmer)
      // khi nhìn từ rất xa -- nhưng đây là khung xem trước tĩnh, không phải cảnh động, nét > mượt.
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      const mesh = new THREE.Mesh(
        // nearColor = trắng (1,1,1) -- nhân với texture không đổi màu ảnh thật gần camera, chỉ pha dần
        // sang màu sương (MIST_COLOR) về phía xa, xem buildFlatGroundGeometry phía trên.
        buildFlatGroundGeometry(24, 20, groundCalib, horizonY, 5, new THREE.Color(0xffffff)),
        // SỬA (phản hồi thật user: mảng tam giác trắng chói mắt rải rác quanh viền vùng texture) — đã đo
        // thật dữ liệu mask (script inspect_mask_alpha.js): alpha SẠCH, chỉ 0 hoặc ~1, không có viền mờ,
        // RGB dưới vùng alpha=0 cũng sạch (0,0,0), không phải dữ liệu rác -- loại trừ nguyên nhân do ảnh
        // mask lỗi. Thực nghiệm xác nhận: TẮT hẳn mesh texture (giữ nguyên sàn xám cùng hình học warp) thì
        // HẾT HẲN tam giác trắng -- vậy lỗi nằm ở cách ÁNH SÁNG tương tác với MeshStandardMaterial trên
        // hình học warp phi tuyến mới (tam giác ở vùng dốc có pháp tuyến nghiêng gắt, bắt sáng trực tiếp
        // từ đèn hướng -> bị cháy sáng trắng cục bộ). Đổi sang MeshBasicMaterial (không tính ánh sáng, vẽ
        // đúng màu texture + vertexColors nhân vào, không phụ thuộc góc pháp tuyến/đèn) -- loại bỏ hẳn khả
        // năng cháy sáng vì ánh sáng, vốn dĩ cũng hợp lý hơn cho 1 lớp phủ ảnh tham chiếu phẳng.
        new THREE.MeshBasicMaterial({
          map: texture,
          vertexColors: true,
          alphaTest: 0.5,
          side: THREE.DoubleSide,
        })
      );
      mesh.position.y = 0.01;
      mesh.userData.isGroundTexture = true;
      scene.add(mesh);
      forceRerender((n) => n + 1);
    });
    return () => {
      cancelled = true;
      scene.children.filter((c) => c.userData.isGroundTexture).forEach((c) => scene.remove(c));
    };
  }, [groundMaskUrl, groundCalib, horizonY]);

  // Tìm đúng mannequin bị bấm trúng (nếu có) bằng raycasting — bấm trúng khoảng trống/địa hình thì
  // KHÔNG làm gì cả (địa hình luôn đứng yên, đúng yêu cầu).
  function pickMannequinAt(clientX: number, clientY: number): THREE.Group | null {
    const mount = mountRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!mount || !camera || !scene) return null;
    const rect = mount.getBoundingClientRect();
    const mouse = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycasterRef.current.setFromCamera(mouse, camera);
    const mannequins = scene.children.filter((c): c is THREE.Group => c.userData.isCharacterMannequin);
    // SỬA (lỗi thật phát hiện lúc test: bấm đúng giữa người vẫn không chọn được — intersectObjects đi
    // thẳng vào SkinnedMesh con bên trong trả về 0 trúng MỌI nơi) — SkinnedMesh.raycast của three.js
    // raycast theo hình dạng GỐC (bind pose) nhân với object.matrixWorld, KHÔNG áp dụng biến dạng
    // skinning thật (bone matrices) vào vị trí đỉnh, nên với rig có chuỗi scale Armature/Scene lồng
    // nhau (model .glb này) toạ độ kiểm tra bị thu nhỏ sai lệch hoàn toàn so với hình thật hiển thị —
    // không bao giờ trúng. Đổi sang kiểm tra ray cắt hộp bao (Box3.setFromObject, tính đúng theo hình
    // hiển thị thật) thay vì raycast trực tiếp vào mesh.
    let closest: THREE.Group | null = null;
    let closestDist = Infinity;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const group of mannequins) {
      box.setFromObject(group);
      if (raycasterRef.current.ray.intersectBox(box, point)) {
        const dist = raycasterRef.current.ray.origin.distanceTo(point);
        if (dist < closestDist) {
          closestDist = dist;
          closest = group;
        }
      }
    }
    return closest;
  }

  // Raycast riêng cho 3 vòng cung xoay tự vẽ (xem buildAxisRotateHandle) — tách khỏi pickMannequinAt vì
  // đây là object hoàn toàn khác (không phải nhân vật). Trả về trục bị bấm trúng (hoặc null nếu không
  // trúng ring nào) — SỬA (phản hồi thật user, gửi ảnh mẫu "Edit Pose": thêm 2 trục X/Z) — giờ phải
  // phân biệt bấm trúng ĐÚNG ring nào trong 3 ring, không còn là boolean đơn giản như trước.
  // SỬA (phản hồi thật user: "tách cho khối cầu ra 1 camera riêng biệt") — raycast giờ chạy trong mini-
  // scene RIÊNG (gizmoRingSceneRef/gizmoRingCameraRef), toạ độ chuột quy đổi theo rect của khung canvas
  // NHỎ (gizmoRingMountRef), không phải khung 3D lớn nữa.
  // SỬA (phản hồi thật user, test trên điện thoại thật: "lưới hình cầu rất khó bám chuột, băt chuôt khó
  // và không chính xác") — thay vì raycast thẳng vào mesh ống (rất mảnh, dễ trượt) rồi trả về trục ĐẦU
  // TIÊN trúng theo thứ tự mảng x→y→z (sai trục khi 2 vòng ở gần nhau), hàm này tính khoảng cách từ tia
  // chuột tới đường tròn thật của từng trục (không phụ thuộc độ dày ống vẽ), rồi chọn trục GẦN NHẤT —
  // luôn đúng trục user định bấm, không còn lệ thuộc thứ tự kiểm tra.
  // SỬA (phản hồi thật user: "di chuột có khi đè lên vòng mà không bắt, di ra ngoài lại bắt" — cách tính
  // CŨ dùng giao tia 3D với mặt phẳng chứa vòng tròn rồi so bán kính; với vòng nhìn gần NGHIÊNG CẠNH
  // (vòng đỏ, mặt phẳng gần song song hướng nhìn — xem ảnh user chụp: vòng đỏ dẹt lại thành elip hẹp),
  // phép chia cho localDir.y gần 0 khiến kết quả cực kỳ NHẠY — chuột xê dịch vài pixel làm khoảng cách
  // tính ra nhảy vọt, sai lệch hẳn so với vị trí mắt nhìn thấy trên màn hình. Đổi hẳn sang so khoảng cách
  // TRÊN MÀN HÌNH (pixel): lấy mẫu nhiều điểm quanh đường tròn, chiếu từng điểm qua camera ra toạ độ màn
  // hình y hệt cách render, rồi so trực tiếp với vị trí chuột — luôn ổn định bất kể góc nhìn vòng tròn
  // thế nào, vì không còn phép chia số nhỏ nào cả, và đúng với cái mắt người dùng nhìn thấy.
  const RING_HIT_SAMPLES = 48;
  // SỬA (phản hồi thật user: "có khi di đè lên mà không bắt, có khi di qua mới bắt" — ngưỡng cũ 18px tuy
  // đã tính đúng theo khoảng cách màn hình, nhưng vẫn là 1 NGƯỠNG CỐ ĐỊNH DUY NHẤT: chuột đứng sát rìa
  // ngưỡng (ví dụ cách 17-19px) có thể liên tục bật/tắt trạng thái hover qua lại giữa các khung hình do
  // sai số làm tròn pixel nhỏ — cảm giác giống "đè lên không bắt". Thêm độ trễ (hysteresis) kiểu 2 ngưỡng:
  // ngưỡng ĐỂ BẮT ĐẦU bắt trúng nhỏ hơn (RING_HIT_ENTER), ngưỡng để DUY TRÌ hover khi đã trúng rồi thì
  // rộng hơn hẳn (RING_HIT_STAY) — một khi đã tô vàng 1 vòng, chuột phải đi ra khá xa mới nhả, không còn
  // nhấp nháy ở biên nữa.
  // SỬA LẦN 2 (phản hồi thật user: "ra ngoài mới vàng, không cố định" — hướng lệch NGẪU NHIÊN theo chiều
  // chuột đang di, không lệch cố định 1 phía) — đúng kiểu rê chuột NHANH: trình duyệt không gửi MỌI pixel
  // chuột đi qua, chỉ gửi vài điểm rời rạc mỗi khung hình (~16ms/lần), nên có lúc toạ độ mẫu "nhảy" qua
  // khỏi dải mỏng của vòng tròn, không có điểm mẫu nào rơi đúng vào đó — hướng lệch vì vậy ngẫu nhiên theo
  // hướng rê. Nới rộng thêm ngưỡng VÀ xử lý luôn các điểm trung gian trình duyệt gộp lại
  // (getCoalescedEvents, xem handlePointerMove) để không bỏ sót khi rê nhanh.
  // SỬA LẦN 3 (lỗi thật phát hiện lúc test sau khi đổi sang 1 vòng tròn 3 cung màu: vùng bắt lan tới gần
  // SÁT TÂM, trông như hình quạt, không còn là dải mỏng quanh viền) — nguyên nhân: ngưỡng 28/40px ở trên
  // được chỉnh cho thiết kế CŨ (nhìn có vẻ to hơn), còn bán kính MÀN HÌNH thật của vòng mới chỉ khoảng
  // 55px — TÍNH RA từ đúng thông số camera gizmo (không đoán): bán kính hiển thị (px) = (SIZE/2) /
  // (GIZMO_DIST·tan(fov/2)) × RADIUS = (160/2) / (1.7·tan(23°)) × 0.5 ≈ 80/0.7216 × 0.5 ≈ 55.4px — ngưỡng
  // 40px xấp xỉ 72% bán kính đó nên vùng bắt gần như phủ kín tới tâm. Đổi lại còn ~20-33% bán kính, vẫn đủ
  // rộng để dễ bắt nhưng không lấn sâu vào trong.
  // SỬA LẦN 4 (phản hồi thật user: "nhìn thấy rõ nhưng bấm/rê đúng vị trí vẫn không bắt" ở vòng cyan — test
  // lại bằng toạ độ CHÍNH XÁC TUYỆT ĐỐI xác nhận thuật toán đúng, nghi do tay bấm thật lệch vài pixel so
  // với đường cong hơn mắt nhìn) — nới nhẹ lại ngưỡng (12/18 → 16/24px, ~29%/44% bán kính 55px, vẫn chừa
  // khoảng trống rõ rệt với tâm, không tái phát lỗi hình quạt ở LẦN 3).
  // SỬA LẦN 5 (phản hồi thật user: "làm nét to bằng nhân vật" — tubeRadius tăng 0.12→0.3×radius, nửa độ
  // dày hiển thị giờ ≈16.6px — TÍNH RA, không đoán — nới ngưỡng theo đúng độ dày mới để vùng bắt luôn phủ
  // kín phần nhìn thấy được của nét vẽ, không còn chỗ nào "nhìn thấy nét mà không bắt được".
  // SỬA LẦN 6 (phản hồi thật user: "rút ngắn khoảng cách bắt chuột xuống" — sau khi tay cầm di chuyển +
  // vòng xoay dùng chung 1 độ cao (ngang hông) và nét vòng đã mỏng lại nhiều (0.3 → 0.0175×radius), ngưỡng
  // 20/28px cũ rộng hơn hẳn nhu cầu thật, dễ lấn vào vùng của tay cầm di chuyển ngay bên cạnh — giảm về
  // 12/18px (gần mức LẦN 4 trước khi nới cho nét dày), vẫn đủ rộng để dễ bắt nhưng sát viền nét vẽ hơn hẳn.
  const RING_HIT_ENTER_PX = 12;
  const RING_HIT_STAY_PX = 18;
  function distanceScreenToRingCurve(
    ring: THREE.Group,
    camera: THREE.PerspectiveCamera,
    rect: DOMRect,
    clientX: number,
    clientY: number
  ): number | null {
    const radius = ring.userData.radius as number;
    // SỬA (phản hồi thật user, đổi sang 3 CUNG 120° thay vì 3 vòng tròn đầy 360°) — chỉ lấy mẫu trong
    // ĐÚNG khoảng góc của cung này (startAngle..endAngle, lưu ở buildArcRing), không quét hết 360° nữa —
    // nếu không sẽ tính nhầm khoảng cách tới phần vòng tròn KHÔNG CÓ hình vẽ thật (thuộc cung màu khác).
    const startAngle = ring.userData.startAngle as number;
    const endAngle = ring.userData.endAngle as number;
    const local = new THREE.Vector3();
    const world = new THREE.Vector3();
    let minDist: number | null = null;
    for (let i = 0; i < RING_HIT_SAMPLES; i++) {
      const t = startAngle + ((endAngle - startAngle) * i) / (RING_HIT_SAMPLES - 1);
      local.set(Math.cos(t) * radius, 0, Math.sin(t) * radius);
      world.copy(local).applyMatrix4(ring.matrixWorld).project(camera);
      if (world.z < -1 || world.z > 1) continue; // điểm nằm ngoài sau/trước camera — bỏ qua
      const px = ((world.x + 1) / 2) * rect.width + rect.left;
      const py = ((1 - world.y) / 2) * rect.height + rect.top;
      const d = Math.hypot(px - clientX, py - clientY);
      if (minDist === null || d < minDist) minDist = d;
    }
    return minDist;
  }
  function pickGizmoRingAt(clientX: number, clientY: number): "x" | "y" | "z" | null {
    const mount = gizmoRingMountRef.current;
    const camera = gizmoRingCameraRef.current;
    if (!mount || !camera) return null;
    const rect = mount.getBoundingClientRect();
    // SỬA (lỗi thật phát hiện lúc test: bấm vào NHÂN VẬT không chọn được nữa, mọi cú bấm đều rơi vào
    // nhánh ring) — khi khối cầu đang ẩn (gizmoRingWrapRef display:none, trước khi chọn nhân vật lần nào),
    // getBoundingClientRect() của canvas mini (con của div ẩn) trả về TOÀN SỐ 0 — chặn sớm khi rect rỗng
    // (khối cầu đang ẩn) — chắc chắn không trúng ring nào.
    if (rect.width === 0 || rect.height === 0) return null;
    const rings: ["x" | "y" | "z", THREE.Group | null][] = [
      ["x", pitchRingRef.current],
      ["y", rotateRingRef.current],
      ["z", rollRingRef.current],
    ];
    const currentAxis = hoveredRingAxisRef.current;
    // SỬA LẦN 5 (phản hồi thật user: "2 vấn đề: 1 di chuột vào gần nhân vật mới sáng, 2 di chuột trên
    // đoạn màu xanh lá nhưng gần đường xanh dương thì xanh dương lại sáng, di thêm 1 tý nữa xanh lá mới
    // sáng" — bản trước áp 2 NGƯỠNG LOẠI TRỪ riêng biệt: trục ĐANG hover dùng ngưỡng rộng 24px để coi là
    // "còn trúng", trục KHÁC phải lọt vào đúng 16px mới được TÍNH (nếu không lọt thì bị loại thẳng ngay
    // từ vòng xét, dù có thể đang GẦN HƠN trục cũ) — đúng vùng ranh giới 2 cung màu kề nhau (vd xanh
    // lá/xanh dương), nếu trục MỚI cách 17-23px (ngoài 16 nhưng trong 24) thì bị loại hẳn, còn trục ĐANG
    // hover vẫn thắng mặc định dù xa hơn thật — tạo "vùng chết" lệch hẳn về phía trục cũ, đúng y hệt hiện
    // tượng user mô tả. Đổi sang 1 NGƯỠNG LOẠI TRỪ DUY NHẤT dùng chung cho mọi trục (RING_HIT_STAY_PX,
    // rộng — không trục nào bị loại oan), rồi mới cộng thêm chút ưu tiên (hysteresis bonus, chỉ ảnh hưởng
    // lúc SO SÁNH ai gần hơn, không ảnh hưởng việc có được TÍNH hay không) cho trục đang hover — trục khác
    // gần hơn rõ rệt vẫn luôn thắng đúng như vị trí chuột thật.
    const HYSTERESIS_BONUS_PX = RING_HIT_STAY_PX - RING_HIT_ENTER_PX;
    let best: "x" | "y" | "z" | null = null;
    let bestEffectiveDist = Infinity;
    for (const [axis, ring] of rings) {
      if (!ring) continue;
      const dist = distanceScreenToRingCurve(ring, camera, rect, clientX, clientY);
      if (dist === null || dist >= RING_HIT_STAY_PX) continue; // ngưỡng loại trừ DUY NHẤT, chung cho mọi trục
      const effectiveDist = axis === currentAxis ? dist - HYSTERESIS_BONUS_PX : dist;
      if (effectiveDist < bestEffectiveDist) {
        bestEffectiveDist = effectiveDist;
        best = axis;
      }
    }
    return best;
  }
  // SỬA (phản hồi thật user: "khi chuột vào đường tròn nào thì đường tròn đó chuyển sang màu vàng để nhận
  // biết" — đổi màu vật liệu (MeshBasicMaterial) theo cung đang hover. axis=null nghĩa là KHÔNG hover
  // cung nào — trả tất cả về màu gốc.
  // SỬA LẦN 2 (phản hồi thật user, gửi ảnh mẫu 1 vòng tròn chia 3 cung màu) — bản cũ ẨN 2 vòng KHÔNG
  // hover để đỡ rối vì 3 vòng tròn ĐẦY ĐỦ 360° CHỒNG LẤN lên nhau (gây khó phân biệt/khó bắt). Giờ 3
  // CUNG liền kề nhau tạo thành 1 vòng tròn duy nhất, không còn chồng lấn — ẩn 2 cung còn lại sẽ làm vòng
  // tròn bị khuyết trông vỡ, nên bỏ hẳn phần ẩn/hiện, chỉ còn đổi màu cung đang hover sang vàng.
  const RING_COLORS: Record<"x" | "y" | "z", number> = { x: 0xef4444, y: 0x22d3ee, z: 0x22c55e };
  const RING_HOVER_COLOR = 0xffd400;
  function updateRingHover(axis: "x" | "y" | "z" | null) {
    if (hoveredRingAxisRef.current === axis) return;
    hoveredRingAxisRef.current = axis;
    const rings: ["x" | "y" | "z", THREE.Group | null][] = [
      ["x", pitchRingRef.current],
      ["y", rotateRingRef.current],
      ["z", rollRingRef.current],
    ];
    for (const [a, ring] of rings) {
      if (!ring) continue;
      const mesh = ring.children[0] as THREE.Mesh | undefined;
      const mat = mesh?.material as THREE.MeshBasicMaterial | undefined;
      mat?.color.setHex(a === axis ? RING_HOVER_COLOR : RING_COLORS[a]);
    }
  }

  // SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả tay cầm dịch chuyển lẫn vòng xoay cùng
  // lúc khi chọn nhân vật, hover bên nào thì ẩn bớt bên kia cho đỡ rối" — gọi mỗi khung hình (trong loop()
  // của renderer CHÍNH, nơi TransformControls thật sự render) để đồng bộ hiện/ẩn 2 bộ tay cầm.
  // SỬA LẦN 2 (phản hồi thật user: "hiện tại chỉ cần chỉ chuột vào là ẩn luôn, muốn phải NHẤN GIỮ chuột
  // (đang kéo thật) thì mới ẩn, chỉ rê chuột qua chưa bấm thì vẫn hiện đủ cả 2 bộ") — đổi điều kiện từ
  // "đang HOVER" sang "đang KÉO THẬT": ringAxis giờ chỉ khác null khi ringDragRef.current.dragging === true
  // (đặt bởi beginRingDrag lúc pointerdown trúng ring, xem handlePointerDown/handlePointerMove), tcAxis chỉ
  // khác null khi tc.dragging === true (cờ nội bộ TransformControls tự bật khi đang kéo thật, đứng yên lúc
  // chỉ hover qua) — màu vàng tô hover (updateRingHover, xem handlePointerMove) vẫn giữ nguyên chạy ngay
  // lúc hover như cũ, chỉ có phần ẨN/HIỆN này đổi sang yêu cầu kéo thật.
  function syncGizmoVisibility() {
    const tc = transformControlsRef.current;
    const ringAxis = ringDragRef.current.dragging ? ringDragRef.current.axis : null;
    const tcAxis = tc?.dragging ? (tc.axis ?? null) : null;
    const rings: ["x" | "y" | "z", THREE.Group | null][] = [
      ["x", pitchRingRef.current],
      ["y", rotateRingRef.current],
      ["z", rollRingRef.current],
    ];
    for (const [a, ring] of rings) {
      if (!ring) continue;
      ring.visible = tcAxis ? false : ringAxis ? a === ringAxis : true;
    }
    if (tc) {
      if (ringAxis) {
        tc.showX = false;
        tc.showY = false;
        tc.showZ = false;
      } else {
        tc.showX = tcAxis ? tcAxis.includes("X") : true;
        tc.showY = tcAxis ? tcAxis.includes("Y") : true;
        tc.showZ = tcAxis ? tcAxis.includes("Z") : true;
      }
    }
  }

  // SỬA (phản hồi thật user, gửi ảnh mẫu panel thông số nhân vật kiểu TopView: "Transform > Position/
  // Rotation/Scale") — báo toạ độ world/radian/scale THẬT của 1 group lên component cha qua
  // onCharacterTransform, để panel "Transform" hiện đúng số LIVE theo đúng gizmo đang làm. Gọi ở 3 chỗ:
  // ngay sau khi dựng/cập nhật group trong effect "Dựng lại mannequin" (cho nhân vật đang được chọn), và
  // mỗi khung kéo gizmo dịch chuyển (objectChange) hoặc xoay (applyRingDrag).
  function reportTransform(group: THREE.Group, url: string) {
    if (!onCharacterTransform) return;
    onCharacterTransform(url, {
      worldX: group.position.x,
      worldY: group.position.y,
      worldZ: group.position.z,
      rotationX: group.rotation.x,
      rotationY: group.rotation.y,
      rotationZ: group.rotation.z,
      scaleX: group.scale.x,
      scaleY: group.scale.y,
      scaleZ: group.scale.z,
    });
  }

  // Gắn tay cầm dịch chuyển (gizmoHandle, cao ngang hông — xem HIP_HEIGHT_FRACTION) vào đúng vị trí +
  // hướng xoay hiện tại của group, rồi attach TransformControls vào đó.
  // SỬA (phản hồi thật user: "khối tay cầm gắn vào trong tâm nhân vật tách biệt không dính vào khối cầu,
  // còn khối cầu thay đổi góc nhìn cho dễ nhận biết hơn" — tay cầm dịch chuyển trước đây đặt NGANG HÔNG,
  // trùng hẳn vị trí khối cầu xoay (cũng ở hông), nhìn chồng chéo rối mắt — giờ gắn ĐÚNG gốc nhân vật
  // (group.position, y=0 cục bộ = ngay chân), tách biệt rõ ràng khỏi khối cầu (vẫn ở hông, không đổi).
  function attachTranslateHandle(group: THREE.Group) {
    const handle = gizmoHandleRef.current;
    if (!handle) return;
    // SỬA (phản hồi thật user, gửi ảnh chụp nhân vật nằm ngửa: "gốc của tay kéo không gắn vào trong tâm
    // nhân vật" — offset trước đây CỘNG THẲNG vào world Y, không xoay theo group.rotation, nên khi nhân
    // vật đã xoay qua vòng xoay riêng (nằm ngửa/nghiêng), tay cầm vẫn trôi theo true-vertical thay vì bám
    // đúng hướng "lên" cục bộ của thân người — tách hẳn khỏi tâm nhân vật nhìn thấy. Xoay offset theo
    // group.rotation trước khi cộng (công thức y hệt hipWorld/rotatedHip ở applyRingDrag) — xem ghi chú
    // đầy đủ ở listener "dragging-changed"/"objectChange" (phần quy obj.position ngược về group.position
    // cũng phải đổi theo, trừ ĐỦ CẢ 3 TRỤC thay vì chỉ Y).
    const handleOffsetY = (group.userData.handleOffsetY as number) ?? 0;
    const rotatedOffset = new THREE.Vector3(0, handleOffsetY, 0).applyEuler(group.rotation);
    handle.position.set(
      group.position.x + rotatedOffset.x,
      group.position.y + rotatedOffset.y,
      group.position.z + rotatedOffset.z
    );
    handle.rotation.copy(group.rotation);
    transformControlsRef.current?.attach(handle);
  }
  // SỬA (phản hồi thật user: "tách cho khối cầu ra 1 camera riêng biệt" — khối cầu giờ sống trong mini-
  // scene RIÊNG, rings luôn đứng yên tại gốc (0,0,0) của mini-scene đó, không còn cần đặt vị trí/hướng
  // theo nhân vật nữa — xem effect "ring gizmo" (gizmoRingWrapRef) tự lo phần hiện/ẩn + đặt vị trí khung
  // canvas nhỏ (CSS) đúng chỗ hông nhân vật mỗi khung hình) — showRotateRingsFor/hideRotateRings giờ chỉ
  // còn bật/tắt attachedGroupRef (effect kia tự đọc ref này để quyết định hiện/ẩn).
  function showRotateRingsFor() {
    // không còn việc gì phải làm ở đây nữa — giữ lại hàm rỗng để các chỗ gọi cũ không phải sửa thêm.
  }
  function hideRotateRings() {
    // tương tự — effect "ring gizmo" tự ẩn khi attachedGroupRef.current === null.
  }
  // SỬA (phản hồi thật user: "mũi tên này hiện ngay cùng nhân vật chỉ cần chỏ chuột vào di chuyển thôi
  // không cần qua nút xoay nữa") — chọn 1 nhân vật giờ hiện LUÔN đủ 4 tay cầm cùng lúc (dịch chuyển ngang
  // hông + xoay đứng dưới chân + ngả trước/sau + nghiêng trái/phải, 2 cái sau cũng ngang hông), không
  // cần bấm nút chuyển chế độ nào nữa.
  // SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả 2" — không còn khái niệm mode nữa, chọn
  // 1 nhân vật là gắn + hiện LUÔN cả tay cầm dịch chuyển lẫn vòng xoay cùng lúc; việc ẩn bớt bên này/bên
  // kia khi hover chuyển hẳn sang syncGizmoVisibility() (chạy mỗi khung hình), không còn xử lý ở đây nữa.
  function attachGizmos(group: THREE.Group) {
    const tc = transformControlsRef.current;
    attachTranslateHandle(group);
    if (tc) {
      tc.getHelper().visible = true;
      tc.enabled = true;
    }
  }
  function selectCharacter(group: THREE.Group) {
    attachedGroupRef.current = group;
    attachedCharacterUrlRef.current = (group.userData.characterUrl as string) ?? null;
    attachGizmos(group);
    showRotateRingsFor();
    if (attachedCharacterUrlRef.current) {
      onCharacterSelect?.(attachedCharacterUrlRef.current);
      reportTransform(group, attachedCharacterUrlRef.current);
    }
    forceRerender((n) => n + 1);
  }

  // SỬA (phản hồi thật user, gửi ảnh mẫu Mixamo/Blender: "khi nhấp chuột trái vào nhân vật cho mũi tên
  // vector để di chuyển" — trước đây phải bấm nút "Di chuyển" bật chế độ riêng rồi mới bấm trúng nhân vật
  // mới gắn được tay cầm XYZ, mặc định chỉ kéo-xoay-tại-chỗ thô sơ) — bỏ hẳn khái niệm "chế độ Di chuyển"
  // lẫn kiểu kéo-xoay-tại-chỗ cũ (dragRef/draggedMannequinRef, đã xoá) — giờ bấm TRÚNG bất kỳ nhân vật nào
  // LUÔN gắn ngay tay cầm (xem selectCharacter), không cần bật chế độ gì trước. Bấm chỗ TRỐNG: nếu đang
  // có nhân vật được chọn thì BỎ CHỌN trước, rồi xoay góc nhìn như cũ.
  // SỬA (phản hồi thật user: "tách cho khối cầu ra 1 camera riêng biệt" — việc BẮT ĐẦU kéo 1 vòng xoay giờ
  // do canvas MINI riêng (gizmoRingMountRef) phát hiện qua pickGizmoRingAt, không còn chạy trong
  // handlePointerDown của khung 3D lớn nữa) — tách riêng thành hàm dùng chung beginRingDrag, gọi từ
  // pointerdown của canvas mini (xem effect "ring gizmo" bên dưới).
  function beginRingDrag(axis: "x" | "y" | "z", clientX: number) {
    updateRingHover(axis); // giữ đúng vòng đang kéo tô vàng + 2 vòng kia ẩn suốt quá trình kéo
    const group = attachedGroupRef.current;
    const hipOffsetY = (group?.userData.hipOffsetY as number) ?? 0;
    // pivotWorld = toạ độ hông THẬT ngay lúc bắt đầu kéo (world, không phải local) — xem ghi chú ở khai
    // báo ringDragRef.
    const pivotWorld = group
      ? new THREE.Vector3(0, hipOffsetY, 0).applyEuler(group.rotation).add(group.position)
      : new THREE.Vector3();
    ringDragRef.current = {
      dragging: true,
      axis,
      startX: clientX,
      startRotation: group ? group.rotation[axis] : 0,
      pivotWorld,
    };
  }
  // SỬA (cùng lý do trên) — phần ÁP DỤNG góc xoay mỗi lần chuột di chuyển trong lúc đang kéo cũng tách
  // riêng thành hàm dùng chung applyRingDrag, gọi từ pointermove của canvas mini — logic tính toán giữ
  // NGUYÊN 100% như cũ (công thức pivot hông cho X/Z, v.v.), chỉ đổi chỗ gọi.
  function applyRingDrag(clientX: number) {
    const group = attachedGroupRef.current;
    const url = attachedCharacterUrlRef.current;
    if (!group) return;
    const { axis, startX, startRotation, pivotWorld } = ringDragRef.current;
    const dx = clientX - startX;
    group.rotation[axis] = startRotation + dx * 0.012;
    // SỬA (phản hồi thật user: "khi xoay nằm ngửa và nằm nghiêng lấy gốc vector làm tâm" — trục X/Z
    // phải NGẢ QUANH ĐÚNG ĐIỂM HÔNG cố định (pivotWorld, chốt lúc bắt đầu kéo — xem beginRingDrag), không
    // phải quay quanh gốc group (luôn ở chân, y=0 cục bộ). Công thức xoay quanh 1 điểm KHÁC gốc object:
    // giữ nguyên hướng xoay mới, rồi dịch lại group.position sao cho đúng điểm hông đó (quy đổi theo
    // hướng xoay MỚI) trùng khớp lại pivotWorld — trục Y (quay đứng tại chỗ) GIỮ NGUYÊN hành vi cũ (quanh
    // chân), không áp công thức này.
    if (axis === "x" || axis === "z") {
      const hipOffsetY = (group.userData.hipOffsetY as number) ?? 0;
      const rotatedHip = new THREE.Vector3(0, hipOffsetY, 0).applyEuler(group.rotation);
      group.position.set(pivotWorld.x - rotatedHip.x, pivotWorld.y - rotatedHip.y, pivotWorld.z - rotatedHip.z);
    }
    // SỬA (phản hồi thật user, gửi ảnh chụp: "vẫn còn khi xoay" — gọi thẳng attachTranslateHandle ở đây
    // trước đó LUÔN tự attach() + hiện lại tay cầm dịch chuyển mỗi khung kéo ring, bất kể đang ở chế độ
    // "Xoay" hay không. SỬA LẦN 2 (bỏ hẳn khái niệm mode) — chỉ cần giữ VỊ TRÍ tay cầm đồng bộ theo group
    // trong lúc kéo (axis x/z đổi cả group.position do công thức pivot ở trên); việc ẨN tay cầm lúc đang
    // hover/kéo 1 cung vòng xoay đã do syncGizmoVisibility() (chạy mỗi khung hình, đọc hoveredRingAxisRef)
    // tự lo, không cần ép ẩn/hiện thủ công ở đây nữa.
    attachTranslateHandle(group);
    if (!url) return;
    if (axis === "x") onCharacterRotateX?.(url, group.rotation.x);
    else if (axis === "z") onCharacterRotateZ?.(url, group.rotation.z);
    else onCharacterRotate?.(url, group.rotation.y);
    reportTransform(group, url);
    // SỬA (axis x/z có thể dịch chuyển cả group.position do công thức pivot ở trên — phải lưu lại vị trí
    // mới, không chỉ góc xoay, nếu không nhân vật sẽ "giật" về vị trí cũ ngay lần dựng lại mannequin tiếp
    // theo, vì lib đọc lại ch.elevationY/x/y cũ).
    if (axis === "x" || axis === "z") {
      onCharacterElevate?.(url, group.position.y);
      if (onCharacterMove) {
        const nx = Math.min(1, Math.max(0, group.position.x / 5 + 0.5));
        const depth = Math.min(5, Math.max(0, -group.position.z));
        const ny = depthToY2DResolved(depth, groundCalibRef.current, horizonYRef.current, 5);
        onCharacterMove(url, { x: nx, y: ny });
      }
    }
  }
  function handlePointerDown(e: React.PointerEvent) {
    const tc = transformControlsRef.current;
    // SỬA (phản hồi thật user: "mũi tên và quả cầu sáng lên điều khiển chuột như bị đơ" — overlay canvas
    // mini giờ pointer-events:none (xem JSX), nên việc bấm trúng vòng xoay (ring) phải kiểm tra lại NGAY
    // TẠI ĐÂY, trên canvas chính — y hệt cách pickRotateRingAt làm trước khi tách camera riêng, chỉ khác
    // là raycast nhắm vào mini-scene/camera riêng của khối cầu (pickGizmoRingAt). Kiểm tra TRÚNG ring
    // TRƯỚC tc?.axis (lý do y hệt bug cũ: TransformControls tự raycast lúc hover, tc.axis có thể đã khác
    // null dù chưa trúng hẳn mũi tên, nếu kiểm tra tc?.axis trước sẽ chặn mất pickGizmoRingAt).
    // SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả 2") — chỉ cần có nhân vật đang được
    // chọn là raycast ring, không còn phụ thuộc mode nữa (vòng xoay giờ luôn hiện cùng tay cầm dịch
    // chuyển).
    const hitAxis = attachedGroupRef.current ? pickGizmoRingAt(e.clientX, e.clientY) : null;
    if (hitAxis) {
      // SỬA (phản hồi thật user: "mũi tên vừa kéo di chuyển vừa xoay nhân vật" — mũi tên dài ra (size 1.5)
      // chồng lấn nhiều hơn với khối cầu (bán kính 0.5) ở cùng vị trí ngang hông, nên 1 cú bấm trúng vùng
      // chồng lấn khiến CẢ TransformControls (tc) lẫn ring-drag tự viết đều khởi động cùng lúc —
      // TransformControls có listener pointerdown/pointermove RIÊNG gắn thẳng vào canvas (không qua
      // handler React này), nên chỉ return ở đây KHÔNG đủ để chặn nó. Phải chủ động tắt tc.enabled ngay
      // khi biết chắc đây là thao tác xoay ring — TransformControls tự kiểm tra enabled ở mỗi pointermove
      // nội bộ nên các bước kéo tiếp theo sẽ bị nó bỏ qua, không còn tranh chấp vị trí nhân vật nữa. Bật
      // lại enabled ở handlePointerUp/handlePointerLeave khi kết thúc kéo ring.
      if (tc) tc.enabled = false;
      (e.target as Element).setPointerCapture(e.pointerId);
      beginRingDrag(hitAxis, e.clientX);
      return;
    }
    if (tc?.axis) return;
    const hit = pickMannequinAt(e.clientX, e.clientY);
    if (hit) {
      selectCharacter(hit);
      return;
    }
    if (attachedCharacterUrlRef.current) {
      deselectCharacter();
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    orbitDragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startAzimuth: inspectAzimuthRef.current,
      startPitch: inspectPitchRef.current,
    };
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (ringDragRef.current.dragging) {
      applyRingDrag(e.clientX);
      return;
    }
    // SỬA (phản hồi thật user: "khi chuột vào đường tròn nào thì đường tròn đó chuyển sang màu vàng... các
    // đường tròn khác tạm thời ẩn đi" — rê chuột (không kéo gì) qua khung 3D lúc đang ở chế độ "rotate" +
    // có nhân vật chọn thì luôn kiểm tra xem đang ở trên vòng nào để cập nhật hover; không trúng vòng nào
    // thì updateRingHover(null) tự trả lại đủ cả 3 vòng.
    // SỬA LẦN 2 (phản hồi thật user: "ra ngoài mới vàng, không cố định" — rê chuột NHANH, trình duyệt chỉ
    // gửi toạ độ CUỐI CÙNG của mỗi khung hình, bỏ qua các điểm chuột đã lướt qua giữa chừng, nên có lúc
    // dải mỏng của vòng tròn bị "nhảy qua" mà không có điểm mẫu nào rơi trúng) — dùng getCoalescedEvents()
    // (API chuẩn trình duyệt, trả về MỌI vị trí chuột thật sự đã đi qua kể từ lần pointermove trước, kể cả
    // khi trình duyệt gộp lại thành 1 sự kiện) để kiểm tra từng điểm, không chỉ điểm cuối — ưu tiên điểm
    // nào trúng ring trước thì dùng kết quả đó ngay.
    // SỬA (phản hồi thật user: "tay di chuột nếu kéo nhanh bị trượt không bắt chuột nữa" — khối
    // pickGizmoRingAt bên dưới (dò xem chuột đang ở trên cung vòng xoay nào) trước đây chạy VÔ ĐIỀU KIỆN
    // mỗi pointermove, kể cả khi đang giữa 1 lượt KÉO THẬT của TransformControls (tc.dragging=true, kéo
    // tay cầm dịch chuyển) — rê chuột NHANH, các điểm toạ độ trong getCoalescedEvents() dễ "quét" ngang
    // qua đúng vùng (ảo, vòng xoay lúc này đã ẨN nhưng pickGizmoRingAt không biết, vẫn tính theo toạ độ
    // THẬT của vòng) khiến hitAxis trúng giữa chừng cú kéo, rồi dòng "tc.axis = null" (thêm ở lần sửa
    // trước, để ring thắng khi cả 2 cùng trúng lúc HOVER) VÔ TÌNH xoá mất trục đang kéo ngay giữa chừng —
    // TransformControls mất dấu trục đang thao tác, tưởng như "trượt tay, không bắt chuột nữa". Thêm điều
    // kiện chặn hẳn khối này khi tc đang dragging thật — hover-detect/ring-ưu-tiên chỉ còn ý nghĩa lúc
    // KHÔNG kéo gì cả, đang kéo tay cầm dịch chuyển thì để yên TransformControls tự lo, không can thiệp.
    if (attachedGroupRef.current && !transformControlsRef.current?.dragging) {
      const native = e.nativeEvent as PointerEvent;
      const coalesced =
        typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
      let hitAxis: "x" | "y" | "z" | null = null;
      for (const ev of coalesced.length > 0 ? coalesced : [native]) {
        hitAxis = pickGizmoRingAt(ev.clientX, ev.clientY);
        if (hitAxis) break;
      }
      updateRingHover(hitAxis);
      // SỬA (phản hồi thật user: "chỉ số bắt chuột nhạy quá, nhiều khi bắt cả tay kéo lẫn vòng tròn xoay 1
      // lúc" — tay cầm di chuyển (vòng tròn, mũi tên) và vòng xoay giờ nằm CÙNG 1 độ cao (ngang hông), vùng
      // bắt 2 bên có thể chồng lấn nhau. TransformControls tự raycast + tô vàng mũi tên riêng, HOÀN TOÀN
      // ĐỘC LẬP với pickGizmoRingAt (không biết gì về nhau) — nên có lúc cả 2 cùng sáng vàng 1 lúc, trông
      // như "bắt nhầm cả 2". Listener nội bộ của TransformControls gắn thẳng vào canvas nên LUÔN chạy
      // TRƯỚC handler React này (bubble phase, như đã ghi chú ở handlePointerDown) — tận dụng thứ tự đó,
      // hễ ring bắt trúng trục nào thì ép tc.axis = null NGAY SAU, loại bỏ hẳn kết quả raycast riêng của
      // TransformControls cho đúng khung hình này — ring luôn THẮNG khi cả 2 cùng trúng, khớp đúng quy tắc
      // ưu tiên đã áp dụng lúc kéo thật (xem handlePointerDown) và lúc ẩn/hiện (syncGizmoVisibility). CHỈ
      // áp dụng lúc đang HOVER (tc không dragging) — xem điều kiện chặn ở trên.
      if (hitAxis) {
        const tc = transformControlsRef.current;
        if (tc) tc.axis = null;
      }
    }
    if (!orbitDragRef.current.dragging) return;
    const dx = e.clientX - orbitDragRef.current.startX;
    const dy = e.clientY - orbitDragRef.current.startY;
    inspectAzimuthRef.current = orbitDragRef.current.startAzimuth - dx * 0.01;
    const MIN_PITCH = (10 * Math.PI) / 180;
    const MAX_PITCH = (85 * Math.PI) / 180;
    inspectPitchRef.current = Math.min(MAX_PITCH, Math.max(MIN_PITCH, orbitDragRef.current.startPitch + dy * 0.01));
  }
  function handleWheel(e: React.WheelEvent) {
    // SỬA (phản hồi thật user: xoay góc nhìn giờ luôn bật) — zoom bằng lăn chuột cũng luôn hoạt động,
    // không còn cần bật "Xem chi tiết"/"Di chuyển" trước.
    e.preventDefault();
    // SỬA (phản hồi thật user: "cho không gian lưới to ra và các nút hiển thị thế này" — gửi kèm ảnh chụp
    // lúc zoom hết cỡ, camera chúc sát xuống thảm, lưới phủ kín cả khung hình, không còn thấy nhân vật hay
    // bối cảnh gì nữa) — MIN_DIST cũ 2.5 cho zoom gần tới mức vô dụng này. Nâng lên 4.5, vẫn đủ gần để nhìn
    // rõ nhân vật nhưng không còn lọt thỏm giữa lưới trống nữa.
    // SỬA (phản hồi thật user: "cho khối 3D và nhân vật zoom to nhỏ thêm" — nới rộng cả 2 đầu: zoom VÀO gần
    // hơn (MIN_DIST 4.5 → 3, vẫn trên ngưỡng vô dụng 2.5 từng gặp) và zoom RA xa hơn (MAX_DIST 13 → 20) để
    // thấy được cả khối 3D/nhiều nhân vật cùng lúc khi cần.
    const MIN_DIST = 3;
    const MAX_DIST = 20;
    inspectDistanceRef.current = Math.min(MAX_DIST, Math.max(MIN_DIST, inspectDistanceRef.current + e.deltaY * 0.01));
  }
  // SỬA (phản hồi thật user: "muốn xoay 3d chỉ cần giữ chuột phải và trái là xoay" — xoay giờ LUÔN bật,
  // không còn khái niệm "chế độ Xem chi tiết" nữa) — nút cũ "Xem chi tiết" đổi thành "Reset góc nhìn",
  // chỉ còn tác dụng đưa camera về đúng góc mặc định (hữu ích sau khi đã kéo lung tung).
  function resetView() {
    inspectAzimuthRef.current = INSPECT_DEFAULTS.azimuth;
    inspectPitchRef.current = INSPECT_DEFAULTS.pitch;
    inspectDistanceRef.current = INSPECT_DEFAULTS.distance;
  }
  // SỬA (phản hồi thật user: bấm trúng nhân vật LUÔN gắn gizmo rồi, xem handlePointerDown) — nút bỏ chọn
  // rời rạc, gỡ hẳn tay cầm khỏi nhân vật đang chọn (giống bấm chỗ trống, nhưng có nút bấm trực tiếp).
  function deselectCharacter() {
    const tc = transformControlsRef.current;
    tc?.detach();
    if (tc) tc.getHelper().visible = false;
    hideRotateRings();
    updateRingHover(null);
    attachedGroupRef.current = null;
    attachedCharacterUrlRef.current = null;
    onCharacterSelect?.(null);
    forceRerender((n) => n + 1);
  }
  function handlePointerUp() {
    orbitDragRef.current.dragging = false;
    ringDragRef.current.dragging = false;
    updateRingHover(null);
    // SỬA (phản hồi thật user: "mũi tên vừa kéo di chuyển vừa xoay") — bật lại TransformControls đã tắt
    // tạm lúc beginRingDrag (xem handlePointerDown), nếu không tay cầm dịch chuyển sẽ bị đơ vĩnh viễn sau
    // lần đầu kéo ring.
    // SỬA (nghi vấn user: "nửa dưới vòng tròn không bắt chuột" — bản trước BẬT LẠI enabled=true vô điều
    // kiện, có thể đè mất tc.enabled=false mới tắt tạm ở beginRingDrag khi vẫn còn đang kéo ring). SỬA LẦN
    // 2 (bỏ hẳn khái niệm mode) — chỉ bật lại khi còn nhân vật đang được chọn (không phụ thuộc mode nữa).
    if (transformControlsRef.current) transformControlsRef.current.enabled = !!attachedGroupRef.current;
  }
  function handlePointerLeave() {
    orbitDragRef.current.dragging = false;
    ringDragRef.current.dragging = false;
    updateRingHover(null);
    if (transformControlsRef.current) transformControlsRef.current.enabled = !!attachedGroupRef.current;
    // SỬA LẠI (phản hồi thật user: "mũi tên XYZ có hiện ra nhưng không di chuyển được") — bản trước gọi
    // pointerUp(null) ở ĐÂY (pointerleave), nhưng pointerleave bắn ra ngay khi CON TRỎ CHUỘT vượt ra
    // khỏi biên khung 3D nhỏ — chuyện XẢY RA GẦN NHƯ NGAY LẬP TỨC với bất kỳ cú kéo trục X nào (khung
    // 3D nhỏ hơn hẳn biên độ kéo thực tế), nên vừa bấm kéo là bị ép huỷ dragging=false tức thì, gizmo
    // coi như không kéo được gì. Pointer CAPTURE mà TransformControls tự đặt lên canvas lúc pointerdown
    // (xem TransformControls.js onPointerDown) đã đảm bảo pointerup THẬT (khi khách thả nút chuột) vẫn
    // luôn được bắt đúng trên canvas dù thả ở đâu — nên không cần ép tắt ở pointerleave nữa, chỉ dựa vào
    // listener window-level pointerup thật (bên dưới) làm an toàn kép cho trường hợp thả chuột ra ngoài
    // cả trình duyệt.
  }

  return (
    <div
      // SỬA (phản hồi thật user: cửa sổ RỘNG nhưng KHÔNG đủ cao — "aspect-[4/3] w-full" ép chiều cao tính
      // theo chiều rộng (rộng càng lớn, cao tính ra càng lớn theo), vượt hẳn khoảng trống dọc thật của
      // khung chứa trên màn hình rộng/thấp, khung 3D TRÀN ra ngoài vùng nhìn thấy — đẩy các nút mép trên
      // (Di chuyển/gizmo, position:absolute top-1.5 TÍNH THEO CHÍNH KHUNG NÀY) ra khỏi màn hình, dù vẫn
      // tồn tại trong trang (xác nhận qua DevTools: phần tử có thật, chỉ không nhìn thấy). Thêm max-h-full
      // để trình duyệt tự ưu tiên chiều cao thật của khung chứa cha (đã có chiều cao xác định qua flexbox
      // h-screen/flex-1/stretch) khi nó NHỎ hơn 4:3 tính ra — khung 3D co lại vừa khung chứa, Three.js tự
      // resize theo đúng kích thước thật (xem ResizeObserver trong effect dựng renderer), không vỡ gì cả.
      // SỬA (phản hồi thật user: "em đổi con chuột thành mũi tên đi" — cursor-move (icon 4 mũi tên ✥) đổi
      // sang cursor-default (mũi tên chuột bình thường của hệ điều hành).
      className="relative aspect-[4/3] max-h-full w-full touch-none overflow-hidden rounded-lg bg-zinc-900 cursor-default"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {/* SỬA (phản hồi thật user: "tách cho khối cầu ra 1 camera riêng biệt" — canvas NHỎ riêng cho khối
          cầu xoay, đặt vị trí bằng CSS left/top (tính mỗi khung hình trong effect "ring gizmo" ở trên,
          chiếu toạ độ hông nhân vật lên màn hình qua camera CHÍNH), nhưng TỰ RENDER bằng renderer/camera
          RIÊNG hoàn toàn độc lập — camera đó đứng yên mãi mãi nên khối cầu luôn giữ đúng 1 hình dạng dù
          camera chính xoay góc nào. display mặc định "none", effect tự bật khi có nhân vật được chọn.
          SỬA (phản hồi thật user: "mũi tên và quả cầu sáng lên điều khiển chuột như bị đơ" — overlay này
          TRƯỚC có pointer-events:auto + stopPropagation, chặn HẾT chuột trong cả vùng hình vuông 220×220,
          kể cả phần trong suốt không có vòng tròn nào — vì tay cầm dịch chuyển đã quay lại ngang hông
          (trùng chỗ overlay này), mũi tên bên dưới bị "nuốt" mất tương tác. Đổi sang pointer-events:none —
          overlay giờ chỉ để HIỂN THỊ (canvas render riêng), hoàn toàn trong suốt với chuột; việc bấm/kéo
          ring chuyển hẳn về xử lý từ canvas 3D CHÍNH (xem handlePointerDown/handlePointerMove chính). */}
      <div ref={gizmoRingWrapRef} className="pointer-events-none absolute z-10" style={{ display: "none", width: GIZMO_RING_SIZE, height: GIZMO_RING_SIZE }}>
        <div ref={gizmoRingMountRef} className="h-full w-full" />
      </div>
      {/* SỬA (phản hồi thật user: gửi ảnh mẫu gizmo trục + nút "Reset view" đặt chung 1 cụm góc trên bên
          phải) — gộp gizmo (xem useEffect dựng gizmo phía trên) với nút reset góc nhìn vào cùng 1 cụm,
          thay cho nút "↺ Reset góc nhìn" đứng riêng lẻ ở góc trái trước đây. stopPropagation trên cả 2
          lớp (onPointerDown/onWheel) để bấm/lăn chuột trên cụm này không bị khung 3D lớn phía dưới "nuốt"
          mất thành thao tác xoay/zoom camera chính ngoài ý muốn. */}
      <div
        className="absolute right-1.5 top-1.5 flex flex-col items-center gap-1.5"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div ref={gizmoMountRef} className="h-[84px] w-[84px] cursor-pointer rounded-full bg-black/40" />
        <button
          type="button"
          onClick={resetView}
          className="rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium text-white shadow hover:bg-black/70"
        >
          ↺ Reset góc nhìn
        </button>
      </div>
      {/* SỬA (phản hồi thật user: "khi nhấp chuột trái vào nhân vật cho mũi tên vector để di chuyển" —
          bỏ hẳn nút "Di chuyển" tách riêng, bấm TRÚNG nhân vật giờ LUÔN gắn gizmo ngay, xem
          handlePointerDown) — cụm nút dịch chuyển/xoay + bỏ chọn chỉ hiện khi đang có nhân vật được chọn
          (attachedCharacterUrlRef), không cần bật chế độ gì trước nữa. */}
      {!!onCharacterMove && attachedCharacterUrlRef.current && (
        // SỬA (lỗi thật phát hiện lúc test: bấm nút "Xoay"/"Dịch chuyển"/"Bỏ chọn" bị BỎ CHỌN NGAY LẬP
        // TỨC) — thiếu stopPropagation như cụm gizmo+reset ở trên: pointerdown trên nút này LAN ra tới
        // onPointerDown của khung 3D lớn bên dưới (bubbling qua cùng 1 cây DOM), bị hiểu nhầm là "bấm
        // chỗ trống" -> tự gọi deselectCharacter() TRƯỚC KHI onClick của nút kịp chạy.
        <div className="absolute left-1.5 top-1.5 flex gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          {/* SỬA (phản hồi thật user: "bỏ nút Di chuyển/Xoay, hiện luôn cả 2, hover bên nào ẩn bớt bên
              kia" — bỏ hẳn 2 nút test tạm thời trước đây (gizmoModeRef/setGizmoMode đã xoá), chỉ còn nút
              bỏ chọn. */}
          <button
            type="button"
            onClick={deselectCharacter}
            className="rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium text-white shadow hover:bg-black/70"
          >
            ✕ Bỏ chọn
          </button>
        </div>
      )}
      {/* SỬA (phản hồi thật user: "vẫn không được, em xoá hẳn dòng chữ bên dưới đi xem được không" — đã
          thêm pointer-events-none nhưng user báo vẫn còn lỗi, nên xoá hẳn dòng chữ hướng dẫn này để loại
          trừ dứt điểm khả năng nó (hay bất kỳ phần còn sót nào liên quan) vẫn đang chặn click.) */}
    </div>
  );
}
