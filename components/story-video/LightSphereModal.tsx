"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// "Thiết lập ánh sáng mới" — bảng 3D kiểu Higgsfield: quả cầu lưới quanh 1 "chủ thể" ở giữa, đèn là
// 1 chấm sáng bấm-kéo được quanh bề mặt quả cầu (toạ độ cầu: azimuth ngang quanh trục Y, elevation
// cao/thấp). Dùng chung kỹ thuật Three.js thuần (renderer/scene/camera dựng tay trong useEffect, kéo
// bằng pointer events) đã có sẵn ở components/MannequinPreviewCard.tsx — không thêm thư viện mới
// (three đã là dependency có sẵn). Chỉ làm 1 đèn (bỏ "+ Thêm ánh sáng" nhiều đèn và "Lưu dưới dạng cài
// đặt sẵn" lưu DB riêng — 2 việc đó để đợt sau nếu cần).

export type LightSettings = {
  azimuth: number; // radian quanh trục Y — 0 = trước mặt, dương = quay phải
  elevation: number; // radian lên/xuống — 0 = ngang tầm mắt, +PI/2 = đỉnh đầu, -PI/2 = đáy
  color: string; // hex, vd "#ffffff"
  brightness: number; // 0-100
  spread: number; // 0-100
};

export const DEFAULT_LIGHT_SETTINGS: LightSettings = { azimuth: 0, elevation: 0, color: "#ffffff", brightness: 50, spread: 50 };

// Bán kính quả cầu — xem video tham khảo (D:\ánh sáng.mp4): quả cầu Higgsfield NHỎ HƠN NHIỀU so với
// chủ thể (đèn luôn ở gần sát chủ thể khi kéo), khác hẳn bản trước của mình (bán kính 2.5 quá lớn so
// với chủ thể cỡ ~1.3x1.9, khiến đèn luôn ở xa). Giảm xuống còn 1.8 để tỉ lệ khớp hơn.
const SPHERE_RADIUS = 1.8;

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

// Vòng ĐỨNG — CỐ ĐỊNH, không bao giờ xoay/đổi — chỉ là "đường ray" tham chiếu cho trục lên/xuống,
// luôn nằm ở mặt phẳng YZ (qua 2 cực + mặt trước/sau), bán kính đầy đủ.
function createFixedVerticalRing(radius: number, color: number): THREE.LineLoop {
  const segments = 64;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(0, radius * Math.sin(t), radius * Math.cos(t)));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
}

// Vòng NGANG — đây mới là vòng THỰC SỰ CHUYỂN ĐỘNG: trượt lên/xuống dọc vòng đứng cố định theo đúng
// elevation hiện tại (thu nhỏ bán kính dần khi tới gần 2 cực, như 1 vòng vĩ tuyến trên địa cầu) — đèn
// nằm TRÊN vòng này, di chuyển dọc nó khi đổi azimuth. Đây đúng cơ chế anh mô tả: "đèn gắn trên vòng
// ngang, vòng ngang trượt trên vòng đứng" — KHÔNG phải vòng ngang cố định như bản trước.
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
    opacity: 0.07,
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

function LightSphereCanvas({ value, onChange }: { value: LightSettings; onChange: (v: LightSettings) => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const lightDotRef = useRef<THREE.Mesh | null>(null);
  const lightHaloRef = useRef<THREE.Mesh | null>(null);
  const horizontalRingRef = useRef<THREE.LineLoop | null>(null);
  const beamConeRef = useRef<THREE.Mesh | null>(null);
  const simLightRef = useRef<THREE.SpotLight | null>(null);
  const subjectRef = useRef<THREE.Mesh | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  // 3 thao tác kéo HOÀN TOÀN ĐỘC LẬP với nhau — bấm trúng đâu quyết định thao tác nào, không cái nào
  // ảnh hưởng tới cái kia: "light" = kéo di chuyển đèn quanh quả cầu (azimuth/elevation của đèn);
  // "subject" = kéo TRÚNG chủ thể để xoay riêng chủ thể tại chỗ (chỉ subject.rotation.y, không đụng gì
  // tới đèn/camera); "orbit" = kéo chỗ TRỐNG (không trúng đèn, không trúng chủ thể) để xoay góc nhìn
  // camera quanh cả cụm (quả cầu + 2 vòng), khớp yêu cầu "vòng tròn đứng cũng xoay được" mà không đụng
  // tới chủ thể hay đèn.
  const dragRef = useRef<{
    mode: "light" | "subject" | "orbit" | null;
    startX: number;
    startY: number;
    startAz: number;
    startEl: number;
    startOrbitAz: number;
    startSubjectRotY: number;
  }>({ mode: null, startX: 0, startY: 0, startAz: 0, startEl: 0, startOrbitAz: 0, startSubjectRotY: 0 });
  // Toạ độ cầu của CAMERA (khác hẳn toạ độ cầu của đèn) — distance giảm (8.13 -> 6.0) để ZOOM GẦN hơn,
  // vật thể + quả cầu/vòng tròn hiện to hơn rõ rệt trong khung (khớp yêu cầu "tăng khung hình to lên
  // đồng nghĩa vật thể và vòng tròn cũng tăng lên"), giữ nguyên góc azimuth/elevation ban đầu.
  const orbitRef = useRef({ azimuth: 0.4127, elevation: 0.198, distance: 6.0 });
  const valueRef = useRef(value);
  valueRef.current = value;

  function updateCameraFromOrbit() {
    const camera = cameraRef.current;
    if (!camera) return;
    const { azimuth, elevation, distance } = orbitRef.current;
    const y = distance * Math.sin(elevation);
    const r = distance * Math.cos(elevation);
    camera.position.set(r * Math.sin(azimuth), y, r * Math.cos(azimuth));
    camera.lookAt(0, 0, 0);
  }

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    // Ánh sáng nền CỰC YẾU (0.15 -> 0.06 -> 0.025) — chỉ đủ để chủ thể không biến mất hoàn toàn khi đèn
    // mô phỏng quay đi hướng khác, còn lại để simLight quyết định chủ thể sáng/tối thế nào.
    scene.add(new THREE.AmbientLight(0xffffff, 0.05));
    // Ánh sáng BÁN CẦU (trên sáng hơn dưới) — KHÁC ambient (ambient chiếu đều mọi mặt như nhau, làm
    // khối bẹt phẳng mất góc cạnh). Hemisphere tạo gradient sáng theo hướng pháp tuyến từng mặt (mặt
    // hướng lên sáng hơn mặt hướng xuống/ngang), giúp nhận biết rõ góc cạnh khối kể cả khi simLight
    // không chiếu trực tiếp vào — đúng hiệu ứng "3 mặt sáng-tối khác nhau" ở ảnh tham khảo.
    scene.add(new THREE.HemisphereLight(0x71717a, 0x09090b, 0.55));

    const radius = SPHERE_RADIUS;
    // Vòng đứng CỐ ĐỊNH — đường ray tham chiếu, không bao giờ xoay/trượt.
    scene.add(createFixedVerticalRing(radius, 0x71717a));

    // Vòng ngang TRƯỢT dọc vòng đứng theo elevation hiện tại (thu nhỏ bán kính khi gần cực) — đèn nằm
    // trên vòng này. Đúng cơ chế: "đèn gắn trên vòng ngang, vòng ngang trượt trên vòng đứng".
    const horizontalRing = createSlidingHorizontalRing(radius, value.elevation, 0x71717a);
    scene.add(horizontalRing);
    horizontalRingRef.current = horizontalRing;

    // Chủ thể chung chung ở giữa (không phải mannequin thật) — hình khối dẹt kiểu thiết bị, ĐỨNG YÊN
    // cố định (chỉ ĐÈN xoay quanh nó, khác tính năng mannequin cho xoay NHÂN VẬT) — chỉ để hình dung
    // hướng sáng, không đại diện nhân vật.
    // Bỏ emissive (thử trước đó) — emissive chiếu ĐỀU mọi mặt như nhau nên làm khối nhìn bẹt phẳng,
    // mất hẳn độ tương phản góc cạnh. Giờ dùng HemisphereLight (phía trên) để tạo gradient sáng/tối tự
    // nhiên theo từng mặt, màu nền vẫn sáng vừa đủ (0xc7c7cc) để không bị đen ở mặt ít sáng.
    const subject = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 1.9, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xc7c7cc, roughness: 0.5, metalness: 0.2 })
    );
    scene.add(subject);
    subjectRef.current = subject;

    // Dấu mặt trước — 1 khấc nhỏ nổi trên đúng mặt +Z (hướng về phía "Đằng trước", azimuth=0) để phân
    // biệt trước/sau khi xoay chủ thể, khớp chi tiết nhỏ (icon) trên mặt trước thiết bị ở ảnh tham khảo.
    const frontMark = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 16),
      new THREE.MeshStandardMaterial({ color: 0x52525b, roughness: 0.6 })
    );
    frontMark.position.set(0, 0, 0.151);
    subject.add(frontMark);

    const lightDot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshBasicMaterial({ color: value.color }));
    scene.add(lightDot);
    lightDotRef.current = lightDot;

    const lightHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xa3e635, transparent: true, opacity: 0.35 })
    );
    scene.add(lightHalo);
    lightHaloRef.current = lightHalo;

    const pos = sphericalToPosition(value.azimuth, value.elevation, radius);
    lightDot.position.copy(pos);
    lightHalo.position.copy(pos);

    // Đèn mô phỏng THẬT — chiếu từ đúng vị trí chấm sáng (đèn 1) hướng về chủ thể, màu/độ sáng/góc
    // lan toả đọc trực tiếp từ value (xem effect đồng bộ bên dưới) — đây là phần khách THẤY NGAY hiệu
    // ứng khi đổi Màu sắc/Độ sáng/Lan toả hoặc kéo đèn, trước đây thiếu hẳn bước này.
    const subjectTarget = new THREE.Object3D();
    subjectTarget.position.set(0, 0, 0);
    scene.add(subjectTarget);
    const simLight = new THREE.SpotLight(value.color, (value.brightness / 100) * 6, 12, THREE.MathUtils.degToRad(12 + (value.spread / 100) * 45), 0.5, 1);
    simLight.position.copy(pos);
    simLight.target = subjectTarget;
    scene.add(simLight);
    simLightRef.current = simLight;

    // Luồng sáng NHÌN THẤY ĐƯỢC (cone mờ) từ đèn chiếu vào chủ thể — khác simLight (chỉ làm sáng/tối bề
    // mặt), cone này mô phỏng chính luồng ánh sáng đi qua không gian, khách thấy ngay "có ánh sáng đang
    // chiếu" chứ không chỉ suy ra qua bóng đổ trên vật thể.
    const beamRadius = 0.25 + (value.spread / 100) * 0.9;
    const beamCone = createBeamCone(pos, new THREE.Vector3(0, 0, 0), beamRadius, value.color);
    scene.add(beamCone);
    beamConeRef.current = beamCone;

    // FOV 50° + camera cách gốc ~8 đơn vị (giữ nguyên khoảng cách để toàn bộ 6 vị trí "Chọn nhanh" vẫn
    // nằm thoải mái trong khung, xem ghi chú cũ). QUAN TRỌNG: camera trước đây đặt đúng x=0 — TRÙNG mặt
    // phẳng chứa vòng đứng cố định (YZ plane) — nên nhìn vòng đứng bị DẸT THÀNH 1 ĐƯỜNG THẲNG (nhìn
    // ngay cạnh/edge-on), trông như "bị khoá chết" không tròn. Lệch camera sang X>0 (góc 3/4) để NHÌN
    // CHÉO vào cả 2 vòng, cả 2 đều hiện tròn/elip rõ ràng như ảnh tham khảo.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
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
      ro.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Đổi màu/áp vị trí mới khi value đổi từ bên ngoài (vd bấm nút "Chọn nhanh", kéo thanh Độ sáng/Lan
  // toả) — đồng bộ chấm đèn, vòng ngang (trượt theo elevation), đèn mô phỏng thật (simLight) và cone
  // luồng sáng nhìn thấy được.
  useEffect(() => {
    if (!lightDotRef.current || !lightHaloRef.current || !sceneRef.current || !cameraRef.current || !rendererRef.current) return;
    const pos = sphericalToPosition(value.azimuth, value.elevation, SPHERE_RADIUS);
    lightDotRef.current.position.copy(pos);
    lightHaloRef.current.position.copy(pos);
    (lightDotRef.current.material as THREE.MeshBasicMaterial).color.set(value.color);
    if (horizontalRingRef.current) updateSlidingHorizontalRing(horizontalRingRef.current, SPHERE_RADIUS, value.elevation);
    if (simLightRef.current) {
      simLightRef.current.position.copy(pos);
      simLightRef.current.color.set(value.color);
      simLightRef.current.intensity = (value.brightness / 100) * 6;
      simLightRef.current.angle = THREE.MathUtils.degToRad(12 + (value.spread / 100) * 45);
    }
    if (beamConeRef.current) {
      const beamRadius = 0.25 + (value.spread / 100) * 0.9;
      updateBeamCone(beamConeRef.current, pos, new THREE.Vector3(0, 0, 0), beamRadius, value.color);
    }
    rendererRef.current.render(sceneRef.current, cameraRef.current);
  }, [value.azimuth, value.elevation, value.color, value.brightness, value.spread]);

  function render() {
    if (sceneRef.current && cameraRef.current && rendererRef.current) {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
    }
  }

  // Bấm trúng đèn -> kéo di chuyển đèn; bấm trúng chủ thể -> kéo xoay RIÊNG chủ thể; bấm chỗ trống
  // khác -> kéo xoay góc nhìn camera quanh cả cụm. 3 thao tác độc lập hoàn toàn, không cái nào đụng
  // tới cái kia (xem ghi chú dragRef phía trên).
  function handlePointerDown(e: React.PointerEvent) {
    const mount = mountRef.current;
    if (!mount || !cameraRef.current || !lightDotRef.current) return;
    (e.target as Element).setPointerCapture(e.pointerId);

    const rect = mount.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycasterRef.current.setFromCamera(ndc, cameraRef.current);
    // Raycast vào đèn VÀ quầng sáng quanh nó trước (ưu tiên cao nhất — bán kính lớn hơn, dễ bấm trúng
    // hơn vòng lõi nhỏ), rồi mới tới chủ thể, còn lại coi là chỗ trống.
    const lightTargets = [lightDotRef.current, lightHaloRef.current].filter((o): o is THREE.Mesh => !!o);
    const hitsLight = raycasterRef.current.intersectObjects(lightTargets, false).length > 0;
    const hitsSubject = !hitsLight && subjectRef.current ? raycasterRef.current.intersectObject(subjectRef.current, false).length > 0 : false;

    dragRef.current = {
      mode: hitsLight ? "light" : hitsSubject ? "subject" : "orbit",
      startX: e.clientX,
      startY: e.clientY,
      startAz: valueRef.current.azimuth,
      startEl: valueRef.current.elevation,
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

    const dy = e.clientY - dragRef.current.startY;
    const nextAz = dragRef.current.startAz + dx * 0.012;
    const elevLimit = Math.PI / 2 - 0.05;
    const nextEl = Math.max(-elevLimit, Math.min(elevLimit, dragRef.current.startEl - dy * 0.012));
    const next = { ...valueRef.current, azimuth: nextAz, elevation: nextEl };
    if (lightDotRef.current && lightHaloRef.current) {
      const pos = sphericalToPosition(nextAz, nextEl, SPHERE_RADIUS);
      lightDotRef.current.position.copy(pos);
      lightHaloRef.current.position.copy(pos);
      if (horizontalRingRef.current) updateSlidingHorizontalRing(horizontalRingRef.current, SPHERE_RADIUS, nextEl);
      if (simLightRef.current) simLightRef.current.position.copy(pos);
      if (beamConeRef.current) {
        const beamRadius = 0.25 + (valueRef.current.spread / 100) * 0.9;
        updateBeamCone(beamConeRef.current, pos, new THREE.Vector3(0, 0, 0), beamRadius, valueRef.current.color);
      }
      render();
    }
    onChange(next);
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
  initial: LightSettings | null;
  onClose: () => void;
  onApply: (settings: LightSettings) => void;
}) {
  const [value, setValue] = useState<LightSettings>(initial ?? DEFAULT_LIGHT_SETTINGS);
  const nearest = nearestLightQuickPosition(value.azimuth, value.elevation);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h3 className="text-base font-semibold">Thiết lập ánh sáng mới</h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setValue(DEFAULT_LIGHT_SETTINGS)}
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
          <span className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-semibold">Đèn 1</span>
          <button type="button" disabled title="Sắp ra mắt — hiện chỉ hỗ trợ 1 đèn" className="flex items-center gap-1 px-2 text-xs text-zinc-600">
            + Thêm ánh sáng
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-[200px_1fr_180px]">
          <div className="space-y-3">
            <p className="text-xs font-medium text-zinc-500">Đèn 1</p>
            <label className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="text-zinc-500">Màu sắc</span>
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={value.color}
                  onChange={(e) => setValue((v) => ({ ...v, color: e.target.value }))}
                  className="h-5 w-5 cursor-pointer rounded-full border-0 bg-transparent p-0"
                />
                <span className="font-mono text-zinc-300">{value.color.toUpperCase()}</span>
              </span>
            </label>
            <label className="block rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="mb-1 flex items-center justify-between text-zinc-500">
                Độ sáng <span className="text-zinc-300">{value.brightness}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value.brightness}
                onChange={(e) => setValue((v) => ({ ...v, brightness: Number(e.target.value) }))}
                className="w-full accent-lime-400"
              />
            </label>
            <label className="block rounded-lg bg-zinc-900 px-3 py-2 text-xs">
              <span className="mb-1 flex items-center justify-between text-zinc-500">
                Lan toả <span className="text-zinc-300">{value.spread}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value.spread}
                onChange={(e) => setValue((v) => ({ ...v, spread: Number(e.target.value) }))}
                className="w-full accent-lime-400"
              />
            </label>
          </div>

          <div
            className="min-h-[380px] rounded-xl"
            style={{ background: "radial-gradient(circle at 50% 50%, #3f3f46 0%, #27272a 55%, #18181b 100%)" }}
          >
            <LightSphereCanvas value={value} onChange={setValue} />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-500">Chọn nhanh</p>
            <div className="grid grid-cols-2 gap-2">
              {LIGHT_QUICK_POSITIONS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setValue((v) => ({ ...v, azimuth: p.azimuth, elevation: p.elevation }))}
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
              onApply(value);
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
