"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

// SỬA (phản hồi thật user: "đưa người 3D từ bên tạo ánh sáng sang thay" — khối mannequin đơn giản
// buildMannequin() quá thô so với model người thật dùng bên khung ánh sáng/camera) — dùng chung đúng 1
// model .glb ("Man" by Quaternius, CC0, public/models/man.glb — xem components/story-video/
// LightSphereModal.tsx đã dùng model này trước). Tải 1 LẦN DUY NHẤT (Promise cache module-level, không
// phải mỗi lần đổi characters lại tải lại), các nhân vật sau nhân bản từ cùng 1 template bằng
// SkeletonUtils.clone (an toàn cho cả model có rig/skeleton, khác .clone() thường dễ vỡ xương).
let manModelPromise: Promise<THREE.Group> | null = null;
function loadManModel(): Promise<THREE.Group> {
  if (!manModelPromise) {
    manModelPromise = new Promise((resolve, reject) => {
      new GLTFLoader().load(
        "/models/man.glb",
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => reject(err)
      );
    });
  }
  return manModelPromise;
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
  // Vị trí đường chân trời ước lượng cho ảnh này (0..1, 0=mép trên, 1=mép dưới) — xem depthToY2D/
  // y2DToDepth phía trên. Mặc định 0.5 (giữa ảnh) nếu chưa có dữ liệu (ảnh chưa "Dựng khối 3D" lần nào).
  horizonY?: number;
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

// Dựng bảng hiệu chuẩn "hàng ảnh <-> độ gần/xa thật" cho 1 ảnh bối cảnh — gọi 1 lần khi ảnh có đủ
// depthImageUrl + groundMaskUrl (giống buildTerrainGeometry), cache lại trong state, dùng cho MỌI lượt
// quy đổi 2D<->3D sau đó (đặt nhân vật từ ảnh 2D, đọc lại vị trí khi kéo gizmo trong 3D...).
async function buildGroundDepthCalibration(depthUrl: string, groundMaskUrl: string | null | undefined): Promise<GroundCalibration | null> {
  if (!groundMaskUrl) return null; // không có mask đất -- không đủ dữ liệu, gọi nơi dùng tự rơi về công thức horizonY
  try {
    const [depthImg, maskImg] = await Promise.all([loadImageEl(depthUrl), loadImageEl(groundMaskUrl)]);
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

    // Mask có thể khác kích thước ảnh gốc (SAM-3 tự co giãn theo input) — vẽ co giãn về ĐÚNG kích thước
    // ảnh độ sâu để đối chiếu đúng pixel-với-pixel.
    const mCanvas = document.createElement("canvas");
    mCanvas.width = w;
    mCanvas.height = h;
    const mCtx = mCanvas.getContext("2d");
    if (!mCtx) return null;
    mCtx.drawImage(maskImg, 0, 0, w, h);
    const maskData = mCtx.getImageData(0, 0, w, h).data;

    const rowBrightnessSum = new Float64Array(h);
    const rowWeightSum = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const alpha = maskData[idx + 3] / 255; // mask SAM-3: alpha = độ chắc chắn là "đất"
        if (alpha < 0.05) continue;
        const brightness = (depthData[idx] + depthData[idx + 1] + depthData[idx + 2]) / 3;
        rowBrightnessSum[y] += brightness * alpha;
        rowWeightSum[y] += alpha;
      }
    }

    const rows: number[] = [];
    const rowBrightness: number[] = [];
    for (let y = 0; y < h; y++) {
      // Hàng cần tối thiểu ~2% bề rộng ảnh là đất mới tính — tránh vài điểm lẻ (nhiễu mask) tạo ra 1
      // điểm dữ liệu không đáng tin trong bảng hiệu chuẩn.
      if (rowWeightSum[y] > w * 0.02) {
        rows.push(y);
        rowBrightness.push(rowBrightnessSum[y] / rowWeightSum[y]);
      }
    }
    if (rows.length < 10) return null; // quá ít dữ liệu đất (ảnh toàn nhà/trời, gần như không thấy đất) -- không đủ tin cậy

    // Độ sáng CÀNG CAO = CÀNG GẦN (quy ước Midas, xem ghi chú ở loadImageEl) -- nearnessRaw tăng dần theo
    // độ gần, đúng chiều mong muốn luôn, không cần tự dò chiều.
    const nearnessRaw = movingAverage1D(rowBrightness, 5); // làm mượt theo hàng, giảm nhiễu điểm ảnh thật

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
    const nearness = new Float32Array(rows.length);
    for (let i = 0; i < rows.length; i++) nearness[i] = Math.min(1, Math.max(0, (monotone[i] - lo) / range));

    return { rows: new Float32Array(rows), nearness, imgHeight: h };
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
// (5x5) và phong cách màu nhất quán (xám sáng + khung dây), worldY luôn = 0 — cho khung 3D luôn có mặt
// sàn rõ để nhân vật đứng lên.
function buildFlatGroundGeometry(gridW = 24, gridH = 20): THREE.BufferGeometry {
  const positions = new Float32Array(gridW * gridH * 3);
  const colors = new Float32Array(gridW * gridH * 3);
  const uvs = new Float32Array(gridW * gridH * 2);
  const FLAT_COLOR = new THREE.Color(0x475569);
  for (let iy = 0; iy < gridH; iy++) {
    for (let ix = 0; ix < gridW; ix++) {
      const u = ix / (gridW - 1);
      const v = iy / (gridH - 1);
      const vi = (iy * gridW + ix) * 3;
      positions[vi] = (u - 0.5) * 5;
      positions[vi + 1] = 0;
      positions[vi + 2] = -(1 - v) * 5;
      colors[vi] = FLAT_COLOR.r;
      colors[vi + 1] = FLAT_COLOR.g;
      colors[vi + 2] = FLAT_COLOR.b;
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
  horizonY = 0.5,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // Góc camera CỐ ĐỊNH, không đổi — SỬA (phản hồi thật user: "đừng cho mô hình phong cảnh quay, chỉ
  // cho nhân vật và đạo cụ di chuyển và xoay thôi"). Trước đây kéo chuột xoay CẢ CẢNH (orbit camera
  // quanh toàn bộ, kể cả địa hình) — giờ địa hình đứng yên tuyệt đối, chỉ đúng mannequin bị bấm trúng
  // mới xoay tại chỗ (xem raycastRef/draggedMannequinRef bên dưới), giống hệt cách mannequin đơn cũ
  // (components/MannequinPreviewCard.tsx) hoạt động, áp dụng cho từng người riêng khi có nhiều người.
  const azimuthRef = useRef(0);
  const raycasterRef = useRef(new THREE.Raycaster());
  const draggedMannequinRef = useRef<THREE.Group | null>(null);
  const dragRef = useRef<{ dragging: boolean; startX: number; startRotationY: number }>({ dragging: false, startX: 0, startRotationY: 0 });
  // SỬA (phản hồi thật user: "cho chế độ xem chi tiết mô hình, muốn xem vị trí nào thì trỏ chuột kéo
  // tới") — thêm 1 CHẾ ĐỘ RIÊNG để xoay/zoom tự do quan sát khối địa hình, TÁCH HẲN khỏi chế độ đặt vị
  // trí mặc định (ở đó kéo chuột chỉ xoay đúng mannequin bấm trúng, địa hình/camera đứng yên — vẫn giữ
  // nguyên, không đổi gì). Bật "Xem chi tiết" thì kéo chuột xoay CAMERA quanh khối (orbit tự do), lăn
  // chuột để phóng to/thu nhỏ — dùng ref (không phải state) vì đọc trong vòng lặp render Three.js mỗi
  // khung hình, giống cách azimuthRef hoạt động.
  const inspectModeRef = useRef(false);
  const [inspectMode, setInspectMode] = useState(false);
  const INSPECT_TARGET = { x: 0, y: 0.4, z: -2.3 }; // trùng điểm ngắm mặc định, xem updateCamera bên dưới
  const INSPECT_DEFAULTS = { azimuth: 0, pitch: (43.2 * Math.PI) / 180, distance: 6.72 }; // khớp đúng góc nhìn mặc định
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
  // SỬA (phản hồi thật user: muốn nút "Di chuyển" hiện gizmo mũi tên XYZ kéo nhân vật, tham khảo
  // TopView Film Studio) — chế độ TÁCH RIÊNG khỏi 2 chế độ trên (đặt vị trí mặc định + xem chi tiết):
  // bật lên rồi bấm trúng 1 nhân vật mới gắn gizmo TransformControls vào đúng người đó (showY=false,
  // chỉ cho kéo ngang mặt đất X/Z, không kéo lên trời được — đúng ràng buộc nhân vật luôn đứng trên
  // sàn). draggingRef để tạm NGƯNG effect dựng lại mannequin (bên dưới) trong lúc đang kéo — nếu không
  // ngưng, mỗi lần gọi onCharacterMove cập nhật locationPositions ở component cha sẽ làm characters đổi
  // reference, effect dựng lại chạy lại, PHÁ HUỶ đúng group đang gắn gizmo giữa chừng cú kéo.
  const moveModeRef = useRef(false);
  const [moveMode, setMoveMode] = useState(false);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const draggingTransformRef = useRef(false);
  const attachedCharacterUrlRef = useRef<string | null>(null);
  // SỬA (phản hồi thật user: "di chuyển được nhưng không xoay được, tạo 2 mũi tên vòng tròn quanh nhân
  // vật để xoay") — thêm chế độ con "Xoay" bên trong "Di chuyển": chuyển gizmo giữa dịch chuyển (mũi
  // tên X/Z, showY=false) và xoay quanh trục đứng (vòng tròn Y, showX=showZ=false) — chỉ xoay quanh Y vì
  // nhân vật luôn đứng thẳng trên sàn, không cần nghiêng ngả theo X/Z.
  const [gizmoMode, setGizmoMode] = useState<"translate" | "rotate">("translate");
  const gizmoModeRef = useRef<"translate" | "rotate">("translate");
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
    buildGroundDepthCalibration(depthImageUrl, groundMaskUrl).then((calib) => {
      if (!cancelled) setGroundCalib(calib);
    });
    return () => {
      cancelled = true;
    };
  }, [depthImageUrl, groundMaskUrl]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
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
      // SỬA (phản hồi thật user: bấm "Di chuyển" thì chế độ xoay góc nhìn ở "Xem chi tiết" bị khoá) —
      // trước đây CHỈ orbit khi inspectModeRef, 2 chế độ loại trừ nhau. Giờ GỘP: orbit camera áp dụng
      // bất cứ khi nào đang ở 1 trong 2 chế độ (Xem chi tiết HOẶC Di chuyển) — cho phép vừa xoay góc nhìn
      // vừa kéo gizmo di chuyển nhân vật trong CÙNG 1 chế độ "Di chuyển", không cần thoát ra bật riêng.
      if (inspectModeRef.current || moveModeRef.current) {
        // Orbit tự do quanh INSPECT_TARGET theo azimuth/pitch/distance do khách kéo/lăn chuột chỉnh (xem
        // handlePointerMove/handleWheel), không còn cố định như chế độ đặt vị trí.
        const az = inspectAzimuthRef.current;
        const pitch = inspectPitchRef.current;
        const dist = inspectDistanceRef.current;
        camera.position.set(
          INSPECT_TARGET.x + Math.sin(az) * Math.cos(pitch) * dist,
          INSPECT_TARGET.y + Math.sin(pitch) * dist,
          INSPECT_TARGET.z + Math.cos(az) * Math.cos(pitch) * dist
        );
        camera.lookAt(INSPECT_TARGET.x, INSPECT_TARGET.y, INSPECT_TARGET.z);
        return;
      }
      const camHeight = 5.0;
      const camDepthOffset = 2.6;
      const az = azimuthRef.current;
      camera.position.set(Math.sin(az) * camDepthOffset, camHeight, Math.cos(az) * camDepthOffset);
      camera.lookAt(0, 0.4, -2.3);
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

    // Gizmo mũi tên XYZ kéo nhân vật (chế độ "Di chuyển") — showY=false: chỉ cho kéo theo X/Z (mặt
    // đất), KHÔNG cho kéo lên/xuống (nhân vật luôn đứng trên sàn, không có trục "nhảy lên"). Thêm
    // getHelper() vào scene (bản three.js mới, API tách riêng phần hiển thị khỏi logic điều khiển),
    // chưa gắn vào object nào (object=undefined) cho tới khi khách bấm trúng 1 nhân vật ở chế độ này.
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode("translate");
    transformControls.showY = false;
    transformControls.size = 0.8;
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    // SỬA (phản hồi thật user: "khoá không cho nhân vật bị kéo vượt ra khỏi thảm") — thảm 3D rộng đúng
    // X: -2.5..2.5, Z: -5..0 (xem buildFlatGroundGeometry/công thức (u-0.5)*5 và -(1-v)*5 ở trên) — nhân
    // vật kéo ra ngoài vùng này sẽ "lơ lửng" ngoài thảm, không hợp lý. KHÔNG kẹp biên ngay trong lúc kéo
    // (objectChange) vì bài học cũ: ghi đè obj.position giữa chừng phá vỡ cách TransformControls tự tính
    // delta bước kéo tiếp theo, gây lệch trục Z (xem comment "kéo về trục Z thì ảnh 2D vị trí sai" bên
    // dưới) — chỉ kẹp biên 1 LẦN DUY NHẤT ngay khi BUÔNG TAY (dragging-changed, value=false), không còn
    // ảnh hưởng gì tới các bước kéo giữa chừng nữa.
    const MAT_HALF_WIDTH = 2.5; // X: -2.5..2.5
    const MAT_DEPTH = 5; // Z: -5..0
    transformControls.addEventListener("dragging-changed", (event) => {
      draggingTransformRef.current = !!event.value;
      if (event.value) return; // vừa bắt đầu kéo -- không kẹp, chỉ kẹp lúc buông tay
      const obj = transformControls.object;
      const url = attachedCharacterUrlRef.current;
      if (!obj) return;
      const clampedX = Math.min(MAT_HALF_WIDTH, Math.max(-MAT_HALF_WIDTH, obj.position.x));
      const clampedZ = Math.min(0, Math.max(-MAT_DEPTH, obj.position.z));
      if (clampedX === obj.position.x && clampedZ === obj.position.z) return; // không vượt biên -- không cần làm gì thêm
      obj.position.x = clampedX;
      obj.position.z = clampedZ;
      if (!url || !onCharacterMove || gizmoModeRef.current === "rotate") return;
      const x = Math.min(1, Math.max(0, clampedX / 5 + 0.5));
      const depth = Math.min(5, Math.max(0, -clampedZ));
      const y = depthToY2DResolved(depth, groundCalibRef.current, horizonYRef.current, 5);
      onCharacterMove(url, { x, y });
    });
    transformControls.addEventListener("objectChange", () => {
      const obj = transformControls.object;
      const url = attachedCharacterUrlRef.current;
      if (!obj || !url) return;
      // SỬA (phản hồi thật user: "di chuyển được nhưng không xoay được") — objectChange giờ dùng chung
      // cho cả 2 chế độ con (dịch chuyển/xoay), phân nhánh theo gizmoModeRef — chỉ đọc đúng giá trị
      // tương ứng chế độ đang bật, không đụng tới giá trị còn lại.
      if (gizmoModeRef.current === "rotate") {
        onCharacterRotate?.(url, obj.rotation.y);
        return;
      }
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
      const x = Math.min(1, Math.max(0, obj.position.x / 5 + 0.5));
      const depth = Math.min(5, Math.max(0, -obj.position.z));
      const y = depthToY2DResolved(depth, groundCalibRef.current, horizonYRef.current, 5);
      onCharacterMove(url, { x, y });
    });

    let raf = 0;
    function loop() {
      updateCamera();
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
    const onWindowPointerUp = () => transformControlsRef.current?.pointerUp(null);
    window.addEventListener("pointerup", onWindowPointerUp);
    return () => window.removeEventListener("pointerup", onWindowPointerUp);
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
    if (draggingTransformRef.current) return;
    let cancelled = false;
    (async () => {
      const template = await loadManModel().catch(() => null);
      if (cancelled) return;
      const sc = sceneRef.current;
      if (!sc) return;
      const old = sc.children.filter((c) => c.userData.isCharacterMannequin);
      old.forEach((c) => sc.remove(c));
      if (!template) return; // model .glb lỗi/không tải được — bỏ qua, không chặn khung 3D còn lại

      const SPREAD_X = 5;
      const SPREAD_Z = 5;
      // Scale theo CHIỀU CAO thật của model (đo 1 lần từ template, áp dụng chung cho mọi bản sao) —
      // TARGET_HEIGHT=1.6 khớp đúng cỡ mannequin cũ (3.8 đơn vị gốc × scale 0.42 ≈ 1.6), không đổi tỉ
      // lệ so với lưới địa hình 5×5 đã quen mắt từ trước.
      // SỬA (phản hồi thật user: "phải lấy mặt đất gốc toạ độ y bằng 0") — trước đây TIN gốc model đã
      // nằm đúng ở chân (min.y≈0, dựa theo ghi chú ở LightSphereModal.tsx) nên đặt thẳng position.y=0,
      // KHÔNG tự đo lại — không chắc chắn, rủi ro model/máy nhân bản (SkeletonUtils.clone trên rig) lệch
      // gốc khiến chân lơ lửng hoặc chìm xuống đất. Giờ ĐO LẠI min.y thật của model rồi tính groundOffset
      // bù trực tiếp, đảm bảo chân LUÔN chạm đúng y=0 world, không phụ thuộc giả định về gốc toạ độ gốc.
      const box = new THREE.Box3().setFromObject(template);
      const size = new THREE.Vector3();
      box.getSize(size);
      const TARGET_HEIGHT = 1.6;
      const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
      const groundOffset = -box.min.y * scale; // dịch model lên/xuống để chân (điểm thấp nhất) luôn = y=0

      let justAttachedGroup: THREE.Group | null = null;
      for (const ch of characters) {
        const group = new THREE.Group();
        group.userData.isCharacterMannequin = true;
        group.userData.characterUrl = ch.url; // dùng để tra lại đúng nhân vật khi chọn ở chế độ "Di chuyển"
        const model = cloneSkeleton(template) as THREE.Group;
        model.scale.setScalar(scale);
        model.position.y = groundOffset;
        group.add(model);

        // Model người thật giữ nguyên màu da/trang phục gốc (không tô màu đè lên, dễ vỡ hình/trông giả)
        // — phân biệt từng nhân vật bằng 1 chấm tròn màu đúng theo màu marker 2D, đặt ngay dưới chân.
        const ring = new THREE.Mesh(
          new THREE.CircleGeometry(0.35, 24),
          new THREE.MeshBasicMaterial({ color: ch.color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.015;
        group.add(ring);

        // SỬA (phản hồi thật user: chấm 2D bay lên trời khi kéo nhân vật ra xa, rồi "chưa sát mặt đất")
        // — worldZ không còn tính tuyến tính theo ch.y nữa, dùng y2DToDepthResolved (ưu tiên bảng hiệu
        // chuẩn thật từ depth map + ground mask, rơi về công thức horizonY khi thiếu dữ liệu).
        const worldX = (ch.x - 0.5) * SPREAD_X;
        const worldZ = -y2DToDepthResolved(ch.y, groundCalib, horizonY, SPREAD_Z);
        group.position.set(worldX, 0, worldZ);
        // SỬA (phản hồi thật user: xoay nhân vật qua gizmo xong bị mất góc xoay mỗi khi dựng lại
        // mannequin) — áp lại góc xoay đã lưu (nếu có), giữ nguyên hướng đứng giữa các lần dựng lại.
        group.rotation.y = ch.rotationY ?? 0;
        sc.add(group);
        if (ch.url === attachedCharacterUrlRef.current) justAttachedGroup = group;
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
        transformControlsRef.current?.attach(justAttachedGroup);
      } else {
        transformControlsRef.current?.detach();
        attachedCharacterUrlRef.current = null;
      }

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [characters, horizonY, groundCalib]);

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

  // Dựng lưới địa hình (heightmap) từ ảnh độ sâu — thay cho khối hộp vuông vức trước đây, cho hình
  // dạng lồi lõm giống địa hình thật (núi/vách đá nhô ra, chỗ xa lõm vào) thay vì khối chữ nhật phẳng
  // lì. Vẽ cả mặt đặc (mờ) lẫn khung dây (wireframe) đè lên — khớp đúng kiểu "low-poly wireframe" đã
  // tham khảo, dễ nhìn rõ hình khối khi xoay.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.children.filter((c) => c.userData.isLocationBlock).forEach((c) => scene.remove(c));
    const flatGeo = buildFlatGroundGeometry();
    const flatSolid = new THREE.Mesh(
      flatGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide })
    );
    flatSolid.userData.isLocationBlock = true;
    scene.add(flatSolid);
    const flatWire = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({ color: 0x374151, wireframe: true }));
    flatWire.userData.isLocationBlock = true;
    scene.add(flatWire);
    const flatOutline = buildEdgeOutline(flatGeo.getAttribute("position").array as Float32Array, 24, 20);
    flatOutline.userData.isLocationBlock = true;
    scene.add(flatOutline);
    forceRerender((n) => n + 1);
  }, []);

  // Phủ ảnh đất thật (groundMaskUrl, đã được SAM-3 cắt theo đúng vùng đất) lên trên mặt sàn xám -- SỬA
  // (yêu cầu thật user: "trải lên trên thảm 3D") -- tách effect riêng (không gộp vào effect dựng sàn ở
  // trên) vì sàn chỉ cần dựng 1 lần (deps []), còn texture cần load lại mỗi khi groundMaskUrl đổi (ảnh
  // bối cảnh khác). Dùng alphaTest để vùng ngoài mask (alpha thấp, không phải đất) không che mất sàn xám
  // bên dưới, lệch nhẹ lên trục Y để tránh z-fighting với mặt sàn gốc.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.children.filter((c) => c.userData.isGroundTexture).forEach((c) => scene.remove(c));
    if (!groundMaskUrl) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(groundMaskUrl, (texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        buildFlatGroundGeometry(),
        new THREE.MeshStandardMaterial({
          map: texture,
          transparent: true,
          alphaTest: 0.1,
          roughness: 0.95,
          metalness: 0,
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
  }, [groundMaskUrl]);

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
    const hits = raycasterRef.current.intersectObjects(mannequins, true);
    if (hits.length === 0) return null;
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !obj.userData.isCharacterMannequin) obj = obj.parent;
    return (obj as THREE.Group) ?? null;
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (moveModeRef.current) {
      // SỬA (phản hồi thật user: bấm "Di chuyển" thì mất luôn khả năng xoay góc nhìn) — chế độ "Di
      // chuyển" giờ gộp cả 2: bấm TRÚNG nhân vật thì gắn gizmo XYZ (kéo gizmo tự TransformControls xử
      // lý); bấm/kéo chỗ TRỐNG (không trúng gizmo, không trúng nhân vật) thì XOAY GÓC NHÌN như "Xem chi
      // tiết" — không còn gỡ gizmo khi bấm trượt ra ngoài nữa (giữ nguyên lựa chọn, chỉ đổi góc camera).
      const tc = transformControlsRef.current;
      if (!tc) return;
      // Bấm TRÚNG gizmo (tc.axis khác null, do TransformControls tự raycast lúc hover trước đó) — để
      // chính TransformControls xử lý kéo, KHÔNG chạy logic bên dưới.
      if (tc.axis) return;
      const hit = pickMannequinAt(e.clientX, e.clientY);
      if (hit) {
        tc.attach(hit);
        attachedCharacterUrlRef.current = (hit.userData.characterUrl as string) ?? null;
        forceRerender((n) => n + 1);
        return;
      }
      // Không trúng gì cả -> xoay góc nhìn, giữ nguyên gizmo đang gắn (nếu có).
      (e.target as Element).setPointerCapture(e.pointerId);
      orbitDragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        startAzimuth: inspectAzimuthRef.current,
        startPitch: inspectPitchRef.current,
      };
      return;
    }
    if (inspectModeRef.current) {
      // Chế độ "Xem chi tiết" — kéo ở BẤT KỲ đâu trong khung (không cần trúng mannequin) đều xoay camera
      // quanh khối, khác hẳn chế độ đặt vị trí (chỉ xoay đúng mannequin bấm trúng).
      (e.target as Element).setPointerCapture(e.pointerId);
      orbitDragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        startAzimuth: inspectAzimuthRef.current,
        startPitch: inspectPitchRef.current,
      };
      return;
    }
    const hit = pickMannequinAt(e.clientX, e.clientY);
    if (!hit) return; // bấm trúng địa hình/khoảng trống -> không xoay gì cả
    (e.target as Element).setPointerCapture(e.pointerId);
    draggedMannequinRef.current = hit;
    dragRef.current = { dragging: true, startX: e.clientX, startRotationY: hit.rotation.y };
  }
  function handlePointerMove(e: React.PointerEvent) {
    // SỬA (phản hồi thật user: bấm "Di chuyển" thì mất khả năng xoay góc nhìn) — chế độ "Di chuyển" giờ
    // dùng CHUNG logic orbit với "Xem chi tiết" (chỉ chạy khi orbitDragRef.dragging=true, bắt đầu từ
    // handlePointerDown khi bấm trúng chỗ trống — kéo gizmo thật thì TransformControls tự lo riêng,
    // không qua đây).
    if (moveModeRef.current || inspectModeRef.current) {
      if (!orbitDragRef.current.dragging) return;
      const dx = e.clientX - orbitDragRef.current.startX;
      const dy = e.clientY - orbitDragRef.current.startY;
      inspectAzimuthRef.current = orbitDragRef.current.startAzimuth - dx * 0.01;
      const MIN_PITCH = (10 * Math.PI) / 180;
      const MAX_PITCH = (85 * Math.PI) / 180;
      inspectPitchRef.current = Math.min(MAX_PITCH, Math.max(MIN_PITCH, orbitDragRef.current.startPitch + dy * 0.01));
      return;
    }
    if (!dragRef.current.dragging || !draggedMannequinRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    draggedMannequinRef.current.rotation.y = dragRef.current.startRotationY + dx * 0.012;
  }
  function handleWheel(e: React.WheelEvent) {
    if (!inspectModeRef.current && !moveModeRef.current) return;
    e.preventDefault();
    const MIN_DIST = 2.5;
    const MAX_DIST = 13;
    inspectDistanceRef.current = Math.min(MAX_DIST, Math.max(MIN_DIST, inspectDistanceRef.current + e.deltaY * 0.01));
  }
  function toggleInspectMode() {
    setInspectMode((prev) => {
      const next = !prev;
      inspectModeRef.current = next;
      // SỬA (phản hồi thật user: bấm "Di chuyển" khoá mất "Xem chi tiết") — KHÔNG còn ép tắt chế độ kia
      // nữa, 2 nút giờ độc lập — chỉ reset góc nhìn về mặc định khi bật lên từ trạng thái CẢ HAI đều
      // đang tắt (tránh giật hình nếu đang orbit dở từ chế độ kia).
      if (next && !moveModeRef.current) {
        inspectAzimuthRef.current = INSPECT_DEFAULTS.azimuth;
        inspectPitchRef.current = INSPECT_DEFAULTS.pitch;
        inspectDistanceRef.current = INSPECT_DEFAULTS.distance;
      }
      return next;
    });
  }
  function toggleMoveMode() {
    setMoveMode((prev) => {
      const next = !prev;
      moveModeRef.current = next;
      // SỬA (phản hồi thật user: bấm "Di chuyển" khoá mất khả năng xoay ở "Xem chi tiết") — không còn
      // ép tắt "Xem chi tiết" nữa; "Di chuyển" tự nó đã có khả năng orbit khi bấm chỗ trống (xem
      // handlePointerDown), chỉ reset góc nhìn mặc định khi bật lên từ trạng thái cả 2 đều tắt.
      if (next && !inspectModeRef.current) {
        inspectAzimuthRef.current = INSPECT_DEFAULTS.azimuth;
        inspectPitchRef.current = INSPECT_DEFAULTS.pitch;
        inspectDistanceRef.current = INSPECT_DEFAULTS.distance;
      }
      if (!next) {
        transformControlsRef.current?.detach();
        attachedCharacterUrlRef.current = null;
        gizmoModeRef.current = "translate";
        setGizmoMode("translate");
        transformControlsRef.current?.setMode("translate");
        if (transformControlsRef.current) {
          transformControlsRef.current.showX = true;
          transformControlsRef.current.showY = false;
          transformControlsRef.current.showZ = true;
        }
      }
      return next;
    });
  }
  // SỬA (phản hồi thật user: "di chuyển được nhưng không xoay được, tạo 2 mũi tên vòng tròn quanh nhân
  // vật để xoay") — chuyển gizmo giữa dịch chuyển (mũi tên X/Z) và xoay (vòng tròn quanh trục Y) —
  // TransformControls chỉ hiện đúng 1 kiểu tay cầm tại 1 thời điểm (setMode), showX/Y/Z quyết định trục
  // nào có tay cầm trong chế độ đó.
  function setGizmoModeTo(mode: "translate" | "rotate") {
    gizmoModeRef.current = mode;
    setGizmoMode(mode);
    const tc = transformControlsRef.current;
    if (!tc) return;
    tc.setMode(mode);
    if (mode === "translate") {
      tc.showX = true;
      tc.showY = false;
      tc.showZ = true;
    } else {
      tc.showX = false;
      tc.showY = true;
      tc.showZ = false;
    }
  }
  function handlePointerUp() {
    dragRef.current.dragging = false;
    draggedMannequinRef.current = null;
    orbitDragRef.current.dragging = false;
  }
  function handlePointerLeave() {
    dragRef.current.dragging = false;
    draggedMannequinRef.current = null;
    orbitDragRef.current.dragging = false;
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
      className={`relative aspect-[4/3] w-full touch-none overflow-hidden rounded-lg bg-zinc-900 ${
        inspectMode || moveMode ? "cursor-move" : ""
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onWheel={handleWheel}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute left-1.5 top-1.5 flex gap-1.5">
        <button
          type="button"
          onClick={toggleInspectMode}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium shadow ${
            inspectMode ? "bg-indigo-500 text-white" : "bg-black/50 text-white hover:bg-black/70"
          }`}
        >
          {inspectMode ? "✕ Thoát xem chi tiết" : "🔎 Xem chi tiết"}
        </button>
        {!!onCharacterMove && (
          <button
            type="button"
            onClick={toggleMoveMode}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium shadow ${
              moveMode ? "bg-amber-500 text-white" : "bg-black/50 text-white hover:bg-black/70"
            }`}
          >
            {moveMode ? "✕ Thoát di chuyển" : "✥ Di chuyển"}
          </button>
        )}
        {/* SỬA (phản hồi thật user: "di chuyển được nhưng không xoay được, tạo 2 mũi tên vòng tròn quanh
            nhân vật để xoay") — chỉ hiện khi đang ở "Di chuyển" VÀ đã chọn trúng 1 nhân vật (gizmo đang
            gắn vào ai đó) — không có gì để xoay nếu chưa chọn nhân vật nào. */}
        {moveMode && attachedCharacterUrlRef.current && (
          <div className="flex overflow-hidden rounded-full shadow">
            <button
              type="button"
              onClick={() => setGizmoModeTo("translate")}
              className={`px-2.5 py-1 text-[11px] font-medium ${
                gizmoMode === "translate" ? "bg-amber-500 text-white" : "bg-black/50 text-white hover:bg-black/70"
              }`}
              title="Di chuyển vị trí"
            >
              ↔ Dịch chuyển
            </button>
            <button
              type="button"
              onClick={() => setGizmoModeTo("rotate")}
              className={`px-2.5 py-1 text-[11px] font-medium ${
                gizmoMode === "rotate" ? "bg-amber-500 text-white" : "bg-black/50 text-white hover:bg-black/70"
              }`}
              title="Xoay hướng đứng"
            >
              ⟳ Xoay
            </button>
          </div>
        )}
      </div>
      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
        {moveMode
          ? gizmoMode === "rotate"
            ? "⟳ Kéo vòng tròn để xoay hướng đứng — kéo chỗ trống để xoay góc nhìn"
            : "✥ Bấm nhân vật rồi kéo mũi tên để di chuyển — kéo chỗ trống để xoay góc nhìn"
          : inspectMode
            ? "🖱️ Kéo để xoay góc nhìn, lăn chuột để zoom"
            : "🔄 Kéo vào nhân vật để xoay riêng người đó"}
      </span>
    </div>
  );
}
