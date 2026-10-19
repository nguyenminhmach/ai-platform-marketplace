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

export type PositionedCharacter = {
  url: string;
  name: string;
  color: string;
  // Toạ độ chuẩn hoá 0..1 đã chọn trên ảnh 2D (xem locationPositions ở VideoTuYTuongClient.tsx) — x:
  // trái(0)->phải(1), y: xa(0, gần đỉnh ảnh)->gần(1, gần đáy ảnh).
  x: number;
  y: number;
};

type Props = {
  locationUrl: string;
  characters: PositionedCharacter[];
  // Ảnh độ sâu Fal trả về (xem nút "Dựng khối 3D" ở VideoTuYTuongClient.tsx) — tuỳ chọn, nếu chưa gọi
  // hoặc chưa xong thì khung 3D vẫn hiển thị bình thường (chỉ mannequin + phông ảnh phẳng), không chặn
  // gì cả. Khi có, dựng thành 1 LƯỚI ĐỊA HÌNH lồi lõm (heightmap mesh) — xem buildTerrainGeometry bên
  // dưới. SỬA (phản hồi thật user lần 2): bỏ hẳn khối hộp vuông vức dựng từ phân vùng (segments) — địa
  // hình tự nhiên lồi lõm hợp lý hơn, và không cần gọi thêm AI phân vùng nữa (chỉ cần ảnh độ sâu đã có).
  depthImageUrl?: string | null;
  // SỬA lần 3 (phản hồi thật user: "chỗ nào vách đá thì cao, chỗ nào đường mòn thì thấp") — độ sâu một
  // mình không phân biệt được "mặt đất bằng phẳng" với "vách đá dựng đứng" (đường mòn gần ống kính nhất
  // lại bị tính thành cao nhất, sai hướng). Mask PNG từ fal-ai/sam-3/image (prompt "ground", alpha>0 =
  // thuộc vùng mặt đất) — dùng ép vùng này về gần phẳng khi dựng lưới, vùng còn lại giữ nguyên cách tính
  // cũ. Tuỳ chọn, null thì lưới dựng y như trước (chỉ mất phần phân biệt đất/đá).
  groundMaskUrl?: string | null;
  // SỬA lần 4 (phản hồi thật user: ảnh phố có điểm hội tụ phối cảnh ra hình "phễu/xoáy" méo mó) — biến
  // độ sâu thành độ cao chỉ hợp cảnh THIÊN NHIÊN (núi/vách đá), KHÔNG hợp ảnh phố/kiến trúc/nội thất
  // (luôn méo do cách phối cảnh hội tụ). true (mặc định, xem generateLocationBlockout) = dựng địa hình
  // gồ ghề như cũ; false = CHỈ hiện sàn phẳng cho nhân vật đứng, không dựng khối từ độ sâu nữa.
  isNaturalTerrain?: boolean;
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

// Đọc ảnh độ sâu (Midas — càng sáng càng gần máy ảnh) bằng canvas, dựng 1 lưới điểm (heightmap) — mỗi
// điểm có toạ độ world (x, z) tính từ vị trí trên ảnh (y: trên ảnh (0, xa)->dưới ảnh (1, gần), x: trái
// (0)->phải (1), ĐÚNG công thức world-mapping đã dùng cho nhân vật, để lưới địa hình và nhân vật nằm
// cùng 1 hệ toạ độ) và chiều cao (world y) tính từ độ sáng tại đúng điểm đó trên ảnh độ sâu — vùng gần
// (sáng) nhô cao hơn, vùng xa (tối) thấp hơn, cho cảm giác lồi lõm thật thay vì khối hộp phẳng lì.
// Lấy độ sáng trung bình 1 vùng nhỏ quanh (px, py) thay vì đúng 1 điểm ảnh — SỬA (phản hồi thật user:
// lưới ra hình "tường dựng đứng có vằn dọc", không mịn như ảnh tham khảo). Nguyên nhân: ảnh gốc có
// nhiều cây thưa trong sương mù, AI đo độ sâu ra kết quả rất nhiễu theo từng thân cây — lấy đúng 1 pixel
// mỗi điểm lưới giữ nguyên hết nhiễu đó. Lấy trung bình 1 ô vuông nhỏ quanh mỗi điểm làm mượt bớt nhiễu,
// cho địa hình trông liền mạch hơn (giống san phẳng các gai nhọn lẻ tẻ) mà vẫn giữ được hình dạng tổng
// thể (núi cao/thấp chỗ nào vẫn đúng, chỉ bớt lởm chởm chi tiết vụn).
function sampleBrightnessAveraged(data: Uint8ClampedArray, canvasW: number, canvasH: number, px: number, py: number, radius: number): number {
  let sum = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || x >= canvasW || y < 0 || y >= canvasH) continue;
      sum += data[(y * canvasW + x) * 4];
      count++;
    }
  }
  return count > 0 ? sum / count / 255 : 0;
}

// Làm mượt TRỰC TIẾP trên lưới đã chuẩn hoá (không phải pixel ảnh gốc nữa) — SỬA (phản hồi thật user:
// đẩy biên độ cao lên 3.6 làm lộ lại nhiễu thành "rừng gai nhọn", y hệt lỗi trước đó dù đã làm mượt ảnh
// gốc). Nguyên nhân: làm mượt pixel ảnh gốc và biên độ cao nhân VÀO SAU — nhiễu còn sót lại bị khuếch
// đại tỉ lệ thuận với biên độ, biên độ càng cao nhiễu càng lộ rõ. San phẳng thêm 1 lượt NGAY TRÊN lưới
// đã chuẩn hoá (trung bình các ô lân cận) loại bỏ nhiễu tần số cao còn sót, độc lập với biên độ cao áp
// dụng sau đó — tăng biên độ bao nhiêu cũng không kéo nhiễu trở lại.
function smoothGrid(arr: Float32Array, gridW: number, gridH: number, radius: number): Float32Array {
  const out = new Float32Array(arr.length);
  for (let iy = 0; iy < gridH; iy++) {
    for (let ix = 0; ix < gridW; ix++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = ix + dx;
          const y = iy + dy;
          if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
          sum += arr[y * gridW + x];
          count++;
        }
      }
      out[iy * gridW + ix] = sum / count;
    }
  }
  return out;
}

// SỬA (phản hồi thật user — chỉ muốn nâng lưới địa hình mịn hơn, KHÔNG làm nhân vật photorealistic
// như ảnh tham khảo thứ 2, việc đó thuộc bước tạo ảnh AI thật, không phải khung xem trước 3D này):
// tăng mật độ lưới (36x22 -> 64x40 -> 128x80) để mặt tam giác nhỏ/mịn hơn, giống đúng kiểu ảnh tham
// khảo đầu — LƯỚI VẪN LÀ 1 TẤM TAM GIÁC LIÊN KẾT (BufferGeometry + indices bên dưới), KHÔNG PHẢI từng
// khối hộp rời rạc kiểu Minecraft (dù user có tham khảo lời khuyên nói vậy) — bump 128x80 chỉ để mịn
// hơn nữa, không đổi cách dựng khối.
// Đọc mask "mặt đất" (PNG trong suốt, alpha>0 = thuộc vùng được SAM-3 chọn) tại đúng (u,v) tương ứng
// trên lưới — trả về "trọng số mặt đất" 0..1 (1 = chắc chắn là đất/đường đi, ép gần phẳng). Ảnh mask có
// thể khác kích thước/tỉ lệ ảnh độ sâu (SAM-3 tự co giãn theo input) nên tính riêng canvas + toạ độ
// pixel của chính nó, không dùng chung canvas với ảnh độ sâu.
async function loadGroundWeightGrid(maskUrl: string, gridW: number, gridH: number): Promise<Float32Array | null> {
  try {
    const img = await loadImageEl(maskUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const blurRadius = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 64));
    const weights = new Float32Array(gridW * gridH);
    for (let iy = 0; iy < gridH; iy++) {
      for (let ix = 0; ix < gridW; ix++) {
        const u = ix / (gridW - 1);
        const v = iy / (gridH - 1);
        const px = Math.min(canvas.width - 1, Math.floor(u * (canvas.width - 1)));
        const py = Math.min(canvas.height - 1, Math.floor(v * (canvas.height - 1)));
        let sum = 0;
        let count = 0;
        for (let dy = -blurRadius; dy <= blurRadius; dy++) {
          for (let dx = -blurRadius; dx <= blurRadius; dx++) {
            const x = px + dx;
            const y = py + dy;
            if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
            sum += data[(y * canvas.width + x) * 4 + 3]; // kênh alpha
            count++;
          }
        }
        weights[iy * gridW + ix] = count > 0 ? sum / count / 255 : 0;
      }
    }
    return smoothGrid(weights, gridW, gridH, 2);
  } catch {
    return null; // mask lỗi/không tải được — bỏ qua, dựng lưới như không có mask (fallback an toàn)
  }
}

async function buildTerrainGeometry(
  depthUrl: string,
  groundMaskUrl: string | null | undefined,
  gridW = 128,
  gridH = 80
): Promise<THREE.BufferGeometry | null> {
  try {
    const img = await loadImageEl(depthUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // SỬA (thử lưới dày hơn 128x80 ra hình "rừng gai nhọn" nhiễu loạn, quá đà) — blurRadius trước đây tỷ
    // lệ nghịch với gridW (lưới càng dày, bán kính làm mượt càng nhỏ) nên tăng mật độ lưới vô tình làm
    // GIẢM độ mượt, để lộ hết nhiễu điểm ảnh của ảnh độ sâu thật thành từng gai nhọn riêng lẻ. Cố định
    // blurRadius theo 1 mật độ tham chiếu 64 (không đổi theo gridW thật) — tăng độ phân giải lưới vẫn cho
    // mặt tam giác mịn hơn, nhưng độ làm mượt dữ liệu nguồn không bị giảm theo.
    const blurRadius = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 64));

    // SỬA lần 1 (phản hồi thật user: khối vẫn ra gần như tấm phẳng, chỉ hơi vênh 1 góc) — co giãn theo
    // min/max thô vẫn CHƯA đủ: ảnh độ sâu thật của cảnh này phần lớn (bầu trời/biển/vách đá xa) nằm sát
    // nhau trong 1 khoảng hẹp, chỉ riêng lối mòn đất ở tiền cảnh (rất gần máy ảnh) sáng vọt hẳn lên —
    // dùng ĐÚNG min/max tuyệt đối làm 2 đầu dải thì 1 điểm sáng bất thường đó kéo giãn cả thang đo, dồn
    // toàn bộ phần còn lại (chiếm đa số lưới) về sát 0 — đúng hình "phẳng + 1 góc vênh" user chụp lại.
    // SỬA lần 2: (1) cắt theo PERCENTILE 5%-95% thay vì min/max tuyệt đối — bỏ qua các điểm sáng/tối bất
    // thường ở 2 đầu, không để chúng kéo giãn cả thang đo; (2) áp thêm đường cong gamma (mũ 0.6) sau khi
    // co giãn — kéo các vùng tối/trung bình (đa số lưới) sáng lên tương đối, cho cảm giác gồ ghề rõ hơn
    // trên toàn bộ lưới thay vì chỉ 1 vùng nhỏ nổi bật còn lại phẳng lì.
    const rawBrightness = new Float32Array(gridW * gridH);
    for (let iy = 0; iy < gridH; iy++) {
      for (let ix = 0; ix < gridW; ix++) {
        const u = ix / (gridW - 1);
        const v = iy / (gridH - 1);
        const px = Math.min(canvas.width - 1, Math.floor(u * (canvas.width - 1)));
        const py = Math.min(canvas.height - 1, Math.floor(v * (canvas.height - 1)));
        rawBrightness[iy * gridW + ix] = sampleBrightnessAveraged(data, canvas.width, canvas.height, px, py, blurRadius);
      }
    }
    const sorted = Array.from(rawBrightness).sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
    const lo = percentile(0.05);
    const hi = percentile(0.95);
    const range = hi - lo || 1;

    // SỬA (xác nhận user: hết cache cũ, lưới đã mịn đúng code mới, NHƯNG độ cao vẫn thấp/phẳng so với
    // ảnh núi tham khảo — cảnh vách đá tầm xa này vốn có độ chênh lệch khoảng cách thật không lớn,
    // không phải canyon cận cảnh). User đồng ý đánh đổi: đẩy mạnh biên độ cao (2.2 -> 3.6) để trông ấn
    // tượng/rõ khối hơn, CHẤP NHẬN không còn đúng tỉ lệ độ sâu thật 1:1. Nâng biên độ làm lộ lại nhiễu
    // (y hệt lỗi "rừng gai nhọn" trước) nên làm mượt THÊM 1 lượt ngay trên lưới đã chuẩn hoá (smoothGrid)
    // trước khi nhân biên độ — tách hẳn việc khử nhiễu khỏi mức biên độ áp dụng sau đó.
    const normalizedGridRaw = new Float32Array(gridW * gridH);
    for (let i = 0; i < rawBrightness.length; i++) {
      const clipped = Math.min(1, Math.max(0, (rawBrightness[i] - lo) / range));
      normalizedGridRaw[i] = Math.pow(clipped, 0.55);
    }
    let normalizedGrid = smoothGrid(normalizedGridRaw, gridW, gridH, 2);

    // SỬA lần 3 (phản hồi thật user: "chỗ nào vách đá thì cao, chỗ nào đường mòn thì thấp") — độ sâu
    // không phân biệt được mặt đất bằng phẳng với vách đá (đường mòn gần ống kính nhất lại thành cao
    // nhất, sai). Dùng mask "mặt đất" từ SAM-3 (groundWeight 0..1) để ÉP vùng đất về gần phẳng — nhân
    // normalizedGrid với (1 - groundWeight): groundWeight càng cao (càng chắc là đất) thì độ cao càng
    // bị kéo về gần 0, vùng không phải đất (đá, cây...) giữ nguyên độ cao tính từ độ sâu như cũ.
    if (groundMaskUrl) {
      const groundWeight = await loadGroundWeightGrid(groundMaskUrl, gridW, gridH);
      if (groundWeight) {
        const blended = new Float32Array(gridW * gridH);
        for (let i = 0; i < blended.length; i++) {
          blended[i] = normalizedGrid[i] * (1 - groundWeight[i]);
        }
        normalizedGrid = blended;
      }
    }

    const positions = new Float32Array(gridW * gridH * 3);
    // Màu theo độ cao — đỉnh (worldY cao, gần) sáng gần trắng kiểu tuyết, chân núi (worldY thấp, xa)
    // xám đậm hơn — đúng dải màu trong ảnh tham khảo, không phải 1 màu xám đều như bản trước.
    const colors = new Float32Array(gridW * gridH * 3);
    const PEAK_COLOR = new THREE.Color(0xf1f5f9);
    const BASE_COLOR = new THREE.Color(0x64748b);
    for (let iy = 0; iy < gridH; iy++) {
      for (let ix = 0; ix < gridW; ix++) {
        const u = ix / (gridW - 1);
        const v = iy / (gridH - 1);
        const normalized = normalizedGrid[iy * gridW + ix];
        const worldX = (u - 0.5) * 5;
        const worldZ = -(1 - v) * 5;
        const worldY = normalized * 3.6;
        const vi = (iy * gridW + ix) * 3;
        positions[vi] = worldX;
        positions[vi + 1] = worldY;
        positions[vi + 2] = worldZ;
        const c = BASE_COLOR.clone().lerp(PEAK_COLOR, normalized);
        colors[vi] = c.r;
        colors[vi + 1] = c.g;
        colors[vi + 2] = c.b;
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
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  } catch {
    return null; // ảnh độ sâu lỗi/không tải được (CORS, 404...) — bỏ qua, khung 3D vẫn hiện mannequin bình thường
  }
}

// Sàn phẳng cho ảnh phố/kiến trúc (isNaturalTerrain=false, xem useEffect bên dưới) — SỬA (phản hồi
// thật user: "mờ", khung 3D gần như trống rỗng vì chỉ còn sàn tròn mờ mặc định opacity 0.35, khó thấy
// trên nền tối) — dựng 1 mặt lưới phẳng RÕ RÀNG, cùng kích thước footprint (5x5) và phong cách màu với
// địa hình thật (xám sáng + khung dây), chỉ khác là worldY luôn = 0 (hoàn toàn phẳng, không có độ sâu
// nào tác động) — cho khung 3D luôn có mặt sàn rõ để nhân vật đứng lên, dù không dựng được địa hình.
function buildFlatGroundGeometry(gridW = 24, gridH = 20): THREE.BufferGeometry {
  const positions = new Float32Array(gridW * gridH * 3);
  const colors = new Float32Array(gridW * gridH * 3);
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
  isNaturalTerrain = true,
  testPoints = [],
  onCharacterMove,
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
  const [, forceRerender] = useState(0);

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

    transformControls.addEventListener("dragging-changed", (event) => {
      draggingTransformRef.current = !!event.value;
    });
    transformControls.addEventListener("objectChange", () => {
      const obj = transformControls.object;
      const url = attachedCharacterUrlRef.current;
      if (!obj || !url || !onCharacterMove) return;
      // SỬA (phản hồi thật user: "kéo về trục Z thì ảnh 2D vị trí sai") — bản trước GHI ĐÈ NGƯỢC LẠI
      // obj.position ngay trong lúc đang kéo (để kẹp biên) — TransformControls tự theo dõi vị trí nội
      // bộ để tính delta cho bước kéo TIẾP THEO (dựa trên con trỏ chuột di chuyển bao nhiêu so với vị
      // trí NÓ nhớ), nếu mình chen vào đổi obj.position giữa chừng thì làm lệch hẳn phép tính nội bộ đó
      // ở bước sau — lệch rõ nhất ở trục Z vì biên hẹp hơn X (-5..0 so với -2.5..2.5) nên bị ghi đè
      // thường xuyên hơn. SỬA: không đụng vào obj.position nữa trong lúc kéo — chỉ ĐỌC (không ghi), kẹp
      // biên cho dữ liệu x,y gửi SANG 2D thôi, để nguyên vị trí 3D thật cho thư viện tự quản lý.
      const x = Math.min(1, Math.max(0, obj.position.x / 5 + 0.5));
      const y = Math.min(1, Math.max(0, 1 + obj.position.z / 5));
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

        const worldX = (ch.x - 0.5) * SPREAD_X;
        const worldZ = -(1 - ch.y) * SPREAD_Z;
        group.position.set(worldX, 0, worldZ);
        sc.add(group);
      }

      // DEBUG TẠM THỜI — tắt hẳn việc tự gắn lại gizmo sau khi dựng lại mannequin, để kiểm chứng xem
      // đây có phải nguyên nhân "vị trí 2D bị ghi đè sau khi lưu đúng" user báo hay không. Nếu tắt cái
      // này mà hết lỗi thì xác nhận đúng chỗ, sẽ sửa lại cho đúng (không chỉ xoá hẳn). Gỡ gizmo hẳn mỗi
      // khi mannequin dựng lại — khách phải bấm chọn lại nhân vật nếu muốn tiếp tục kéo.
      transformControlsRef.current?.detach();
      attachedCharacterUrlRef.current = null;

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [characters]);

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
      const worldZ = -(1 - p.y) * SPREAD_Z;

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
  }, [testPoints]);

  // Dựng lưới địa hình (heightmap) từ ảnh độ sâu — thay cho khối hộp vuông vức trước đây, cho hình
  // dạng lồi lõm giống địa hình thật (núi/vách đá nhô ra, chỗ xa lõm vào) thay vì khối chữ nhật phẳng
  // lì. Vẽ cả mặt đặc (mờ) lẫn khung dây (wireframe) đè lên — khớp đúng kiểu "low-poly wireframe" đã
  // tham khảo, dễ nhìn rõ hình khối khi xoay.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // SỬA lần 4 (phản hồi thật user: ảnh phố/kiến trúc ra hình "phễu" méo mó) — ảnh không phải cảnh
    // thiên nhiên thì KHÔNG dựng địa hình nữa, thay bằng 1 sàn phẳng RÕ RÀNG (buildFlatGroundGeometry,
    // xem lý do phía trên — sàn tròn mờ mặc định quá khó thấy, user phản hồi "mờ") cho nhân vật đứng.
    if (!depthImageUrl || !isNaturalTerrain) {
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
      return;
    }
    let cancelled = false;
    (async () => {
      const geo = await buildTerrainGeometry(depthImageUrl, groundMaskUrl);
      if (cancelled || !geo) return;
      const sc = sceneRef.current;
      if (!sc) return;
      sc.children.filter((c) => c.userData.isLocationBlock).forEach((c) => sc.remove(c));

      // Màu xám trung tính + flatShading (mỗi mặt tam giác giữ phẳng, không làm mượt) — đúng phong cách
      // "low-poly" tham khảo (núi xám nhiều mặt, không phải màu mè trong suốt như bản trước).
      const solid = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide })
      );
      solid.userData.isLocationBlock = true;
      sc.add(solid);

      const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x374151, wireframe: true }));
      wire.userData.isLocationBlock = true;
      sc.add(wire);

      const outline = buildEdgeOutline(geo.getAttribute("position").array as Float32Array, 128, 80);
      outline.userData.isLocationBlock = true;
      sc.add(outline);

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [depthImageUrl, groundMaskUrl, isNaturalTerrain]);

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
      }
      return next;
    });
  }
  function handlePointerUp() {
    dragRef.current.dragging = false;
    draggedMannequinRef.current = null;
    orbitDragRef.current.dragging = false;
  }

  return (
    <div
      className={`relative aspect-[4/3] w-full touch-none overflow-hidden rounded-lg bg-zinc-900 ${
        inspectMode || moveMode ? "cursor-move" : ""
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
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
      </div>
      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
        {moveMode
          ? "✥ Bấm nhân vật rồi kéo mũi tên để di chuyển — kéo chỗ trống để xoay góc nhìn"
          : inspectMode
            ? "🖱️ Kéo để xoay góc nhìn, lăn chuột để zoom"
            : "🔄 Kéo vào nhân vật để xoay riêng người đó"}
      </span>
    </div>
  );
}
