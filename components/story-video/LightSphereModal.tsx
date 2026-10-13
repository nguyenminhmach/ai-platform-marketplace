"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// "Thiết lập ánh sáng mới" — bảng 3D kiểu Higgsfield: quả cầu lưới quanh 1 "chủ thể" ở giữa, MỖI đèn
// (có thể nhiều đèn, xem "+ Thêm ánh sáng") là 1 chấm sáng bấm-kéo được quanh bề mặt quả cầu (toạ độ
// cầu: azimuth ngang quanh trục Y, elevation cao/thấp). Dùng chung kỹ thuật Three.js thuần
// (renderer/scene/camera dựng tay trong useEffect, kéo bằng pointer events) đã có sẵn ở
// components/MannequinPreviewCard.tsx — không thêm thư viện mới (three đã là dependency có sẵn).

export type LightSettings = {
  azimuth: number; // radian quanh trục Y — 0 = trước mặt, dương = quay phải
  elevation: number; // radian lên/xuống — 0 = ngang tầm mắt, +PI/2 = đỉnh đầu, -PI/2 = đáy
  color: string; // hex, vd "#ffffff"
  brightness: number; // 0-100
  spread: number; // 0-100
};

export const DEFAULT_LIGHT_SETTINGS: LightSettings = { azimuth: 0, elevation: 0, color: "#ffffff", brightness: 50, spread: 50 };

// Đèn mới thêm (nút "+ Thêm ánh sáng") lệch azimuth 90° mỗi đèn kế tiếp để KHÔNG chồng lên đèn trước
// đó — khách thấy ngay có thêm 1 chấm sáng mới ở vị trí khác, không cần tự kéo ra trước khi chỉnh.
function makeNewLight(existingCount: number): LightSettings {
  return { ...DEFAULT_LIGHT_SETTINGS, azimuth: (existingCount * Math.PI) / 2 };
}

// Giới hạn mềm số đèn tối đa — quá nhiều chấm sáng chồng lên nhau trên 1 quả cầu nhỏ sẽ khó bấm trúng
// đúng đèn muốn kéo.
const MAX_LIGHTS = 4;

// Bán kính quả cầu — 1.8 -> 2.2: khi zoom camera gần hơn để chủ thể to ra, người (cao cố định ~1.9)
// che gần hết vòng tròn bán kính 1.8 (user phản hồi "vòng tròn bị che") — tăng bán kính để vòng tròn
// TO RA CÙNG TỈ LỆ với người thay vì chỉ phóng to khung hình chung, đảm bảo vòng luôn thấy rõ quanh người.
const SPHERE_RADIUS = 2.2;

export const LIGHT_QUICK_POSITIONS: { key: string; label: string; azimuth: number; elevation: number }[] = [
  { key: "dung-dau", label: "Đứng đầu", azimuth: 0, elevation: Math.PI / 2 - 0.05 },
  { key: "dang-truoc", label: "Đằng trước", azimuth: 0, elevation: 0 },
  { key: "phai", label: "Phải", azimuth: Math.PI / 2, elevation: 0 },
  { key: "ben-trai", label: "Bên trái", azimuth: -Math.PI / 2, elevation: 0 },
  { key: "mat-sau", label: "Mặt sau", azimuth: Math.PI, elevation: 0 },
  { key: "day", label: "Đáy", azimuth: 0, elevation: -Math.PI / 2 + 0.05 },
];

// Góc gần nhất trong 6 hướng "Chọn nhanh" — dùng để (1) tô sáng đúng nút khi kéo tay tới gần 1 hướng,
// (2) viết guidance text mô tả hướng sáng bằng tiếng Việt lúc submit (xem app/video-tu-y-tuong/page.tsx).
export function nearestLightQuickPosition(azimuth: number, elevation: number): (typeof LIGHT_QUICK_POSITIONS)[number] {
  let best = LIGHT_QUICK_POSITIONS[0];
  let bestDist = Infinity;
  for (const p of LIGHT_QUICK_POSITIONS) {
    let da = (azimuth - p.azimuth) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da <= -Math.PI) da += Math.PI * 2;
    const de = elevation - p.elevation;
    const dist = da * da + de * de;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

function sphericalToPosition(azimuth: number, elevation: number, radius: number): THREE.Vector3 {
  const y = radius * Math.sin(elevation);
  const r = radius * Math.cos(elevation);
  const x = r * Math.sin(azimuth);
  const z = r * Math.cos(azimuth);
  return new THREE.Vector3(x, y, z);
}

// Vòng ĐỨNG — CỐ ĐỊNH (không theo elevation/azimuth của đèn), nhưng giờ là 1 "billboard" LUÔN XOAY
// MẶT VỀ PHÍA CAMERA (cập nhật quaternion mỗi lần camera đổi vị trí do orbit) thay vì nằm cố định ở
// mặt phẳng YZ. Lý do đổi: đo bằng toán học phát hiện vòng cũ (phẳng, cố định YZ) bị chiếu méo tỉ lệ
// cao/rộng tới 2.45:1 ở góc camera mặc định — vì 1 đường tròn PHẲNG nằm đúng mặt phẳng đối xứng người
// thì góc nhìn càng gần chính diện (để thấy mặt người) càng bị dẹt theo toán chiếu phối cảnh, không
// có azimuth nào vừa cho người chính diện vừa cho vòng tròn đều — đây là giới hạn hình học, không sửa
// được bằng cách đổi FOV/khoảng cách. Billboard (luôn vuông góc với tia nhìn) thì LUÔN là hình tròn
// hoàn hảo trên màn hình bất kể camera ở góc nào, giống hệt viền 1 quả cầu thật nhìn từ bất kỳ đâu.
// Hình học tạo ở mặt phẳng XY cục bộ (chưa facing), áp dụng quaternion facing camera ở nơi gọi.
function createFixedVerticalRing(radius: number, color: number): THREE.LineLoop {
  const segments = 64;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(radius * Math.cos(t), radius * Math.sin(t), 0));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
}

// Vòng NGANG — đây mới là vòng THỰC SỰ CHUYỂN ĐỘNG: trượt lên/xuống dọc vòng đứng cố định theo đúng
// elevation của ĐÈN ĐANG CHỌN (activeIndex) hiện tại (thu nhỏ bán kính dần khi tới gần 2 cực, như 1
// vòng vĩ tuyến trên địa cầu) — đèn đang chọn nằm TRÊN vòng này. Đúng cơ chế: "đèn gắn trên vòng ngang,
// vòng ngang trượt trên vòng đứng" — KHÔNG phải vòng ngang cố định.
function horizontalRingPoints(radius: number, elevation: number): THREE.Vector3[] {
  const segments = 64;
  const y = radius * Math.sin(elevation);
  const r = radius * Math.cos(elevation);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(r * Math.sin(t), y, r * Math.cos(t)));
  }
  return points;
}
function createSlidingHorizontalRing(radius: number, elevation: number, color: number): THREE.LineLoop {
  const geometry = new THREE.BufferGeometry().setFromPoints(horizontalRingPoints(radius, elevation));
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
}
function updateSlidingHorizontalRing(ring: THREE.LineLoop, radius: number, elevation: number) {
  ring.geometry.dispose();
  ring.geometry = new THREE.BufferGeometry().setFromPoints(horizontalRingPoints(radius, elevation));
}

// "Luồng sáng" nhìn thấy được từ đèn chiếu vào vật thể — hình nón mờ, đỉnh nhọn tại vị trí đèn, loe
// rộng dần về phía chủ thể (độ loe theo "Lan toả"), dùng additive blending để trông như ánh sáng thật
// thay vì 1 khối đặc. Tách biệt với simLight (đèn Three.js thật làm sáng/tối bề mặt chủ thể) — cone
// này CHỈ để mắt thường thấy "có luồng sáng đi từ đèn vào không gian", không ảnh hưởng tới shading.
function createBeamCone(apex: THREE.Vector3, target: THREE.Vector3, baseRadius: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(target, apex);
  const length = Math.max(dir.length(), 0.001);
  const geometry = new THREE.ConeGeometry(baseRadius, length, 24, 1, true);
  geometry.translate(0, -length / 2, 0); // đỉnh nón về gốc cục bộ (0,0,0), đáy loe ở (0,-length,0)
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.018,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  mesh.position.copy(apex);
  return mesh;
}
function updateBeamCone(mesh: THREE.Mesh, apex: THREE.Vector3, target: THREE.Vector3, baseRadius: number, color: THREE.ColorRepresentation) {
  const dir = new THREE.Vector3().subVectors(target, apex);
  const length = Math.max(dir.length(), 0.001);
  mesh.geometry.dispose();
  const geometry = new THREE.ConeGeometry(baseRadius, length, 24, 1, true);
  geometry.translate(0, -length / 2, 0);
  mesh.geometry = geometry;
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  mesh.position.copy(apex);
  (mesh.material as THREE.MeshBasicMaterial).color.set(color);
}

// 1 bộ object Three.js đại diện cho 1 ĐÈN: chấm sáng + quầng sáng (bấm-kéo được), đèn mô phỏng thật
// (SpotLight làm sáng/tối chủ thể) + điểm nhắm của nó, và cone luồng sáng nhìn thấy được.
type LightObjects = {
  dot: THREE.Mesh;
  halo: THREE.Mesh;
  simLight: THREE.SpotLight;
  subjectTarget: THREE.Object3D;
  beamCone: THREE.Mesh;
};

function createLightObjects(ls: LightSettings): LightObjects {
  const pos = sphericalToPosition(ls.azimuth, ls.elevation, SPHERE_RADIUS);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshBasicMaterial({ color: ls.color }));
  dot.position.copy(pos);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), new THREE.MeshBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.35 }));
  halo.position.copy(pos);
  const subjectTarget = new THREE.Object3D();
  subjectTarget.position.set(0, 0, 0);
  const simLight = new THREE.SpotLight(ls.color, (ls.brightness / 100) * 6, 12, THREE.MathUtils.degToRad(12 + (ls.spread / 100) * 45), 0.5, 1);
  simLight.position.copy(pos);
  simLight.target = subjectTarget;
  const beamRadius = 0.25 + (ls.spread / 100) * 0.9;
  const beamCone = createBeamCone(pos, new THREE.Vector3(0, 0, 0), beamRadius, ls.color);
  return { dot, halo, simLight, subjectTarget, beamCone };
}
function addLightObjectsToScene(scene: THREE.Scene, lo: LightObjects) {
  scene.add(lo.dot, lo.halo, lo.simLight, lo.subjectTarget, lo.beamCone);
}
function removeLightObjectsFromScene(scene: THREE.Scene, lo: LightObjects) {
  scene.remove(lo.dot, lo.halo, lo.simLight, lo.subjectTarget, lo.beamCone);
  lo.dot.geometry.dispose();
  (lo.dot.material as THREE.Material).dispose();
  lo.halo.geometry.dispose();
  (lo.halo.material as THREE.Material).dispose();
  lo.beamCone.geometry.dispose();
  (lo.beamCone.material as THREE.Material).dispose();
}
function updateLightObjects(lo: LightObjects, ls: LightSettings, isActive: boolean) {
  const pos = sphericalToPosition(ls.azimuth, ls.elevation, SPHERE_RADIUS);
  lo.dot.position.copy(pos);
  lo.halo.position.copy(pos);
  (lo.dot.material as THREE.MeshBasicMaterial).color.set(ls.color);
  // Đèn đang được chọn (hiện bảng Màu sắc/Độ sáng/Lan toả bên trái) có quầng sáng rõ hơn hẳn các đèn
  // còn lại, giúp khách luôn biết đang chỉnh đèn nào giữa nhiều đèn.
  (lo.halo.material as THREE.MeshBasicMaterial).opacity = isActive ? 0.45 : 0.18;
  lo.dot.scale.setScalar(isActive ? 1 : 0.8);
  lo.simLight.position.copy(pos);
  lo.simLight.color.set(ls.color);
  lo.simLight.intensity = (ls.brightness / 100) * 6;
  lo.simLight.angle = THREE.MathUtils.degToRad(12 + (ls.spread / 100) * 45);
  const beamRadius = 0.25 + (ls.spread / 100) * 0.9;
  updateBeamCone(lo.beamCone, pos, new THREE.Vector3(0, 0, 0), beamRadius, ls.color);
}

function LightSphereCanvas({
  lights,
  activeIndex,
  onChangeLight,
  onActiveChange,
}: {
  lights: LightSettings[];
  activeIndex: number;
  onChangeLight: (index: number, next: LightSettings) => void;
  onActiveChange: (index: number) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const lightObjectsRef = useRef<LightObjects[]>([]);
  const horizontalRingRef = useRef<THREE.LineLoop | null>(null);
  const verticalRingRef = useRef<THREE.LineLoop | null>(null);
  const subjectRef = useRef<THREE.Group | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const lightsRef = useRef(lights);
  lightsRef.current = lights;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  // 3 thao tác kéo HOÀN TOÀN ĐỘC LẬP với nhau — bấm trúng đâu quyết định thao tác nào, không cái nào
  // ảnh hưởng tới cái kia: "light" = kéo di chuyển ĐÚNG đèn bấm trúng (có thể không phải đèn đang active
  // — bấm trúng đèn nào thì đèn đó tự động thành active, xem handlePointerDown); "subject" = kéo TRÚNG
  // chủ thể để xoay riêng chủ thể tại chỗ (chỉ subject.rotation.y, không đụng gì tới đèn/camera);
  // "orbit" = kéo chỗ TRỐNG (không trúng đèn nào, không trúng chủ thể) để xoay góc nhìn camera quanh cả
  // cụm, khớp yêu cầu "vòng tròn đứng cũng xoay được" mà không đụng tới chủ thể hay đèn.
  const dragRef = useRef<{
    mode: "light" | "subject" | "orbit" | null;
    lightIndex: number;
    startX: number;
    startY: number;
    startAz: number;
    startEl: number;
    startOrbitAz: number;
    startSubjectRotY: number;
  }>({ mode: null, lightIndex: -1, startX: 0, startY: 0, startAz: 0, startEl: 0, startOrbitAz: 0, startSubjectRotY: 0 });
  // Toạ độ cầu của CAMERA (khác hẳn toạ độ cầu của đèn) — distance giảm (8.13 -> 6.0) để ZOOM GẦN hơn.
  // elevation đổi 0.198 -> 0 (camera NGANG TẦM, cùng độ cao với tâm quả cầu): đã verify bằng toán học
  // (chiếu 2 cực Bắc/Nam của vòng đứng lên màn hình) rằng trục cực LUÔN thẳng đứng tuyệt đối trên màn
  // hình bất kể elevation (do camera.up=(0,1,0), không roll) — nhưng khi elevation≠0, hình ELIP TRÔNG
  // CÓ VẺ xéo/nghiêng (ảo giác thị giác khi nhìn 1 vòng tròn từ góc trên/dưới chéo xuống). elevation=0
  // loại bỏ hẳn ảo giác này — ellipse hiện đối xứng dọc hoàn toàn, vẫn giữ azimuth lệch để tránh vòng
  // đứng nhìn dẹt thành 1 đường thẳng (edge-on) khi camera đúng x=0.
  const orbitRef = useRef({ azimuth: 0.4127, elevation: 0, distance: 14.5 });

  function updateCameraFromOrbit() {
    const camera = cameraRef.current;
    if (!camera) return;
    const { azimuth, elevation, distance } = orbitRef.current;
    const y = distance * Math.sin(elevation);
    const r = distance * Math.cos(elevation);
    camera.position.set(r * Math.sin(azimuth), y, r * Math.cos(azimuth));
    // Nhắm camera vào điểm HƠI THẤP HƠN tâm thật (0,-0.9,0 thay vì 0,0,0) — đẩy cả vòng tròn + người lên
    // cao hơn trong khung hình theo phản hồi, tránh vòng tròn sát mép dưới.
    camera.lookAt(0, -0.9, 0);
    // Vòng đứng billboard phải xoay mặt theo camera MỖI LẦN camera đổi vị trí (orbit), nếu không nó vẫn
    // giữ hướng facing cũ và lại bị méo như vòng phẳng cố định trước đây.
    if (verticalRingRef.current) verticalRingRef.current.quaternion.copy(camera.quaternion);
  }

  function render() {
    if (sceneRef.current && cameraRef.current && rendererRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    // Ánh sáng nền (0.15 -> 0.06 -> 0.025 -> 0.18 -> 0.32) — user phản hồi người quá tối, tăng lại để
    // chủ thể dễ nhìn hơn, vẫn để simLight của từng đèn làm nổi bật hướng sáng chính.
    scene.add(new THREE.AmbientLight(0xffffff, 0.32));
    // Ánh sáng BÁN CẦU (trên sáng hơn dưới) — KHÁC ambient (ambient chiếu đều mọi mặt như nhau, làm
    // khối bẹt phẳng mất góc cạnh). Hemisphere tạo gradient sáng theo hướng pháp tuyến từng mặt (mặt
    // hướng lên sáng hơn mặt hướng xuống/ngang), giúp nhận biết rõ góc cạnh khối kể cả khi simLight
    // không chiếu trực tiếp vào — đúng hiệu ứng "3 mặt sáng-tối khác nhau" ở ảnh tham khảo.
    scene.add(new THREE.HemisphereLight(0xcbd5e1, 0x27272a, 1.15));

    const radius = SPHERE_RADIUS;
    // Vòng đứng — billboard LUÔN quay mặt về camera (xem ghi chú ở createFixedVerticalRing), facing
    // ban đầu được set ngay sau khi camera khởi tạo xong (gọi updateCameraFromOrbit() bên dưới).
    const verticalRing = createFixedVerticalRing(radius, 0x71717a);
    scene.add(verticalRing);
    verticalRingRef.current = verticalRing;

    // Vòng ngang TRƯỢT dọc vòng đứng theo elevation của đèn đang active lúc khởi tạo — đèn active nằm
    // trên vòng này. Đúng cơ chế: "đèn gắn trên vòng ngang, vòng ngang trượt trên vòng đứng".
    const initialActiveLight = lightsRef.current[activeIndexRef.current] ?? DEFAULT_LIGHT_SETTINGS;
    const horizontalRing = createSlidingHorizontalRing(radius, initialActiveLight.elevation, 0x71717a);
    scene.add(horizontalRing);
    horizontalRingRef.current = horizontalRing;

    // Chủ thể giờ là HÌNH NGƯỜI THẬT — model 3D low-poly (public/models/man.glb, "Man" by Quaternius,
    // CC0/Public Domain, tải từ poly.pizza) thay vì mannequin khối nguyên thuỷ (quá thô, user phản hồi
    // "hình này thô quá"). subject là 1 Group RỖNG tạo sẵn ngay (để raycast/drag không bị null trong
    // lúc chờ tải), model glTF được thêm vào làm con của nó SAU KHI tải xong (bất đồng bộ).
    const subject = new THREE.Group();
    scene.add(subject);
    subjectRef.current = subject;

    const gltfLoader = new GLTFLoader();
    let disposed = false;
    gltfLoader.load(
      "/models/man.glb",
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        // Chỉ dùng bounding box để lấy CHIỀU CAO (size.y) tính tỉ lệ scale — không dùng center.x/z của
        // box để định tâm ngang. Lý do: đo thực tế model này size=[1.43, 4.83, 0.82], center=[0.002,
        // 2.41, 0.084] — center.x gần 0 (đúng) nhưng center.z lệch hẳn 0.084 (≈10% độ sâu) vì tư thế
        // đứng tự nhiên không đối xứng hoàn toàn trước/sau (vai/chân hơi lệch) — nếu định tâm theo
        // center.z của BOX sẽ kéo cả người lệch khỏi trục thật, đúng như ảnh chụp user gửi (đường thẳng
        // nối đỉnh-đáy vòng tròn KHÔNG đi qua người). Gốc toạ độ GỐC của model (x=0,z=0) mới là trục cột
        // sống/điểm đứng thật do người tạo model đặt sẵn (min.y≈0 xác nhận gốc nằm đúng ở chân/mặt đất —
        // quy ước chuẩn của model nhân vật có rig), nên giữ nguyên x=0,z=0, chỉ dịch theo Y để canh giữa.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const targetHeight = 1.9;
        const scale = size.y > 0 ? targetHeight / size.y : 1;
        model.scale.setScalar(scale);
        model.position.set(0, -targetHeight / 2, 0);
        // Model đứng thẳng mặt hướng +Z như mannequin/khối hộp cũ, không cần xoay thêm (Quaternius rig
        // export sẵn đúng hướng này).
        subject.add(model);
        render();
      },
      undefined,
      (err) => console.error("Lỗi tải model chủ thể (man.glb):", err)
    );

    // Tạo object Three.js cho TỪNG đèn trong danh sách lights (thường chỉ có 1 lúc khởi tạo, nhưng
    // modal có thể mở lại với nhiều đèn đã lưu từ trước).
    lightObjectsRef.current = lightsRef.current.map((ls) => {
      const lo = createLightObjects(ls);
      addLightObjectsToScene(scene, lo);
      return lo;
    });

    // FOV hẹp hơn (50 -> 25, kiểu ống kính tele) + camera lùi xa hơn tương ứng (orbitRef.distance tăng
    // theo) — user phát hiện vòng tròn bị kéo dài/méo dọc so với ảnh tham khảo (tròn đều). Nguyên nhân:
    // FOV 50° quá rộng kết hợp camera gần (distance=5.4, bán kính=2.2, tỉ lệ ~0.41) gây méo phối cảnh
    // mạnh (như ảnh mắt cá nhẹ), KHÔNG phải do lệch trục hay sai tỉ lệ khung canvas (đã thử vuông canvas
    // vẫn không hết méo). Ống kính tele (FOV hẹp + xa) giảm hẳn méo phối cảnh, vòng tròn tròn đều hơn,
    // trong khi vẫn giữ đúng cỡ người trên màn hình nhờ tăng distance bù lại (xem orbitRef bên dưới).
    // QUAN TRỌNG: camera không được đặt đúng x=0 — trùng mặt phẳng vòng đứng cố định (YZ plane) — nên
    // nhìn vòng đứng bị dẹt thành 1 đường thẳng (edge-on); giữ azimuth lệch để nhìn chéo thấy rõ cả 2 vòng.
    const camera = new THREE.PerspectiveCamera(25, 1, 0.1, 100);
    cameraRef.current = camera;
    updateCameraFromOrbit(); // đặt đúng vị trí ban đầu từ orbitRef (tương đương 3.2, 1.6, 7.3 cũ)
    sceneRef.current = scene;

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

    return () => {
      disposed = true;
      ro.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Đồng bộ TOÀN BỘ danh sách đèn mỗi khi `lights` hoặc `activeIndex` đổi (bấm "Chọn nhanh", kéo thanh
  // Độ sáng/Lan toả, đổi màu, thêm/xoá đèn, chuyển tab đèn...): tạo thêm/xoá bớt object Three.js cho
  // khớp số lượng đèn, rồi cập nhật vị trí/màu/độ sáng từng đèn + vòng ngang (luôn bám theo đèn active).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !cameraRef.current || !rendererRef.current) return;

    while (lightObjectsRef.current.length < lights.length) {
      const ls = lights[lightObjectsRef.current.length];
      const lo = createLightObjects(ls);
      addLightObjectsToScene(scene, lo);
      lightObjectsRef.current.push(lo);
    }
    while (lightObjectsRef.current.length > lights.length) {
      const lo = lightObjectsRef.current.pop();
      if (lo) removeLightObjectsFromScene(scene, lo);
    }

    lights.forEach((ls, i) => {
      const lo = lightObjectsRef.current[i];
      if (lo) updateLightObjects(lo, ls, i === activeIndex);
    });

    const activeLight = lights[activeIndex];
    if (horizontalRingRef.current && activeLight) {
      updateSlidingHorizontalRing(horizontalRingRef.current, SPHERE_RADIUS, activeLight.elevation);
    }

    render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lights, activeIndex]);

  // Bấm trúng 1 đèn bất kỳ -> đèn đó tự động thành active + kéo di chuyển đúng đèn đó; bấm trúng chủ
  // thể -> kéo xoay RIÊNG chủ thể; bấm chỗ trống khác -> kéo xoay góc nhìn camera quanh cả cụm. 3 thao
  // tác độc lập hoàn toàn, không cái nào đụng tới cái kia (xem ghi chú dragRef phía trên).
  function handlePointerDown(e: React.PointerEvent) {
    const mount = mountRef.current;
    if (!mount || !cameraRef.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    const rect = mount.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycasterRef.current.setFromCamera(ndc, cameraRef.current);
    // Raycast vào TẤT CẢ chấm đèn + quầng sáng của mọi đèn (ưu tiên cao nhất — bán kính lớn hơn, dễ bấm
    // trúng hơn vòng lõi nhỏ), tìm xem bấm trúng đèn nào qua đối chiếu object -> index.
    const lightTargets: THREE.Mesh[] = [];
    lightObjectsRef.current.forEach((lo) => lightTargets.push(lo.dot, lo.halo));
    const lightHits = raycasterRef.current.intersectObjects(lightTargets, false);
    const hitsLight = lightHits.length > 0;
    let hitLightIndex = -1;
    if (hitsLight) {
      const hitObj = lightHits[0].object;
      hitLightIndex = lightObjectsRef.current.findIndex((lo) => lo.dot === hitObj || lo.halo === hitObj);
    }
    // true (đệ quy) — subject giờ là Group (nhiều mesh con: đầu/thân/tay/chân), không phải 1 Mesh đơn.
    const hitsSubject = !hitsLight && subjectRef.current ? raycasterRef.current.intersectObject(subjectRef.current, true).length > 0 : false;

    if (hitsLight && hitLightIndex >= 0 && hitLightIndex !== activeIndexRef.current) {
      onActiveChange(hitLightIndex);
    }
    const draggedLight = hitsLight && hitLightIndex >= 0 ? lightsRef.current[hitLightIndex] : null;

    dragRef.current = {
      mode: hitsLight ? "light" : hitsSubject ? "subject" : "orbit",
      lightIndex: hitLightIndex,
      startX: e.clientX,
      startY: e.clientY,
      startAz: draggedLight?.azimuth ?? 0,
      startEl: draggedLight?.elevation ?? 0,
      startOrbitAz: orbitRef.current.azimuth,
      startSubjectRotY: subjectRef.current?.rotation.y ?? 0,
    };
  }
  function handlePointerMove(e: React.PointerEvent) {
    const mode = dragRef.current.mode;
    if (!mode) return;
    const dx = e.clientX - dragRef.current.startX;

    if (mode === "orbit") {
      // CHỈ xoay quanh 1 trục đứng (azimuth, theo dx ngang) — không nghiêng lên/xuống, khớp đúng yêu
      // cầu "chỉ quay quanh 1 trục đứng thôi". Hoàn toàn không đụng tới chủ thể hay đèn.
      orbitRef.current.azimuth = dragRef.current.startOrbitAz + dx * 0.012;
      updateCameraFromOrbit();
      render();
      return;
    }

    if (mode === "subject") {
      // Xoay RIÊNG chủ thể tại chỗ (subject.rotation.y) — không đụng tới đèn (azimuth/elevation của
      // đèn giữ nguyên) hay camera (orbitRef giữ nguyên), độc lập hoàn toàn với 2 thao tác kia.
      if (subjectRef.current) {
        subjectRef.current.rotation.y = dragRef.current.startSubjectRotY + dx * 0.012;
        render();
      }
      return;
    }

    // mode === "light" — kéo ĐÚNG đèn đã bấm trúng ở pointerDown (dragRef.current.lightIndex).
    const { lightIndex } = dragRef.current;
    if (lightIndex < 0) return;
    const dy = e.clientY - dragRef.current.startY;
    const nextAz = dragRef.current.startAz + dx * 0.012;
    const elevLimit = Math.PI / 2 - 0.05;
    const nextEl = Math.max(-elevLimit, Math.min(elevLimit, dragRef.current.startEl - dy * 0.012));
    const current = lightsRef.current[lightIndex];
    if (!current) return;
    const next: LightSettings = { ...current, azimuth: nextAz, elevation: nextEl };
    const lo = lightObjectsRef.current[lightIndex];
    if (lo) {
      updateLightObjects(lo, next, lightIndex === activeIndexRef.current);
      if (horizontalRingRef.current && lightIndex === activeIndexRef.current) {
        updateSlidingHorizontalRing(horizontalRingRef.current, SPHERE_RADIUS, nextEl);
      }
      render();
    }
    onChangeLight(lightIndex, next);
  }
  function handlePointerUp() {
    dragRef.current.mode = null;
  }

  return (
    <div
      ref={mountRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
    />
  );
}

export function LightSphereModal({
  initial,
  onClose,
  onApply,
}: {
  initial: LightSettings[] | null;
  onClose: () => void;
  onApply: (settings: LightSettings[]) => void;
}) {
  const [lights, setLights] = useState<LightSettings[]>(initial && initial.length > 0 ? initial : [DEFAULT_LIGHT_SETTINGS]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeLight = lights[activeIndex] ?? lights[0];
  const nearest = nearestLightQuickPosition(activeLight.azimuth, activeLight.elevation);

  function updateActiveLight(patch: Partial<LightSettings>) {
    setLights((prev) => prev.map((l, i) => (i === activeIndex ? { ...l, ...patch } : l)));
  }
  function addLight() {
    if (lights.length >= MAX_LIGHTS) return;
    setLights((prev) => [...prev, makeNewLight(prev.length)]);
    setActiveIndex(lights.length); // trỏ sang đèn vừa thêm
  }
  function removeLight(index: number) {
    if (lights.length <= 1) return; // luôn giữ ít nhất 1 đèn
    setLights((prev) => prev.filter((_, i) => i !== index));
    setActiveIndex((prevActive) => {
      if (index < prevActive) return prevActive - 1;
      if (index === prevActive) return Math.max(0, index - 1);
      return prevActive;
    });
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h3 className="text-base font-semibold">Thiết lập ánh sáng mới</h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setLights([DEFAULT_LIGHT_SETTINGS]);
                setActiveIndex(0);
              }}
              className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
            >
              Đặt lại tất cả
            </button>
            <button onClick={onClose} className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
              ✕
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          {lights.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIndex(i)}
              className={`group flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
                i === activeIndex ? "bg-zinc-100 text-zinc-900" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              Đèn {i + 1}
              {lights.length > 1 && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeLight(i);
                  }}
                  className={`rounded-full px-1 text-[10px] ${i === activeIndex ? "text-zinc-500 hover:text-zinc-900" : "text-zinc-600 hover:text-zinc-200"}`}
                  title="Xoá đèn này"
                >
                  ✕
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={addLight}
            disabled={lights.length >= MAX_LIGHTS}
            title={lights.length >= MAX_LIGHTS ? `Tối đa ${MAX_LIGHTS} đèn` : undefined}
            className="flex items-center gap-1 px-2 text-xs text-zinc-400 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:text-zinc-700"
          >
            + Thêm ánh sáng
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-[200px_1fr_180px]">
          <div className="space-y-3">
            <p className="text-xs font-medium text-zinc-500">Đèn {activeIndex + 1}</p>
            <label className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="text-zinc-500">Màu sắc</span>
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeLight.color}
                  onChange={(e) => updateActiveLight({ color: e.target.value })}
                  className="h-5 w-5 cursor-pointer rounded-full border-0 bg-transparent p-0"
                />
                <span className="font-mono text-zinc-300">{activeLight.color.toUpperCase()}</span>
              </span>
            </label>
            <label className="block rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="mb-1 flex items-center justify-between text-zinc-500">
                Độ sáng <span className="text-zinc-300">{activeLight.brightness}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={activeLight.brightness}
                onChange={(e) => updateActiveLight({ brightness: Number(e.target.value) })}
                className="w-full accent-lime-400"
              />
            </label>
            <label className="block rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="mb-1 flex items-center justify-between text-zinc-500">
                Lan toả <span className="text-zinc-300">{activeLight.spread}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={activeLight.spread}
                onChange={(e) => updateActiveLight({ spread: Number(e.target.value) })}
                className="w-full accent-lime-400"
              />
            </label>
          </div>

          <div
            className="aspect-square min-h-[380px] w-full min-w-0 max-w-full rounded-xl"
            style={{ background: "radial-gradient(circle at 50% 50%, #3f3f46 0%, #27272a 55%, #18181b 100%)" }}
          >
            <LightSphereCanvas
              lights={lights}
              activeIndex={activeIndex}
              onChangeLight={(index, next) => setLights((prev) => prev.map((l, i) => (i === index ? next : l)))}
              onActiveChange={setActiveIndex}
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">Chọn nhanh</p>
            <div className="grid grid-cols-2 gap-2">
              {LIGHT_QUICK_POSITIONS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => updateActiveLight({ azimuth: p.azimuth, elevation: p.elevation })}
                  className={`rounded-full px-3 py-2 text-xs font-medium ${
                    nearest.key === p.key ? "border-2 border-white bg-zinc-900 text-white" : "border-2 border-transparent bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 border-t border-zinc-800 px-5 py-4">
          <button
            type="button"
            onClick={() => {
              onApply(lights);
              onClose();
            }}
            className="rounded-full bg-lime-400 px-6 py-2 text-sm font-semibold text-zinc-900 hover:bg-lime-300"
          >
            Áp dụng
          </button>
          <button
            type="button"
            disabled
            title="Sắp ra mắt"
            className="rounded-full bg-zinc-900 px-6 py-2 text-sm font-medium text-zinc-600"
          >
            Lưu dưới dạng cài đặt sẵn
          </button>
        </div>
      </div>
    </div>
  );
}
