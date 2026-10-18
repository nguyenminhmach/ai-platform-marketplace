"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildMannequin } from "@/lib/mannequin-preview";

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

// SỬA (phản hồi thật user — chỉ muốn nâng lưới địa hình mịn hơn, KHÔNG làm nhân vật photorealistic
// như ảnh tham khảo thứ 2, việc đó thuộc bước tạo ảnh AI thật, không phải khung xem trước 3D này):
// tăng mật độ lưới (36x22 -> 64x40 -> 128x80) để mặt tam giác nhỏ/mịn hơn, giống đúng kiểu ảnh tham
// khảo đầu — LƯỚI VẪN LÀ 1 TẤM TAM GIÁC LIÊN KẾT (BufferGeometry + indices bên dưới), KHÔNG PHẢI từng
// khối hộp rời rạc kiểu Minecraft (dù user có tham khảo lời khuyên nói vậy) — bump 128x80 chỉ để mịn
// hơn nữa, không đổi cách dựng khối.
async function buildTerrainGeometry(depthUrl: string, gridW = 128, gridH = 80): Promise<THREE.BufferGeometry | null> {
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
        const clipped = Math.min(1, Math.max(0, (rawBrightness[iy * gridW + ix] - lo) / range));
        // SỬA (phản hồi thật user: vẫn thấy phẳng dù đã gồ ghề) — nâng mũ gamma (0.6 -> 0.55) và nâng
        // biên độ cao (1.8 -> 2.2, so với bề ngang lưới 5 đơn vị) để tỉ lệ cao:rộng gần với ảnh núi
        // low-poly tham khảo hơn — đây là khung xem trước vị trí, không cần đúng tỉ lệ độ sâu thật 1:1,
        // ưu tiên NHÌN RÕ hình khối lồi lõm hơn độ chính xác tuyệt đối.
        const normalized = Math.pow(clipped, 0.55);
        const worldX = (u - 0.5) * 5;
        const worldZ = -(1 - v) * 5;
        const worldY = normalized * 2.2;
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

// Xem trước 3D NHIỀU nhân vật cùng lúc, đặt đúng vị trí tương đối đã chọn trên ảnh bối cảnh 2D — mở
// rộng từ components/MannequinPreviewCard.tsx (vốn chỉ có 1 mannequin xoay tại chỗ). Khác biệt chính:
// (1) nhiều mannequin, mỗi cái nhân bản từ CÙNG 1 hình buildMannequin() (xem mục 18.3 kế hoạch đã lưu
// memory — không cần tạo model mới cho từng người), đặt vào world-position tính từ x/y; (2) địa hình
// (dựng từ Fal depth, xem buildTerrainGeometry) LUÔN ĐỨNG YÊN — camera cố định, không orbit cả cảnh
// nữa (bản trước làm vậy, user phản hồi không đúng ý: "đừng cho mô hình phong cảnh quay") — khách chỉ
// bấm-kéo TRÚNG 1 mannequin mới xoay riêng người đó tại chỗ (raycasting, xem pickMannequinAt), giống
// đúng cách mannequin đơn cũ hoạt động, áp dụng cho từng người khi có nhiều người.
export function LocationPositionStage3D({ characters, depthImageUrl }: Props) {
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

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
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
    function updateCamera() {
      const radius = 7;
      const az = azimuthRef.current;
      camera.position.set(Math.sin(az) * radius, 6.5, Math.cos(az) * radius);
      camera.lookAt(0, 0.3, -2.2);
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
    const old = scene.children.filter((c) => c.userData.isCharacterMannequin);
    old.forEach((c) => scene.remove(c));

    const SPREAD_X = 5;
    const SPREAD_Z = 5;
    for (const ch of characters) {
      const mannequin = buildMannequin();
      mannequin.userData.isCharacterMannequin = true;
      const worldX = (ch.x - 0.5) * SPREAD_X;
      const worldZ = -(1 - ch.y) * SPREAD_Z;
      mannequin.position.set(worldX, 0, worldZ);
      mannequin.scale.setScalar(0.42); // thu nhỏ để vừa khung + chừa chỗ nhiều người đứng cạnh nhau
      mannequin.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial && obj.material.color.getHex() === 0x9ca3af) {
          const mat = obj.material.clone();
          mat.color.set(ch.color);
          obj.material = mat;
        }
      });
      scene.add(mannequin);
    }
    forceRerender((n) => n + 1);
  }, [characters]);

  // Dựng lưới địa hình (heightmap) từ ảnh độ sâu — thay cho khối hộp vuông vức trước đây, cho hình
  // dạng lồi lõm giống địa hình thật (núi/vách đá nhô ra, chỗ xa lõm vào) thay vì khối chữ nhật phẳng
  // lì. Vẽ cả mặt đặc (mờ) lẫn khung dây (wireframe) đè lên — khớp đúng kiểu "low-poly wireframe" đã
  // tham khảo, dễ nhìn rõ hình khối khi xoay.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !depthImageUrl) return;
    let cancelled = false;
    (async () => {
      const geo = await buildTerrainGeometry(depthImageUrl);
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

      forceRerender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [depthImageUrl]);

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
    const hit = pickMannequinAt(e.clientX, e.clientY);
    if (!hit) return; // bấm trúng địa hình/khoảng trống -> không xoay gì cả
    (e.target as Element).setPointerCapture(e.pointerId);
    draggedMannequinRef.current = hit;
    dragRef.current = { dragging: true, startX: e.clientX, startRotationY: hit.rotation.y };
  }
  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current.dragging || !draggedMannequinRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    draggedMannequinRef.current.rotation.y = dragRef.current.startRotationY + dx * 0.012;
  }
  function handlePointerUp() {
    dragRef.current.dragging = false;
    draggedMannequinRef.current = null;
  }

  return (
    <div
      className="relative aspect-video w-full touch-none overflow-hidden rounded-lg bg-zinc-900"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
        🔄 Kéo vào nhân vật để xoay riêng người đó
      </span>
    </div>
  );
}
