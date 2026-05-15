import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Delaunator from 'delaunator';

const PALETTE = [
  '#e8c9a0', // 米色
  '#d96a6a', // 紅
  '#e8994f', // 橙
  '#efc94c', // 黃
  '#8ec265', // 草綠
  '#4f9d69', // 森綠
  '#65b7c2', // 青
  '#5581c2', // 藍
  '#7b6cc2', // 紫
  '#c25894', // 粉
  '#ece1cc', // 奶白
  '#8a6a4a', // 棕
  '#9aa3b0', // 灰
  '#3a4150', // 深灰
];

let currentColor = 1;

const BLOCK_HEIGHT = 1.0;

// ===== 場景初始化 =====
const app = document.getElementById('app');
const scene = new THREE.Scene();
// 天空改由 shader 球體呈現漸層；fog 顏色取地平線色以便無縫銜接
scene.background = null;
scene.fog = new THREE.Fog('#e8ebe6', 55, 200);

// 倒置天空球：漸層 + 飄動雲層
let skyMaterial = null;
(function setupSkyDome() {
  const geom = new THREE.SphereGeometry(380, 48, 24);
  skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith:  { value: new THREE.Color('#4a82c0') },   // 飽和的天空藍
      uHorizon: { value: new THREE.Color('#c5d4e0') },   // 淡藍灰（不再是cream）
      uGround:  { value: new THREE.Color('#d8d0c0') },
      uCloudColor: { value: new THREE.Color('#fffefa') }, // 純白偏暖
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vDir = normalize(worldPos.xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uCloudColor;
      uniform float uTime;
      varying vec3 vDir;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f*f*(3.0 - 2.0*f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      // FBM：四階疊加，做更自然的雲團
      float fbm(vec2 p) {
        float v = 0.0, amp = 0.5;
        for (int i = 0; i < 4; i++) {
          v += amp * vnoise(p);
          p *= 2.07;
          amp *= 0.55;
        }
        return v;
      }

      void main() {
        float h = vDir.y;
        // 漸層：地平線只佔很窄一段，主要是藍天
        vec3 col;
        if (h >= 0.0) {
          float t = smoothstep(0.0, 0.18, h);   // 0 → 0.18 之間快速從地平線轉藍
          col = mix(uHorizon, uZenith, t);
        } else {
          float t = smoothstep(0.0, -0.15, h);
          col = mix(uHorizon, uGround, t);
        }
        // 雲層：用球面 lat/lon 當 noise 輸入，整片天空都有對等密度的雲
        if (h > -0.05) {
          float az = atan(vDir.x, vDir.z);            // -π ~ π
          float el = vDir.y;                          // -1 ~ 1
          vec2 cp = vec2(az * 1.4, el * 3.0);
          cp.x += uTime * 0.04;                       // 雲團繞天緩慢漂移
          float n = fbm(cp * 1.2);
          float cloud = smoothstep(0.50, 0.62, n);    // 窄閾值 → 雲跟藍天分明
          float cloudVis = smoothstep(-0.02, 0.20, h);
          col = mix(col, uCloudColor, cloud * cloudVis * 0.95);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geom, skyMaterial);
  sky.renderOrder = -1;
  scene.add(sky);
})();

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(22, 18, 22);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

// 注意：原本試過加 RoomEnvironment PMREM，但配合現有 hemi + ambient + directional 光會過曝，
// 把紅色洗成粉色、綠色變薄荷。原始光照組合已經很足，環境貼圖暫時關閉。

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 6;
controls.maxDistance = 120;
controls.maxPolarAngle = Math.PI * 0.47;
controls.target.set(0, 1, 0);

// ===== 動態鏡頭聚焦 =====
// 規則：
//   - 沒任何方塊：聚焦地圖中央 (0, 1, 0)
//   - 有方塊：聚焦所有 block 的「重心」（每個 block 視為 1 個權重，包含高度）
// 平滑追焦：每 frame lerp 至目標，camera.position 同步平移，保留使用者目前的視角距離與角度
const desiredTarget = new THREE.Vector3(0, 1, 0);
function computeFocusTarget(out) {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    const cx = cell.center[0], cz = cell.center[1];
    for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
      sx += cx;
      sy += (lvl + 0.5) * BLOCK_HEIGHT;
      sz += cz;
      n++;
    }
  }
  if (n === 0) return out.set(0, 1, 0);
  return out.set(sx / n, sy / n, sz / n);
}
function updateFocus() { computeFocusTarget(desiredTarget); }
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: null,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

// ===== 光照 =====
scene.add(new THREE.HemisphereLight('#bfd6ee', '#7a6a50', 0.65));
scene.add(new THREE.AmbientLight('#ffffff', 0.25));

const sun = new THREE.DirectionalLight('#fff3d8', 1.35);
sun.position.set(18, 30, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 80;
const sh = 32;
sun.shadow.camera.left = -sh;
sun.shadow.camera.right = sh;
sun.shadow.camera.top = sh;
sun.shadow.camera.bottom = -sh;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// 陰影承接平面
// 程序草地材質：接收陰影，表面有 value-noise 色塊變化
const groundMat = new THREE.MeshStandardMaterial({
  color: 0xbacfa2,  // 稍飽和的草綠，配合新天空色
  roughness: 1.0, metalness: 0,
});
groundMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    '#include <common>\nvarying vec3 vGroundPos;'
  ).replace(
    '#include <worldpos_vertex>',
    '#include <worldpos_vertex>\nvGroundPos = worldPosition.xyz;'
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>
     varying vec3 vGroundPos;
     float hash21(vec2 p) {
       return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
     }
     // Cell-based value noise
     float vnoise(vec2 p) {
       vec2 i = floor(p);
       vec2 f = fract(p);
       f = f*f*(3.0 - 2.0*f);
       float a = hash21(i);
       float b = hash21(i + vec2(1.0, 0.0));
       float c = hash21(i + vec2(0.0, 1.0));
       float d = hash21(i + vec2(1.0, 1.0));
       return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
     }
    `
  ).replace(
    '#include <color_fragment>',
    `#include <color_fragment>
     vec2 p = vGroundPos.xz;
     // 層疊 noise：大塊色差 + 細節
     float n1 = vnoise(p * 0.8);
     float n2 = vnoise(p * 3.1);
     float n = n1 * 0.65 + n2 * 0.35;
     // 基礎色暈染
     diffuseColor.rgb *= (0.85 + n * 0.3);
     // 偶爾較深的草叢斑點
     float clump = smoothstep(0.72, 0.9, n2);
     diffuseColor.rgb *= (1.0 - clump * 0.15);
     // 中心區域稍微偏綠，遠處略偏黃土色
     float dist = length(p);
     float tint = smoothstep(18.0, 40.0, dist);
     diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.04, 0.98, 0.88), tint);
    `
  );
};
const shadowGround = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500, 1, 1),
  groundMat
);
shadowGround.rotation.x = -Math.PI / 2;
shadowGround.position.y = -0.005;
shadowGround.receiveShadow = true;
scene.add(shadowGround);

// ===== 不規則 Voronoi 地圖生成 =====
// 策略：六角晶格 + 大幅抖動 → Laplacian smoothing → Delaunay → Voronoi (外心法) → 離群合併
// - Voronoi cell 形狀天然多樣（5~7 邊為主）
// - 弱 Laplacian smoothing 在保留不規則感的前提下抹平局部過密
// - 外圈 phantom buffer ring：讓內圈點都不落在凸殼上 → 邊界 cell 完整封閉、無任何裁切
// - 離群合併只清掉異常小的 cell，不破壞整體不規則感
function generateGrid(radius = 13, seed = Math.random()) {
  // seeded RNG
  let s = Math.floor(seed * 2 ** 31) >>> 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ===== 1. 點集：六角晶格 + 大幅抖動；外圍 BUFFER_RINGS 圈 phantom 點 =====
  // 設計動機：
  //  - 內圈（|q+r| <= radius）：輸出 cell 的真實點
  //  - 外圈 phantom 點：只參與 Delaunay/Voronoi 拓樸計算，最後丟棄；
  //    讓所有內圈點都不會落在凸殼上 → 每個內圈點都有「完整封閉」的 Voronoi cell
  //  - 完全沒有任何半徑 / mask 的後續裁切，邊界形狀由 Voronoi 自然決定
  const pts = [];
  const isPhantom = [];
  const JITTER = 0.72;                          // 大幅抖動：打破六角晶格的規則感
  const BUFFER_RINGS = 2;
  const maxR = radius + BUFFER_RINGS;
  for (let q = -maxR; q <= maxR; q++) {
    for (let r = -maxR; r <= maxR; r++) {
      // axial 六角座標到原點的距離 = max(|q|, |r|, |q+r|)
      const hexDist = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      if (hexDist > maxR) continue;
      const x = q + r * 0.5;
      const z = r * Math.sqrt(3) / 2;
      // 內圈：完整 jitter；phantom 外圈：保持較規則（小 jitter）→ 避免邊界三角形退化
      const isPh = hexDist > radius;
      const j = isPh ? JITTER * 0.25 : JITTER;
      pts.push([x + (rnd() - 0.5) * j, z + (rnd() - 0.5) * j]);
      isPhantom.push(isPh);
    }
  }

  // ===== 2. Laplacian smoothing：只移動內圈點，phantom 固定 =====
  // - 邊界內圈點受外圈 phantom 影響 → 自然過渡，不會被「集體拉向內部」
  // - 1 pass、權重 0.35：弱平滑；只清掉極端密集，保留高度不規則性
  //   （多輪會把點推回近 CVT 而 cell 變回大量六角形）
  for (let pass = 0; pass < 1; pass++) {
    const tmpDel = Delaunator.from(pts);
    const adj = new Map();
    const tt = tmpDel.triangles;
    for (let e = 0; e < tt.length; e++) {
      const a = tt[e];
      const next = (e % 3 === 2) ? e - 2 : e + 1;
      const b = tt[next];
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a).add(b);
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(b).add(a);
    }
    const newPts = pts.map((p, i) => {
      if (isPhantom[i]) return p;               // phantom 不移動
      const ns = adj.get(i);
      if (!ns || ns.size === 0) return p;
      let sx = 0, sy = 0;
      for (const j of ns) { sx += pts[j][0]; sy += pts[j][1]; }
      const tx = sx / ns.size, ty = sy / ns.size;
      return [p[0] + (tx - p[0]) * 0.35, p[1] + (ty - p[1]) * 0.35];
    });
    for (let i = 0; i < pts.length; i++) pts[i] = newPts[i];
  }

  // 公用：多邊形面積（合併步驟也用得到，所以放在這裡先宣告）
  const polyArea = (verts) => {
    let a = 0;
    for (let i = 0; i < verts.length; i++) {
      const [x1, z1] = verts[i];
      const [x2, z2] = verts[(i + 1) % verts.length];
      a += x1 * z2 - x2 * z1;
    }
    return Math.abs(a) / 2;
  };

  // ===== 3. Delaunay → Voronoi cell（外心法）=====
  // 每個 input point 一個 cell：周圍三角形的外心 = 此 cell 的多邊形頂點
  // 性質：
  //  - 邊數自然分布 5–7，沒有任何「強制 quad」的偏好
  //  - 配合 CVT-like 點分布 → 面積天然均衡
  //  - 兩個相鄰 cell 共用兩個三角形外心（共邊兩端） → 跨 cell 頂點 ID 一致
  const del = Delaunator.from(pts);
  const tris = del.triangles;
  const halfedges = del.halfedges;
  const numTri = tris.length / 3;
  const numPts = pts.length;

  const triCircum = new Array(numTri);
  for (let t = 0; t < numTri; t++) {
    const [ax, az] = pts[tris[3 * t]];
    const [bx, bz] = pts[tris[3 * t + 1]];
    const [cx, cz] = pts[tris[3 * t + 2]];
    const ad = ax * ax + az * az;
    const bd = bx * bx + bz * bz;
    const cd = cx * cx + cz * cz;
    const D = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
    if (Math.abs(D) < 1e-12) {
      // 退化（近共線）：退回三角形重心，避免 NaN
      triCircum[t] = [(ax + bx + cx) / 3, (az + bz + cz) / 3];
    } else {
      triCircum[t] = [
        (ad * (bz - cz) + bd * (cz - az) + cd * (az - bz)) / D,
        (ad * (cx - bx) + bd * (ax - cx) + cd * (bx - ax)) / D,
      ];
    }
  }

  // 對每個 input point 找一條 incoming halfedge（hull 邊優先）
  const inedges = new Int32Array(numPts).fill(-1);
  for (let e = 0; e < tris.length; e++) {
    const nextE = (e % 3 === 2) ? e - 2 : e + 1;
    const p = tris[nextE];
    if (inedges[p] === -1 || halfedges[e] === -1) inedges[p] = e;
  }

  // 走 point p 周圍的 incoming halfedge → 對應的三角形 id 列表（圍繞 p 的有序環）
  const trianglesAroundPoint = (p) => {
    const triIds = [];
    const start = inedges[p];
    if (start === -1) return triIds;
    let e = start;
    do {
      triIds.push(Math.floor(e / 3));
      const outgoing = (e % 3 === 2) ? e - 2 : e + 1;
      e = halfedges[outgoing];
      if (e === -1) return [];                  // 走到 hull → 開放 cell，捨棄
    } while (e !== start);
    return triIds;
  };

  // ===== 4. 為每個 inner point 構建 Voronoi cell =====
  // vertIdx 直接用 triangle id（自然在共邊處跨 cell 共用），verts 為對應外心座標
  const rawCells = [];
  for (let p = 0; p < numPts; p++) {
    if (isPhantom[p]) continue;
    const triIds = trianglesAroundPoint(p);
    if (triIds.length < 3) continue;            // 退化：不形成多邊形（理論上不發生）
    const verts = triIds.map(t => triCircum[t]);
    rawCells.push({ id: rawCells.length, vertIdx: triIds.slice(), verts, blocks: [] });
  }
  const cells = rawCells;

  // 中心點 + 鄰接
  for (const c of cells) {
    let cx = 0, cz = 0;
    for (const v of c.verts) { cx += v[0]; cz += v[1]; }
    c.center = [cx / c.verts.length, cz / c.verts.length];
  }
  const edgeKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
  const edgeMap = new Map();
  for (const c of cells) {
    c.neighbors = new Array(c.vertIdx.length).fill(null);
    for (let i = 0; i < c.vertIdx.length; i++) {
      const a = c.vertIdx[i];
      const b = c.vertIdx[(i + 1) % c.vertIdx.length];
      const k = edgeKey(a, b);
      if (!edgeMap.has(k)) edgeMap.set(k, []);
      edgeMap.get(k).push({ cellId: c.id, edgeIdx: i });
    }
  }
  for (const entries of edgeMap.values()) {
    if (entries.length === 2) {
      const [a, b] = entries;
      cells[a.cellId].neighbors[a.edgeIdx] = b.cellId;
      cells[b.cellId].neighbors[b.edgeIdx] = a.cellId;
    }
  }

  // ===== 5. 後處理：合併「面積偏小的離群 cell」到鄰居 =====
  // Voronoi 本身面積就相對均衡，這一步只清掉抖動造成的局部小 cell。
  // 閾值較保守，避免把太多形狀正常但偏小的 cell 合掉（會破壞不規則感）
  let totalA = 0, countA = 0;
  for (const c of cells) { totalA += polyArea(c.verts); countA++; }
  const avgArea = countA ? totalA / countA : 1;
  const TINY_AREA = avgArea * 0.5;          // < 50% 平均面積才視為離群
  const MAX_MERGED_AREA = avgArea * 1.5;    // 合併結果不可超過 1.5 倍平均，避免局部肥大
  const merged = new Set();
  for (let i = 0; i < cells.length; i++) {
    if (merged.has(i)) continue;
    const c = cells[i];
    // 允許多邊形邊數至 8；更大者極罕見且結構不易合
    if (c.vertIdx.length > 8) continue;
    const cArea = polyArea(c.verts);
    if (cArea >= TINY_AREA) continue;
    // 配最小鄰居以兼顧均勻；合併後不能超過上限
    let bestNb = -1, bestArea = Infinity, bestEdgeIdx = -1;
    for (let k = 0; k < c.neighbors.length; k++) {
      const nb = c.neighbors[k];
      if (nb === null || merged.has(nb)) continue;
      const a = polyArea(cells[nb].verts);
      if (a + cArea > MAX_MERGED_AREA) continue;
      if (a < bestArea) { bestArea = a; bestNb = nb; bestEdgeIdx = k; }
    }
    if (bestNb < 0) continue;
    const M = cells[bestNb];
    const sa = c.vertIdx[bestEdgeIdx];
    const sb = c.vertIdx[(bestEdgeIdx + 1) % c.vertIdx.length];
    // 從 c 的 (sb→sa) 之外那一側的頂點，依環序取出（同時取 idx 與座標，避免再查 pts）
    const otherIdxs = [];
    const otherVerts = [];
    for (let j = 1; j <= c.vertIdx.length - 2; j++) {
      const k = (bestEdgeIdx + 1 + j) % c.vertIdx.length;
      otherIdxs.push(c.vertIdx[k]);
      otherVerts.push(c.verts[k]);
    }
    if (otherIdxs.some(v => M.vertIdx.includes(v))) continue;
    let mEdgeIdx = -1;
    for (let j = 0; j < M.vertIdx.length; j++) {
      const ma = M.vertIdx[j];
      const mb = M.vertIdx[(j + 1) % M.vertIdx.length];
      if (ma === sb && mb === sa) { mEdgeIdx = j; break; }
    }
    if (mEdgeIdx < 0) continue;
    M.vertIdx.splice(mEdgeIdx + 1, 0, ...otherIdxs);
    M.verts.splice(mEdgeIdx + 1, 0, ...otherVerts);
    merged.add(i);
  }
  if (merged.size > 0) {
    const finalCells = [];
    for (let i = 0; i < cells.length; i++) {
      if (merged.has(i)) continue;
      const c = cells[i];
      finalCells.push({ id: finalCells.length, vertIdx: c.vertIdx, verts: c.verts, blocks: c.blocks });
    }
    for (const c of finalCells) {
      let cx = 0, cz = 0;
      for (const v of c.verts) { cx += v[0]; cz += v[1]; }
      c.center = [cx / c.verts.length, cz / c.verts.length];
    }
    const edgeMap2 = new Map();
    for (const c of finalCells) {
      c.neighbors = new Array(c.vertIdx.length).fill(null);
      for (let i = 0; i < c.vertIdx.length; i++) {
        const a = c.vertIdx[i];
        const b = c.vertIdx[(i + 1) % c.vertIdx.length];
        const k = edgeKey(a, b);
        if (!edgeMap2.has(k)) edgeMap2.set(k, []);
        edgeMap2.get(k).push({ cellId: c.id, edgeIdx: i });
      }
    }
    for (const entries of edgeMap2.values()) {
      if (entries.length === 2) {
        const [a, b] = entries;
        finalCells[a.cellId].neighbors[a.edgeIdx] = b.cellId;
        finalCells[b.cellId].neighbors[b.edgeIdx] = a.cellId;
      }
    }
    return keepLargestComponent(finalCells);
  }

  return keepLargestComponent(cells);
}

// ===== 取最大連通分量：避免不規則 mask 切出孤島 =====
// 用 cell.neighbors 走 BFS，保留節點數最多的那一塊；rebuild neighbors 索引
function keepLargestComponent(allCells) {
  if (allCells.length <= 1) return allCells;
  const visited = new Uint8Array(allCells.length);
  const components = [];
  for (let i = 0; i < allCells.length; i++) {
    if (visited[i]) continue;
    const comp = [];
    const stack = [i];
    visited[i] = 1;
    while (stack.length) {
      const cid = stack.pop();
      comp.push(cid);
      const nbs = allCells[cid].neighbors;
      for (const nb of nbs) {
        if (nb !== null && !visited[nb]) {
          visited[nb] = 1;
          stack.push(nb);
        }
      }
    }
    components.push(comp);
  }
  if (components.length === 1) return allCells;
  components.sort((a, b) => b.length - a.length);
  const keep = new Set(components[0]);
  const remap = new Map();
  const filtered = [];
  for (let i = 0; i < allCells.length; i++) {
    if (!keep.has(i)) continue;
    const c = allCells[i];
    remap.set(i, filtered.length);
    filtered.push({
      id: filtered.length,
      vertIdx: c.vertIdx,
      verts: c.verts,
      center: c.center,
      blocks: c.blocks,
      neighbors: c.neighbors.slice(),
    });
  }
  for (const c of filtered) {
    for (let i = 0; i < c.neighbors.length; i++) {
      const n = c.neighbors[i];
      c.neighbors[i] = (n === null || !keep.has(n)) ? null : remap.get(n);
    }
  }
  return filtered;
}

let cells = generateGrid(13, Math.random());

// 頂點 → 含有該頂點的所有 cellId（用於連通屋頂判定）
let vertexToCells = new Map();
let vertexPositions = new Map();   // vidx → [x, z] 用於 region 內部距離計算
function buildVertexToCells() {
  vertexToCells = new Map();
  vertexPositions = new Map();
  for (const cell of cells) {
    for (let i = 0; i < cell.vertIdx.length; i++) {
      const vidx = cell.vertIdx[i];
      if (!vertexToCells.has(vidx)) vertexToCells.set(vidx, new Set());
      vertexToCells.get(vidx).add(cell.id);
      if (!vertexPositions.has(vidx)) vertexPositions.set(vidx, cell.verts[i]);
    }
  }
}
buildVertexToCells();

// 每個頂點在 region 內的「內部度」權重：0 = region 邊界, 1 = region 中心
// 取代舊的二元 isVertexInterior，讓屋頂高度形成平滑圓頂
let vertexHeightWeight = new Map();  // vidx → 0..1（每次 rebuildBuildings 後重算）
// 嚴格 region 邊界頂點集合：用於屋簷 overhang 判定（避免 smoothstep 模糊造成邊簷跳躍）
let vertexIsRegionBoundary = new Set();

// 判定：此頂點在指定 top level 是否為 region 內部
// 條件：所有含有此頂點的 cell 頂層等級都等於 level
function isVertexInterior(vidx, level) {
  const containing = vertexToCells.get(vidx);
  for (const cid of containing) {
    const c = cells[cid];
    if (c.blocks.length === 0) return false;
    if (c.blocks.length - 1 !== level) return false;
  }
  return true;
}

// 連通分量：把相鄰的已蓋格分為「建築」，便於做整棟級別的協調
let buildingId = new Map();   // cellId → buildingId
let buildingCells = [];        // buildingId → [cellId, cellId, ...]
function rebuildBuildings() {
  buildingId.clear();
  buildingCells.length = 0;
  let nextId = 0;
  for (const cell of cells) {
    if (!cell.blocks.length || buildingId.has(cell.id)) continue;
    const queue = [cell.id];
    const list = [];
    buildingId.set(cell.id, nextId);
    while (queue.length) {
      const cur = queue.shift();
      list.push(cur);
      for (const nb of cells[cur].neighbors) {
        if (nb !== null && cells[nb].blocks.length > 0 && !buildingId.has(nb)) {
          buildingId.set(nb, nextId);
          queue.push(nb);
        }
      }
    }
    buildingCells.push(list);
    nextId++;
  }
  computeVertexHeightWeights();
}

// 為每個頂點計算「region 內部度」權重（0=邊界、1=最內部）
// 方法：對同一 region 的每個內部頂點，取其到最近邊界頂點的歐氏距離，再除以該 region 最大距離
function computeVertexHeightWeights() {
  vertexHeightWeight.clear();
  vertexIsRegionBoundary.clear();
  // 以 (buildingId, topLevel) 為 region 分組
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    const levelsSet = new Set();
    for (const cid of cellIds) levelsSet.add(cells[cid].blocks.length - 1);
    for (const level of levelsSet) {
      const regionCells = cellIds.filter(c => cells[c].blocks.length - 1 === level);
      const vertsInRegion = new Set();
      for (const cid of regionCells) {
        for (const vidx of cells[cid].vertIdx) vertsInRegion.add(vidx);
      }
      const boundary = [];
      const interior = [];
      for (const vidx of vertsInRegion) {
        // region-内部 = 所有含此頂點的 cell 都在同一 region 同一 top level
        let isInside = true;
        for (const cid of vertexToCells.get(vidx)) {
          const c = cells[cid];
          if (c.blocks.length === 0 || c.blocks.length - 1 !== level) { isInside = false; break; }
        }
        (isInside ? interior : boundary).push(vidx);
      }
      // 記錄嚴格邊界頂點（供屋簷 overhang 使用）
      for (const vb of boundary) vertexIsRegionBoundary.add(vb);
      if (!interior.length) continue;
      if (!boundary.length) {
        // 整個 region 完全封閉（罕見）
        for (const v of interior) vertexHeightWeight.set(v, 1);
        continue;
      }
      // 算每個內部頂點到最近邊界頂點的距離
      let maxD = 0;
      const d = new Map();
      for (const vi of interior) {
        const [x, z] = vertexPositions.get(vi);
        let min2 = Infinity;
        for (const vb of boundary) {
          const [bx, bz] = vertexPositions.get(vb);
          const dd = (x - bx) ** 2 + (z - bz) ** 2;
          if (dd < min2) min2 = dd;
        }
        const dist = Math.sqrt(min2);
        d.set(vi, dist);
        if (dist > maxD) maxD = dist;
      }
      // 歸一化 + 緩和曲線（避免太突兀的落差）
      for (const [vi, dist] of d) {
        const raw = maxD > 1e-6 ? dist / maxD : 1;
        // smoothstep 讓靠邊的那一圈快速上升，中央則趨緩
        const w = raw * raw * (3 - 2 * raw);
        vertexHeightWeight.set(vi, w);
      }
    }
  }
}

// 由 buildingId hash 決定該棟建築統一色偏（同棟 cell 共用 tint）
function buildingTint(bid) {
  const h = ((bid + 1) * 2654435761) >>> 0;
  return [
    1 + (((h & 0xFF) / 255) - 0.5) * 0.10,
    1 + ((((h >> 8) & 0xFF) / 255) - 0.5) * 0.10,
    1 + ((((h >> 16) & 0xFF) / 255) - 0.5) * 0.10,
  ];
}

// ===== 渲染 =====
const cellGroup = new THREE.Group();
scene.add(cellGroup);

const decorationGroup = new THREE.Group();
scene.add(decorationGroup);

const baseGridLines = new THREE.Group();
scene.add(baseGridLines);

const groundPickGroup = new THREE.Group();
scene.add(groundPickGroup);

const hoverRing = new THREE.Group();
scene.add(hoverRing);

// 裝飾群組：樓梯、煙囪、窗戶、牆角柱
const stairsGroup = new THREE.Group();
scene.add(stairsGroup);
const chimneysGroup = new THREE.Group();
scene.add(chimneysGroup);
const windowsGroup = new THREE.Group();
scene.add(windowsGroup);
const cornerPostsGroup = new THREE.Group();
scene.add(cornerPostsGroup);
const wallTrimGroup = new THREE.Group();
scene.add(wallTrimGroup);
const doorsGroup = new THREE.Group();
scene.add(doorsGroup);
const dormersGroup = new THREE.Group();
scene.add(dormersGroup);
const treesGroup = new THREE.Group();
scene.add(treesGroup);
const groundDetailsGroup = new THREE.Group();
scene.add(groundDetailsGroup);

const _chimneyGeom = new THREE.BoxGeometry(0.24, 0.6, 0.24);
const _chimneyMat = new THREE.MeshStandardMaterial({
  color: 0x4a3f35, roughness: 0.88, metalness: 0, flatShading: true,
});
// 拱形窗戶：Shape 做上半圓 + 下矩形
function _buildArchedWindowGeom() {
  const w = 0.38, h = 0.55, r = w / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(w / 2, h / 2 - r);
  shape.absarc(0, h / 2 - r, r, 0, Math.PI, false);
  shape.lineTo(-w / 2, -h / 2);
  const g = new THREE.ShapeGeometry(shape);
  return g;
}
const _windowGeom = _buildArchedWindowGeom();
const _windowMat = new THREE.MeshStandardMaterial({
  color: 0x1c2230, roughness: 0.4, metalness: 0.15,
});
const _stairMat = new THREE.MeshStandardMaterial({
  color: 0xd2c29a, roughness: 0.92, metalness: 0, flatShading: true, vertexColors: true,
});
// 牆角柱（timber frame 感）
const _postGeom = new THREE.BoxGeometry(0.08, 1, 0.08);
const _postMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true, vertexColors: false,
});

let chimneyInstMesh = null;
let windowInstMesh = null;
let stairsMesh = null;
let cornerPostsMesh = null;

function disposeGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    c.geometry && c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose && m.dispose());
      else c.material.dispose && c.material.dispose();
    }
  }
}

function buildBaseGridLines() {
  disposeGroup(baseGridLines);
  const positions = [];
  const drawn = new Set();
  for (const c of cells) {
    const cellHasBlock = c.blocks.length > 0;
    for (let i = 0; i < c.vertIdx.length; i++) {
      const a = c.vertIdx[i];
      const b = c.vertIdx[(i + 1) % c.vertIdx.length];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (drawn.has(k)) continue;
      drawn.add(k);
      const nbId = c.neighbors[i];
      const nbHasBlock = nbId !== null && cells[nbId].blocks.length > 0;
      if (cellHasBlock || nbHasBlock) { drawn.add(k); continue; }
      const va = c.verts[i];
      const vb = c.verts[(i + 1) % c.verts.length];
      positions.push(va[0], -0.001, va[1], vb[0], -0.001, vb[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  baseGridLines.add(new THREE.LineSegments(g,
    new THREE.LineBasicMaterial({ color: 0xb5c1d2 })));
}

function buildGroundPick() {
  disposeGroup(groundPickGroup);
  for (const cell of cells) {
    const shape = new THREE.Shape(cell.verts.map(v => new THREE.Vector2(v[0], v[1])));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    m.userData = { type: 'ground', cellId: cell.id };
    groundPickGroup.add(m);
  }
}

// 樓梯：相鄰兩格頂層高差 1 時，在較矮那格靠邊處加斜坡
function buildStairs() {
  if (stairsMesh) {
    stairsGroup.remove(stairsMesh);
    stairsMesh.geometry.dispose();
    stairsMesh = null;
  }
  const posA = [], normA = [], colA = [], idxA = [];
  const STAIR_DEPTH = 0.22;
  const EPS = 0.003;
  // 樓梯的「平台高度」要對應較矮那格的建築屋頂高度
  const cellRoofH = (c) => {
    const bid = buildingId.get(c.id);
    const sz = (bid != null) ? buildingCells[bid].length : 1;
    return sz <= 2 ? 0.65 : (sz <= 5 ? 0.55 : 0.42);
  };
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    const myTop = cell.blocks.length - 1;
    const myTopY = (myTop + 1) * BLOCK_HEIGHT;
    const myRoofH = cellRoofH(cell);
    for (let i = 0; i < cell.vertIdx.length; i++) {
      const nei = cell.neighbors[i];
      if (nei === null || !cells[nei].blocks.length) continue;
      if (cells[nei].blocks.length - 1 !== myTop + 1) continue;
      const a = cell.verts[i];
      const b = cell.verts[(i + 1) % cell.vertIdx.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const elen = Math.hypot(dx, dz);
      const inx = dz / elen;
      const inz = -dx / elen;
      const ax2 = a[0] + inx * STAIR_DEPTH;
      const az2 = a[1] + inz * STAIR_DEPTH;
      const bx2 = b[0] + inx * STAIR_DEPTH;
      const bz2 = b[1] + inz * STAIR_DEPTH;
      const yHigh = myTopY + BLOCK_HEIGHT - EPS;
      const yLow = myTopY + myRoofH + EPS;
      const vbase = posA.length / 3;
      // 4 頂點：邊上(高) a, b；向內(低) b', a'
      posA.push(
        a[0], yHigh, a[1],
        b[0], yHigh, b[1],
        bx2, yLow, bz2,
        ax2, yLow, az2,
      );
      // 斜面法線（向上且向內）：ramp 的垂直差是 BLOCK_HEIGHT - 該格屋頂高度
      const vRise = BLOCK_HEIGHT - myRoofH;
      const scale = Math.hypot(STAIR_DEPTH * elen, vRise * elen);
      const nnx = dz * vRise / scale;
      const ny = STAIR_DEPTH * elen / scale;
      const nnz = -dx * vRise / scale;
      for (let k = 0; k < 4; k++) normA.push(nnx, ny, nnz);
      // AO：邊緣略暗、上方亮
      colA.push(0.88, 0.88, 0.88, 0.88, 0.88, 0.88, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95);
      idxA.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    }
  }
  if (!idxA.length) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normA, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colA, 3));
  geom.setIndex(idxA);
  geom.computeBoundingSphere();
  stairsMesh = new THREE.Mesh(geom, _stairMat);
  stairsMesh.castShadow = true;
  stairsMesh.receiveShadow = true;
  stairsGroup.add(stairsMesh);
}

// 煙囪：~22% 頂層方塊會長煙囪
function buildChimneys() {
  if (chimneyInstMesh) {
    chimneysGroup.remove(chimneyInstMesh);
    chimneyInstMesh.dispose();
    chimneyInstMesh = null;
  }
  const insts = [];
  // 改為「整棟最多 1~2 根」：選每棟最高（其次最大）的格子當煙囪
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    // 依 height 降序、再依 cellId 穩定排序
    const sorted = cellIds.slice().sort((a, b) => {
      const dh = cells[b].blocks.length - cells[a].blocks.length;
      if (dh !== 0) return dh;
      return a - b;
    });
    const chimCount = Math.min(sorted.length, 1 + Math.floor(cellIds.length / 8));
    for (let k = 0; k < chimCount; k++) {
      const cell = cells[sorted[k]];
      const hash = ((cell.id + 7) * 2654435761) >>> 0;
      const topY = cell.blocks.length * BLOCK_HEIGHT;
    // 動態尺寸：高度與寬度依 hash 變化
    const hMult = 1.2 + ((hash >> 8) & 0xFF) / 255 * 0.3;   // 高度倍率 1.2~1.5
    const wMult = 0.85 + ((hash >> 16) & 0xFF) / 255 * 0.25; // 寬度倍率 0.85~1.1
    // 讓煙囪底部位於牆頂 topY（伸進屋頂內），頂端超出屋頂頂點 0.55
    // 這樣即便屋頂角落低於頂點，煙囪從內部「長出」仍密接不懸浮
    const effH = 0.6 * hMult;
    insts.push({
      x: cell.center[0],
      y: topY + effH / 2,
      z: cell.center[1],
      rotY: (((hash >> 24) & 0xFF) / 256) * Math.PI * 2,
      sx: wMult, sy: hMult, sz: wMult,
    });
    }
  }
  if (!insts.length) return;
  chimneyInstMesh = new THREE.InstancedMesh(_chimneyGeom, _chimneyMat, insts.length);
  chimneyInstMesh.castShadow = true;
  chimneyInstMesh.receiveShadow = false;
  const tmp = new THREE.Object3D();
  for (let i = 0; i < insts.length; i++) {
    tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
    tmp.rotation.set(0, insts[i].rotY, 0);
    tmp.scale.set(insts[i].sx, insts[i].sy, insts[i].sz);
    tmp.updateMatrix();
    chimneyInstMesh.setMatrixAt(i, tmp.matrix);
  }
  chimneyInstMesh.instanceMatrix.needsUpdate = true;
  chimneysGroup.add(chimneyInstMesh);
}

// 窗戶：~55% 外露牆面中段貼一片暗色片
function buildWindows() {
  if (windowInstMesh) {
    windowsGroup.remove(windowInstMesh);
    windowInstMesh.dispose();
    windowInstMesh = null;
  }
  const insts = [];
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[lvl]) continue;
        // 地面層第一面（i==0）幾乎一定會放門 → 第 0 面跳過避免門+窗重疊
        const isDoorWall = (lvl === 0 && i === 0);
        const a = cell.verts[i];
        const b = cell.verts[(i + 1) % cell.vertIdx.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const elen = Math.hypot(dx, dz);
        if (elen < 0.6) continue;  // 邊太短不放窗
        const nx = -dz / elen, nz = dx / elen;
        const y = lvl * BLOCK_HEIGHT + 0.5;
        // 長牆 (>1.4) 放 2 扇等距，短/中牆 1 扇置中
        const winCount = elen > 1.4 ? 2 : 1;
        // 地面層門牆：減 1（門已佔用中央）
        const effective = isDoorWall ? Math.max(0, winCount - 1) : winCount;
        for (let k = 0; k < effective; k++) {
          // 兩扇時放 1/3 與 2/3；一扇時放 1/2
          const t = winCount === 2 ? (0.33 + k * 0.34) : 0.5;
          const px = a[0] + dx * t;
          const pz = a[1] + dz * t;
          insts.push({
            x: px + nx * 0.012,
            y,
            z: pz + nz * 0.012,
            rotY: Math.atan2(nx, nz),
          });
        }
      }
    }
  }
  if (!insts.length) return;
  windowInstMesh = new THREE.InstancedMesh(_windowGeom, _windowMat, insts.length);
  windowInstMesh.castShadow = false;
  windowInstMesh.receiveShadow = false;
  const tmp = new THREE.Object3D();
  for (let i = 0; i < insts.length; i++) {
    tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
    tmp.rotation.set(0, insts[i].rotY, 0);
    tmp.updateMatrix();
    windowInstMesh.setMatrixAt(i, tmp.matrix);
  }
  windowInstMesh.instanceMatrix.needsUpdate = true;
  windowsGroup.add(windowInstMesh);
}

// 牆角柱：每個 cell 頂點一根立柱，高度為該頂點接觸到的 cell 最大層數
// 每根柱的顏色是主 block 色的深色版（timber frame 感）
function buildCornerPosts() {
  if (cornerPostsMesh) {
    cornerPostsGroup.remove(cornerPostsMesh);
    cornerPostsMesh.dispose();
    cornerPostsMesh = null;
  }
  // 收集每個 vertIdx 的最大高度與代表色
  const vmax = new Map();   // vertIdx → maxBlocks
  const vcolor = new Map(); // vertIdx → PALETTE index
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    for (const vidx of cell.vertIdx) {
      const cur = vmax.get(vidx) || 0;
      if (cell.blocks.length > cur) {
        vmax.set(vidx, cell.blocks.length);
        vcolor.set(vidx, cell.blocks[cell.blocks.length - 1].color);
      }
    }
  }
  if (!vmax.size) return;
  const insts = [];
  for (const [vidx, h] of vmax) {
    // 取得頂點世界座標（透過任一含有此點的 cell）
    const cid = vertexToCells.get(vidx).values().next().value;
    const cell = cells[cid];
    const posIdx = cell.vertIdx.indexOf(vidx);
    const xz = cell.verts[posIdx];
    insts.push({
      x: xz[0], y: (h * BLOCK_HEIGHT) / 2, z: xz[1],
      sy: h * BLOCK_HEIGHT,
      colorIdx: vcolor.get(vidx),
    });
  }
  const mat = _postMat.clone();
  cornerPostsMesh = new THREE.InstancedMesh(_postGeom, mat, insts.length);
  cornerPostsMesh.castShadow = true;
  cornerPostsMesh.receiveShadow = true;
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < insts.length; i++) {
    tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
    tmp.scale.set(1, insts[i].sy, 1);
    tmp.updateMatrix();
    cornerPostsMesh.setMatrixAt(i, tmp.matrix);
    // 深色版：乘以 0.55
    col.set(PALETTE[insts[i].colorIdx]).multiplyScalar(0.55);
    cornerPostsMesh.setColorAt(i, col);
  }
  cornerPostsMesh.instanceMatrix.needsUpdate = true;
  if (cornerPostsMesh.instanceColor) cornerPostsMesh.instanceColor.needsUpdate = true;
  cornerPostsGroup.add(cornerPostsMesh);
}

// 牆腳 + 牆簷：水平裝飾帶，沿所有外露牆擠出一道 0.08 高的外凸條
const _plinthMat = new THREE.MeshStandardMaterial({
  color: 0x878078, roughness: 0.92, metalness: 0, flatShading: true,
});
const _corniceMat = new THREE.MeshStandardMaterial({
  color: 0xd6c9a8, roughness: 0.88, metalness: 0, flatShading: true,
});
let plinthMesh = null, corniceMesh = null;

function buildWallTrim() {
  if (plinthMesh) { wallTrimGroup.remove(plinthMesh); plinthMesh.geometry.dispose(); plinthMesh = null; }
  if (corniceMesh) { wallTrimGroup.remove(corniceMesh); corniceMesh.geometry.dispose(); corniceMesh = null; }

  const PL_H = 0.10;        // plinth 高度
  const PL_OUT = 0.04;      // plinth 外凸
  const CR_H = 0.08;        // cornice 高度
  const CR_OUT = 0.045;     // cornice 外凸

  const plPos = [], plNrm = [], plIdx = [];
  const crPos = [], crNrm = [], crIdx = [];

  // 本函式產生 trim box 的 outer + top + bottom 三面
  function pushTrim(posArr, nrmArr, idxArr, ax, az, bx, bz, y0, y1, outOff) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const nx = -dz / len, nz = dx / len;       // CW polygon outward
    const ax2 = ax + nx * outOff, az2 = az + nz * outOff;
    const bx2 = bx + nx * outOff, bz2 = bz + nz * outOff;

    const base = posArr.length / 3;
    // === Outer face (4 頂點) ===
    // a_o(y0), b_o(y0), b_o(y1), a_o(y1)
    posArr.push(ax2, y0, az2, bx2, y0, bz2, bx2, y1, bz2, ax2, y1, az2);
    for (let k = 0; k < 4; k++) nrmArr.push(nx, 0, nz);
    idxArr.push(base, base + 1, base + 2, base, base + 2, base + 3);

    // === Top face (4 頂點) ===
    const topB = posArr.length / 3;
    posArr.push(ax, y1, az, bx, y1, bz, bx2, y1, bz2, ax2, y1, az2);
    for (let k = 0; k < 4; k++) nrmArr.push(0, 1, 0);
    idxArr.push(topB, topB + 2, topB + 1, topB, topB + 3, topB + 2);

    // === Bottom face (4 頂點) ===
    const botB = posArr.length / 3;
    posArr.push(ax, y0, az, bx, y0, bz, bx2, y0, bz2, ax2, y0, az2);
    for (let k = 0; k < 4; k++) nrmArr.push(0, -1, 0);
    idxArr.push(botB, botB + 1, botB + 2, botB, botB + 2, botB + 3);
  }

  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    const topLv = cell.blocks.length - 1;
    const topY = (topLv + 1) * BLOCK_HEIGHT;
    const N = cell.vertIdx.length;
    for (let i = 0; i < N; i++) {
      const nb = cell.neighbors[i];
      const a = cell.verts[i], b = cell.verts[(i + 1) % N];
      // Plinth 條件：level 0 此邊外露（鄰格 level 0 沒方塊）
      const vis0 = !(nb !== null && cells[nb].blocks[0]);
      if (vis0) {
        pushTrim(plPos, plNrm, plIdx, a[0], a[1], b[0], b[1], 0, PL_H, PL_OUT);
      }
      // Cornice 條件：最頂層此邊外露
      const visTop = !(nb !== null && cells[nb].blocks[topLv]);
      if (visTop) {
        pushTrim(crPos, crNrm, crIdx, a[0], a[1], b[0], b[1], topY - CR_H, topY, CR_OUT);
      }
    }
  }

  if (plIdx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(plPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(plNrm, 3));
    g.setIndex(plIdx);
    g.computeBoundingSphere();
    plinthMesh = new THREE.Mesh(g, _plinthMat);
    plinthMesh.castShadow = true;
    plinthMesh.receiveShadow = true;
    wallTrimGroup.add(plinthMesh);
  }
  if (crIdx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(crPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(crNrm, 3));
    g.setIndex(crIdx);
    g.computeBoundingSphere();
    corniceMesh = new THREE.Mesh(g, _corniceMat);
    corniceMesh.castShadow = true;
    corniceMesh.receiveShadow = true;
    wallTrimGroup.add(corniceMesh);
  }
}

// 門：拱形幾何（LOCAL 平面，向 +Z 面）
const _doorGeom = (() => {
  const w = 0.38, hRect = 0.42, hArch = 0.22;
  const r = w / 2;
  const SEG = 10;
  const pts = [];
  pts.push([-r, 0]);
  pts.push([-r, hRect]);
  for (let i = 1; i < SEG; i++) {
    const a = Math.PI - (Math.PI * i / SEG);
    pts.push([r * Math.cos(a), hRect + hArch * Math.sin(a)]);
  }
  pts.push([r, hRect]);
  pts.push([r, 0]);
  // Fan triangulation from interior (0, hRect/2)
  const cx = 0, cy = hRect / 2;
  const positions = [cx, cy, 0];
  for (const p of pts) positions.push(p[0], p[1], 0);
  const indices = [];
  for (let i = 0; i < pts.length; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % pts.length);
    // CCW：底邊 b 跟 a 順序對於 front face 而言
    indices.push(0, a, b);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
})();
const _doorMat = new THREE.MeshStandardMaterial({
  color: 0x1c1a1f, roughness: 0.55, metalness: 0.25,
});
let doorInstMesh = null;

function buildDoors() {
  if (doorInstMesh) {
    doorsGroup.remove(doorInstMesh);
    doorInstMesh.dispose();
    doorInstMesh = null;
  }
  const insts = [];
  // 改成「整棟一道門」：每棟建築收集所有外露 level 0 邊，挑最長的那段放門
  // 大棟建築允許 1~2 道（每 6 cell + 1 道）
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    const visEdges = [];
    for (const cid of cellIds) {
      const cell = cells[cid];
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[0]) continue;
        const a = cell.verts[i], b = cell.verts[(i + 1) % cell.vertIdx.length];
        const elen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (elen < 0.55) continue;
        visEdges.push({ a, b, elen });
      }
    }
    if (!visEdges.length) continue;
    // 挑最長的；大棟建築允許多道
    visEdges.sort((x, y) => y.elen - x.elen);
    const doorCount = Math.min(visEdges.length, 1 + Math.floor(cellIds.length / 6));
    for (let k = 0; k < doorCount; k++) {
      const e = visEdges[k];
      const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1];
      const elen = e.elen;
      const nx = -dz / elen, nz = dx / elen;
      const midX = (e.a[0] + e.b[0]) / 2;
      const midZ = (e.a[1] + e.b[1]) / 2;
      insts.push({
        x: midX + nx * 0.008,
        y: 0,
        z: midZ + nz * 0.008,
        rotY: Math.atan2(nx, nz),
      });
    }
  }
  if (!insts.length) return;
  doorInstMesh = new THREE.InstancedMesh(_doorGeom, _doorMat, insts.length);
  doorInstMesh.castShadow = false;
  doorInstMesh.receiveShadow = false;
  const tmp = new THREE.Object3D();
  for (let i = 0; i < insts.length; i++) {
    tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
    tmp.rotation.set(0, insts[i].rotY, 0);
    tmp.updateMatrix();
    doorInstMesh.setMatrixAt(i, tmp.matrix);
  }
  doorInstMesh.instanceMatrix.needsUpdate = true;
  doorsGroup.add(doorInstMesh);
}

// 老虎窗：兩個 InstancedMesh — 牆體 box + 屋頂 pyramid + 窗戶 plane
// 牆體
const _dormerBodyGeom = new THREE.BoxGeometry(0.34, 0.32, 0.26);
const _dormerBodyMat = new THREE.MeshStandardMaterial({
  color: 0xc8b390, roughness: 0.85, metalness: 0, flatShading: true, vertexColors: true,
});
// 小屋頂（pyramid 簡化為扁 cone 4 面）
const _dormerRoofGeom = new THREE.ConeGeometry(0.24, 0.2, 4);
const _dormerRoofMat = new THREE.MeshStandardMaterial({
  color: 0xa05a4a, roughness: 0.85, metalness: 0, flatShading: true,
});
// 窗戶（共用建物的 _windowGeom + _windowMat）
let dormerBodyMesh = null, dormerRoofMesh = null, dormerWinMesh = null;

function buildDormers() {
  if (dormerBodyMesh) { dormersGroup.remove(dormerBodyMesh); dormerBodyMesh.dispose(); dormerBodyMesh = null; }
  if (dormerRoofMesh) { dormersGroup.remove(dormerRoofMesh); dormerRoofMesh.dispose(); dormerRoofMesh = null; }
  if (dormerWinMesh) { dormersGroup.remove(dormerWinMesh); dormerWinMesh.dispose(); dormerWinMesh = null; }
  const insts = [];
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    if (cellIds.length < 4) continue;  // 只在中大型建築出現
    // 建築屋頂高度
    const roofH = cellIds.length <= 5 ? 0.55 : 0.42;
    for (const cid of cellIds) {
      const cell = cells[cid];
      const lvl = cell.blocks.length - 1;
      // 條件：所有鄰格皆為建築（landlocked），代表此 cell 屋頂大致連通
      let landlocked = true;
      for (const nb of cell.neighbors) {
        if (nb === null || cells[nb].blocks.length === 0) { landlocked = false; break; }
      }
      if (!landlocked) continue;
      const h = ((cell.id * 1597463007 + 919) >>> 0);
      if ((h % 100) >= 60) continue;
      // 找一條面對「外圍」的邊：邊的某一頂點靠近 region 邊界
      // 簡化：取 hash 選邊
      const N = cell.vertIdx.length;
      const ei = h % N;
      const a = cell.verts[ei], b = cell.verts[(ei + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const elen = Math.hypot(dx, dz);
      const inx = dz / elen;       // CW polygon: 向內
      const inz = -dx / elen;
      const outX = -inx, outZ = -inz;
      const midX = (a[0] + b[0]) / 2;
      const midZ = (a[1] + b[1]) / 2;
      // dormer 位置：邊中點微微往內 0.18，避免邊緣懸空
      const dxPos = midX + inx * 0.18;
      const dzPos = midZ + inz * 0.18;
      const topY = (lvl + 1) * BLOCK_HEIGHT;
      const baseY = topY + roofH;     // 平台高度
      const rotY = Math.atan2(outX, outZ);
      // 從 palette 取色（牆體混用 cell 的 block color，屋頂固定深紅）
      insts.push({
        x: dxPos, y: baseY, z: dzPos, rotY,
        colorIdx: cell.blocks[lvl].color,
      });
    }
  }
  if (!insts.length) return;
  dormerBodyMesh = new THREE.InstancedMesh(_dormerBodyGeom, _dormerBodyMat, insts.length);
  dormerBodyMesh.castShadow = true;
  dormerBodyMesh.receiveShadow = true;
  dormerRoofMesh = new THREE.InstancedMesh(_dormerRoofGeom, _dormerRoofMat, insts.length);
  dormerRoofMesh.castShadow = true;
  dormerWinMesh = new THREE.InstancedMesh(_windowGeom, _windowMat, insts.length);
  dormerWinMesh.castShadow = false;
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  const BODY_H = 0.32, ROOF_H = 0.2;
  for (let i = 0; i < insts.length; i++) {
    const d = insts[i];
    // body：base + BODY_H/2
    tmp.position.set(d.x, d.y + BODY_H / 2, d.z);
    tmp.rotation.set(0, d.rotY, 0);
    tmp.scale.set(1, 1, 1);
    tmp.updateMatrix();
    dormerBodyMesh.setMatrixAt(i, tmp.matrix);
    col.set(PALETTE[d.colorIdx]).multiplyScalar(1.05);  // 比建築亮一點，做為「飾邊」感
    dormerBodyMesh.setColorAt(i, col);
    // roof：base + BODY_H + ROOF_H/2，cone 預設尖端朝 +Y，rotY 對齊牆面方位
    // ConeGeometry 4 面要 +π/4 旋轉讓四個面對齊邊向
    tmp.position.set(d.x, d.y + BODY_H + ROOF_H / 2, d.z);
    tmp.rotation.set(0, d.rotY + Math.PI / 4, 0);
    tmp.updateMatrix();
    dormerRoofMesh.setMatrixAt(i, tmp.matrix);
    // window：在 body 朝外面（+Z 方向）+ 0.135 + 0.005，y 在 body 中央
    const wOff = 0.13 + 0.005;
    const wx = d.x + Math.sin(d.rotY) * wOff;
    const wz = d.z + Math.cos(d.rotY) * wOff;
    tmp.position.set(wx, d.y + BODY_H / 2, wz);
    tmp.rotation.set(0, d.rotY, 0);
    tmp.updateMatrix();
    dormerWinMesh.setMatrixAt(i, tmp.matrix);
  }
  dormerBodyMesh.instanceMatrix.needsUpdate = true;
  if (dormerBodyMesh.instanceColor) dormerBodyMesh.instanceColor.needsUpdate = true;
  dormerRoofMesh.instanceMatrix.needsUpdate = true;
  dormerWinMesh.instanceMatrix.needsUpdate = true;
  dormersGroup.add(dormerBodyMesh);
  dormersGroup.add(dormerRoofMesh);
  dormersGroup.add(dormerWinMesh);
}

// 樹：矮柱幹 + 錐形樹冠
const _trunkGeom = new THREE.CylinderGeometry(0.06, 0.09, 0.38, 6);
const _trunkMat = new THREE.MeshStandardMaterial({
  color: 0x4a3528, roughness: 0.95, metalness: 0, flatShading: true,
});
const _crownGeom = new THREE.ConeGeometry(0.3, 0.75, 7);
const _crownMat = new THREE.MeshStandardMaterial({
  color: 0x4f8a52, roughness: 0.85, metalness: 0, flatShading: true,
});
let trunkInstMesh = null, crownInstMesh = null;

function buildTrees() {
  if (trunkInstMesh) {
    treesGroup.remove(trunkInstMesh);
    trunkInstMesh.dispose();
    trunkInstMesh = null;
  }
  if (crownInstMesh) {
    treesGroup.remove(crownInstMesh);
    crownInstMesh.dispose();
    crownInstMesh = null;
  }
  const insts = [];
  // 收集所有空格周邊方塊密度，降低「孤島樹」，偏好靠近建築的空地
  for (const cell of cells) {
    if (cell.blocks.length > 0) continue;
    // 18 = 不規則 mask 的最大可能外延範圍上限（半徑 ~13 + 形狀延伸）
    if (Math.hypot(cell.center[0], cell.center[1]) > 18) continue;
    const hash = ((cell.id * 1103515245 + 12345) >>> 0);
    // 鄰格建築數量
    const nbBlocks = cell.neighbors.reduce((s, n) => s + (n !== null && cells[n].blocks.length > 0 ? 1 : 0), 0);
    // 完整環境檢查：含 vertex 共用的所有 cell
    let surroundedBuilt = 0;
    for (const vi of cell.vertIdx) {
      const cellsAtV = vertexToCells.get(vi);
      if (!cellsAtV) continue;
      for (const cid of cellsAtV) {
        if (cid !== cell.id && cells[cid].blocks.length > 0) {
          surroundedBuilt++;
          break;
        }
      }
    }
    // 多鄰居建築（>= 3 個 vertex 被環繞）→ 不長樹（避免擠在縫裡）
    if (surroundedBuilt >= 3) continue;
    const chance = nbBlocks > 0 ? 18 : 3;
    if ((hash % 100) >= chance) continue;
    let s = 0.78 + (((hash >> 7) & 0x3F) / 63) * 0.5;  // 0.78 - 1.28
    // 鄰居有建築 → 強制縮小，避免樹冠（半徑 0.3 × s）戳到牆
    if (surroundedBuilt > 0) s = Math.min(s, 0.7);
    const rotY = ((hash >> 13) & 0xFF) / 256 * Math.PI * 2;
    // 鄰居有建築 → 完全置中
    const off = surroundedBuilt > 0 ? 0 : 0.18;
    const ox = (((hash >> 21) & 0x1F) / 31 - 0.5) * off;
    const oz = (((hash >> 26) & 0x1F) / 31 - 0.5) * off;
    const tx = cell.center[0] + ox;
    const tz = cell.center[1] + oz;
    // 嚴格碰撞檢查：樹冠半徑 0.3*s + 0.02 安全餘量
    if (overlapsBuildingXZ(tx, tz, 0.3 * s + 0.02)) continue;
    insts.push({ x: tx, y: 0, z: tz, rotY, s });
  }
  if (!insts.length) return;
  trunkInstMesh = new THREE.InstancedMesh(_trunkGeom, _trunkMat, insts.length);
  crownInstMesh = new THREE.InstancedMesh(_crownGeom, _crownMat, insts.length);
  trunkInstMesh.castShadow = true;
  crownInstMesh.castShadow = true;
  const tmp = new THREE.Object3D();
  for (let i = 0; i < insts.length; i++) {
    const d = insts[i];
    // 樹幹中心在高度 0.19*s
    tmp.position.set(d.x, 0.19 * d.s, d.z);
    tmp.rotation.set(0, d.rotY, 0);
    tmp.scale.set(d.s, d.s, d.s);
    tmp.updateMatrix();
    trunkInstMesh.setMatrixAt(i, tmp.matrix);
    // 樹冠中心在 0.38 + 0.375 = 0.755，乘 s
    tmp.position.set(d.x, 0.755 * d.s, d.z);
    tmp.updateMatrix();
    crownInstMesh.setMatrixAt(i, tmp.matrix);
  }
  trunkInstMesh.instanceMatrix.needsUpdate = true;
  crownInstMesh.instanceMatrix.needsUpdate = true;
  treesGroup.add(trunkInstMesh);
  treesGroup.add(crownInstMesh);
}

// === 地面細節：草叢、花、石頭 ===
const _grassGeom = new THREE.ConeGeometry(0.06, 0.14, 5);
const _grassMat = new THREE.MeshStandardMaterial({
  color: 0x6ea958, roughness: 0.95, metalness: 0, flatShading: true,
});
const _flowerGeom = new THREE.ConeGeometry(0.05, 0.12, 5);
const _flowerMats = [
  new THREE.MeshStandardMaterial({ color: 0xd94a6a, roughness: 0.8, metalness: 0.1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xefc94c, roughness: 0.8, metalness: 0.1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xf0e5d3, roughness: 0.8, metalness: 0.1, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0xc258a2, roughness: 0.8, metalness: 0.1, flatShading: true }),
];
const _rockGeom = new THREE.DodecahedronGeometry(0.12, 0);
const _rockMat = new THREE.MeshStandardMaterial({
  color: 0x9a9388, roughness: 0.98, metalness: 0, flatShading: true,
});

let grassInstMesh = null;
let flowerInstMeshes = [];
let rockInstMesh = null;

function buildGroundDetails() {
  if (grassInstMesh) {
    groundDetailsGroup.remove(grassInstMesh);
    grassInstMesh.dispose();
    grassInstMesh = null;
  }
  for (const m of flowerInstMeshes) { groundDetailsGroup.remove(m); m.dispose(); }
  flowerInstMeshes = [];
  if (rockInstMesh) {
    groundDetailsGroup.remove(rockInstMesh);
    rockInstMesh.dispose();
    rockInstMesh = null;
  }

  const grassInst = [];
  const flowerByColor = [[], [], [], []];
  const rockInst = [];

  for (const cell of cells) {
    if (cell.blocks.length > 0) continue;
    const dist = Math.hypot(cell.center[0], cell.center[1]);
    if (dist > 18) continue;  // 不規則 mask 的外延上限
    const nbBlocks = cell.neighbors.reduce((s, n) => s + (n !== null && cells[n].blocks.length > 0 ? 1 : 0), 0);
    // 多個 hash 位元決定不同裝飾類型，互不衝突
    const h = ((cell.id * 2246822519 + 3266489917) >>> 0);
    const hGrass = (h & 0xFF);
    const hFlow = ((h >> 8) & 0xFF);
    const hRock = ((h >> 16) & 0xFF);

    // 鄰居感知：頂點是 3~4 cell 共用，要查所有共用該頂點的 cell 才完整
    const vertIsNearBuilt = (vi) => {
      const vidx = cell.vertIdx[vi];
      const cellsAtV = vertexToCells.get(vidx);
      if (!cellsAtV) return false;
      for (const cid of cellsAtV) {
        if (cid === cell.id) continue;
        if (cells[cid].blocks.length > 0) return true;
      }
      return false;
    };

    // 草叢：密度大幅下調，避免一片密林
    const grassChance = nbBlocks > 0 ? 55 : (dist < 8 ? 28 : 12);
    if ((hGrass % 100) < grassChance) {
      const count = 1 + ((h >> 2) & 0x3);  // 1~4
      for (let k = 0; k < count; k++) {
        const hk = ((h + k * 2654435761) >>> 0);
        const vi = hk % cell.verts.length;
        const v = cell.verts[vi];
        // 若該頂點靠建築牆邊 → alpha 至少 0.6（往中心縮），否則正常 0.25
        const alphaMin = vertIsNearBuilt(vi) ? 0.62 : 0.25;
        const alphaMax = 0.85;
        const alpha = alphaMin + ((hk >> 5) & 0x3F) / 63 * (alphaMax - alphaMin);
        const px = v[0] * (1 - alpha) + cell.center[0] * alpha;
        const pz = v[1] * (1 - alpha) + cell.center[1] * alpha;
        const s = 0.7 + ((hk >> 11) & 0x1F) / 31 * 0.7;
        const rotY = ((hk >> 16) & 0xFF) / 256 * Math.PI * 2;
        // 嚴格碰撞：草叢半徑約 0.08*s
        if (overlapsBuildingXZ(px, pz, 0.08 * s + 0.02)) continue;
        grassInst.push({ x: px, y: 0.07 * s, z: pz, s, rotY });
      }
    }

    // 花：同樣依頂點狀況調整
    const flowerChance = nbBlocks > 0 ? 22 : 10;
    if ((hFlow % 100) < flowerChance) {
      const colorIdx = hFlow % 4;
      const vi = (hFlow >> 2) % cell.verts.length;
      const v = cell.verts[vi];
      const alphaMin = vertIsNearBuilt(vi) ? 0.65 : 0.4;
      const alpha = alphaMin + ((hFlow >> 4) & 0xF) / 15 * 0.3;
      const px = v[0] * (1 - alpha) + cell.center[0] * alpha;
      const pz = v[1] * (1 - alpha) + cell.center[1] * alpha;
      const s = 0.8 + ((hFlow >> 8) & 0x1F) / 31 * 0.4;
      // 嚴格碰撞：花半徑約 0.06*s
      if (overlapsBuildingXZ(px, pz, 0.06 * s + 0.02)) ; else
      flowerByColor[colorIdx].push({ x: px, y: 0.06 * s, z: pz, s, rotY: 0 });
    }

    // 石頭：更少，只在外圈偶爾出現
    const rockChance = dist > 7 ? 10 : 4;
    if ((hRock % 100) < rockChance) {
      const s = 0.7 + ((hRock >> 3) & 0x1F) / 31 * 0.8;
      // 嚴格碰撞：石頭半徑約 0.12*s
      if (overlapsBuildingXZ(cell.center[0], cell.center[1], 0.12 * s + 0.02)) continue;
      rockInst.push({
        x: cell.center[0],
        y: 0.06 * s,
        z: cell.center[1],
        s,
        rotY: ((hRock >> 10) & 0xFF) / 256 * Math.PI * 2,
        rotX: ((hRock >> 18) & 0xFF) / 256 * 0.6,
      });
    }
  }

  const tmp = new THREE.Object3D();
  if (grassInst.length) {
    grassInstMesh = new THREE.InstancedMesh(_grassGeom, _grassMat, grassInst.length);
    grassInstMesh.castShadow = false;
    grassInstMesh.receiveShadow = true;
    for (let i = 0; i < grassInst.length; i++) {
      const d = grassInst[i];
      tmp.position.set(d.x, d.y, d.z);
      tmp.rotation.set(0, d.rotY, 0);
      tmp.scale.set(d.s, d.s, d.s);
      tmp.updateMatrix();
      grassInstMesh.setMatrixAt(i, tmp.matrix);
    }
    grassInstMesh.instanceMatrix.needsUpdate = true;
    groundDetailsGroup.add(grassInstMesh);
  }
  for (let c = 0; c < 4; c++) {
    const arr = flowerByColor[c];
    if (!arr.length) continue;
    const mesh = new THREE.InstancedMesh(_flowerGeom, _flowerMats[c], arr.length);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      tmp.position.set(d.x, d.y, d.z);
      tmp.rotation.set(0, d.rotY, 0);
      tmp.scale.set(d.s, d.s, d.s);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    flowerInstMeshes.push(mesh);
    groundDetailsGroup.add(mesh);
  }
  if (rockInst.length) {
    rockInstMesh = new THREE.InstancedMesh(_rockGeom, _rockMat, rockInst.length);
    rockInstMesh.castShadow = true;
    rockInstMesh.receiveShadow = true;
    for (let i = 0; i < rockInst.length; i++) {
      const d = rockInst[i];
      tmp.position.set(d.x, d.y, d.z);
      tmp.rotation.set(d.rotX, d.rotY, 0);
      tmp.scale.set(d.s, d.s * 0.7, d.s);  // 稍扁平
      tmp.updateMatrix();
      rockInstMesh.setMatrixAt(i, tmp.matrix);
    }
    rockInstMesh.instanceMatrix.needsUpdate = true;
    groundDetailsGroup.add(rockInstMesh);
  }
}

// 預先收集「外牆段」用於碰撞檢查（已蓋格 × 鄰格非建築的邊）
let _exteriorWalls = [];  // flat array: [ax, az, bx, bz, ax, az, bx, bz, ...]
function rebuildExteriorWalls() {
  _exteriorWalls.length = 0;
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    for (let i = 0; i < cell.vertIdx.length; i++) {
      const nb = cell.neighbors[i];
      if (nb !== null && cells[nb].blocks.length > 0) continue;  // 內部牆，看不見
      const a = cell.verts[i];
      const b = cell.verts[(i + 1) % cell.vertIdx.length];
      _exteriorWalls.push(a[0], a[1], b[0], b[1]);
    }
  }
}

// 點 (x,z) 與所有外牆的最短距離 < radius → 視為重疊
function overlapsBuildingXZ(x, z, radius) {
  const r2 = radius * radius;
  for (let i = 0; i < _exteriorWalls.length; i += 4) {
    const ax = _exteriorWalls[i], az = _exteriorWalls[i + 1];
    const bx = _exteriorWalls[i + 2], bz = _exteriorWalls[i + 3];
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq < 1e-9 ? 0 : ((x - ax) * dx + (z - az) * dz) / lenSq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + t * dx, cz = az + t * dz;
    const ex = x - cx, ez = z - cz;
    if (ex * ex + ez * ez < r2) return true;
  }
  return false;
}

function refreshDecorations() {
  rebuildBuildings();
  rebuildExteriorWalls();
  buildBaseGridLines();
  buildStairs();
  buildChimneys();
  buildWindows();
  buildCornerPosts();
  buildWallTrim();
  buildDoors();
  buildDormers();
  buildTrees();
  buildGroundDetails();
}

// ===== 裝飾刷新節流：合併連續操作到下一個 RAF =====
// 立即必要：rebuildBuildings + 受影響 cells 的 rebuildColumn（在 addBlock 中已執行）
// 可延後：所有 instanced decorations + base grid lines
// 連點放方塊時節省 ~5ms × N 的同步重建累積
let _decorPending = false;
function scheduleDecorRefresh() {
  if (_decorPending) return;
  _decorPending = true;
  requestAnimationFrame(() => {
    _decorPending = false;
    rebuildExteriorWalls();
    buildBaseGridLines();
    buildStairs();
    buildChimneys();
    buildWindows();
    buildCornerPosts();
    buildWallTrim();
    buildDoors();
    buildDormers();
    buildTrees();
    buildGroundDetails();
  });
}

// Procedural shader：屋頂瓦片圓點 + 牆面水平木紋
// 透過 onBeforeCompile hook 注入到所有 block materials
function injectBlockShader(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTileScale = { value: 4.8 };
    shader.uniforms.uTileStrength = { value: 0.24 };
    shader.uniforms.uPlankScale = { value: 4.2 };
    shader.uniforms.uPlankStrength = { value: 0.10 };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWPos;'
    ).replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvWPos = worldPosition.xyz;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform float uTileScale;
       uniform float uTileStrength;
       uniform float uPlankScale;
       uniform float uPlankStrength;
       varying vec3 vWPos;`
    ).replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       // 用 world-space derivatives 推 face normal（因為 flatShading 用不到 vNormal）
       vec3 fdxW = dFdx(vWPos);
       vec3 fdyW = dFdy(vWPos);
       vec3 wN = normalize(cross(fdxW, fdyW));

       // === 屋頂：交錯排列圓點瓦片 ===
       float roofW = smoothstep(0.25, 0.55, wN.y);
       if (roofW > 0.0) {
         vec2 t = vWPos.xz * uTileScale;
         // 每隔一行橫向偏移半格，做出磚面般的錯位
         if (mod(floor(t.y), 2.0) > 0.5) t.x += 0.5;
         vec2 local = fract(t) - 0.5;
         float d = length(local);
         float dot = smoothstep(0.44, 0.28, d);
         diffuseColor.rgb *= (1.0 - dot * uTileStrength * roofW);
       }

       // === 牆面：水平細條紋（木板/磚縫感） ===
       float wallW = smoothstep(0.30, 0.12, abs(wN.y));
       if (wallW > 0.0) {
         float stripe = fract(vWPos.y * uPlankScale);
         // 靠近每個整數位置壓暗（板與板之間的縫）
         float gap = smoothstep(0.0, 0.06, stripe) * smoothstep(1.0, 0.94, stripe);
         diffuseColor.rgb *= (1.0 - (1.0 - gap) * uPlankStrength * wallW);
       }
      `
    );
  };
  mat.needsUpdate = true;
  return mat;
}

const blockMaterials = PALETTE.map(c => {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(c),
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    vertexColors: true,
  });
  return injectBlockShader(mat);
});

function shouldHaveRoof(cell, level) {
  // 同層沒有任何鄰居 → 視為孤立，蓋尖屋頂
  for (const nb of cell.neighbors) {
    if (nb !== null && cells[nb].blocks[level]) return false;
  }
  return true;
}

const columnMeshes = new Map();

function rebuildColumn(cellId) {
  const cell = cells[cellId];
  const old = columnMeshes.get(cellId);
  if (old) {
    cellGroup.remove(old);
    old.geometry.dispose();
    columnMeshes.delete(cellId);
  }
  if (!cell.blocks.length) return;

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const faceMeta = [];
  const colorGroups = PALETTE.map(() => []);

  const verts = cell.verts;
  const N = verts.length;
  const cx = cell.center[0];
  const cz = cell.center[1];

  // 幾何常數
  const ROOF_OVERHANG = 0.12;
  // 屋頂高度依建築規模動態調整：小屋尖、大棟扁
  // 1~2 cell → 0.65（尖塔感）；3~5 → 0.55（標準）；6+ → 0.42（低斜頂）
  const _bid = buildingId.get(cell.id);
  const _bsize = (_bid != null) ? buildingCells[_bid].length : 1;
  const ROOF_HEIGHT = _bsize <= 2 ? 0.65 : (_bsize <= 5 ? 0.55 : 0.42);

  // 頂點 AO 灰階（之後乘以每塊獨立的 tint）
  const AO_WALL_CORNER = 0.72;
  const AO_WALL_MID = 0.98;
  const AO_TOP_CORNER = 0.85;
  const AO_TOP_CENTER = 1.0;
  const AO_ROOF_BASE = 0.80;
  const AO_ROOF_APEX = 1.05;
  const AO_BOTTOM = 0.55;

  let vertBase = 0;
  let triBase = 0;

  // 整棟共享一個基底色偏：同一棟建築內的方塊看起來一致
  const bid = buildingId.get(cell.id) ?? 0;
  const baseTint = buildingTint(bid);
  for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
    const block = cell.blocks[lvl];
    // 每塊在棟基底上再 ±2% 微擾（多層次有些變化但不打破整體）
    const lh = ((cell.id * 7919 + lvl * 6427) >>> 0);
    const tint = [
      baseTint[0] * (1 + (((lh & 0x7F) / 127) - 0.5) * 0.04),
      baseTint[1] * (1 + ((((lh >> 7) & 0x7F) / 127) - 0.5) * 0.04),
      baseTint[2] * (1 + ((((lh >> 14) & 0x7F) / 127) - 0.5) * 0.04),
    ];
    const pushColor = (ao) => colors.push(ao * tint[0], ao * tint[1], ao * tint[2]);

    const y0 = lvl * BLOCK_HEIGHT;
    const y1 = y0 + BLOCK_HEIGHT;
    const isTop = lvl === cell.blocks.length - 1;

    // 側面：每道邊拆成 2 個子 quad（水平中點細分），共 6 頂點 4 三角
    for (let i = 0; i < N; i++) {
      const nei = cell.neighbors[i];
      if (nei !== null && cells[nei].blocks[lvl]) continue;
      const a = verts[i];
      const b = verts[(i + 1) % N];
      const ax = a[0], az = a[1];
      const bx = b[0], bz = b[1];
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      const nx = -dz / len, nz = dx / len;
      positions.push(
        ax, y0, az, mx, y0, mz, bx, y0, bz,
        ax, y1, az, mx, y1, mz, bx, y1, bz,
      );
      for (let k = 0; k < 6; k++) normals.push(nx, 0, nz);
      pushColor(AO_WALL_CORNER);
      pushColor(AO_WALL_MID);
      pushColor(AO_WALL_CORNER);
      pushColor(AO_WALL_CORNER);
      pushColor(AO_WALL_MID);
      pushColor(AO_WALL_CORNER);
      // 左半：(0,1,4),(0,4,3)；右半：(1,2,5),(1,5,4)
      indices.push(
        vertBase + 0, vertBase + 1, vertBase + 4,
        vertBase + 0, vertBase + 4, vertBase + 3,
        vertBase + 1, vertBase + 2, vertBase + 5,
        vertBase + 1, vertBase + 5, vertBase + 4,
      );
      for (let k = 0; k < 4; k++) {
        colorGroups[block.color].push(triBase + k);
        faceMeta[triBase + k] = { type: 'side', level: lvl, edgeIdx: i };
      }
      vertBase += 6;
      triBase += 4;
    }

    // 最底層底面
    if (lvl === 0) {
      const startV = vertBase;
      for (let i = 0; i < N; i++) {
        positions.push(verts[i][0], 0, verts[i][1]);
        normals.push(0, -1, 0);
        pushColor(AO_BOTTOM);
      }
      vertBase += N;
      for (let i = 1; i < N - 1; i++) {
        indices.push(startV, startV + i + 1, startV + i);
        colorGroups[block.color].push(triBase);
        faceMeta[triBase] = { type: 'bottom', level: 0 };
        triBase += 1;
      }
    }

    if (isTop) {
      // 統一屋頂：依每個頂點是否為 region 內部決定高度
      // - 內部頂點：升高至 y1 + ROOF_HEIGHT（讓相鄰同層方塊的頂點在同高度，自動連成屋脊）
      // - 邊界頂點：維持 y1，並向外出挑形成屋簷
      // - 屋脊中心（cell centroid）：永遠升高
      // 效果：孤立 → 金字塔；線狀相鄰 → 山形頂；整片內部 → 抬高平台
      const baseStart = vertBase;
      // 每頂點用「內部度」權重做高度漸變：邊界(0)→逐步升高→region 中心(1)
      // 這讓多個 cell 連接成大屋頂時呈現平滑穹頂，而非一堆小金字塔
      const EAVE_DROOP = 0.02;  // 屋簷下垂量，蓋住牆頂接縫、避免 z-fighting
      let cellMaxW = 0;  // 此 cell 所有頂點的最大權重，用於決定 centroid 高度
      for (let i = 0; i < N; i++) {
        const vidx = cell.vertIdx[i];
        const w = vertexHeightWeight.get(vidx) ?? 0;
        if (w > cellMaxW) cellMaxW = w;
        let px = verts[i][0], pz = verts[i][1];
        const isStrictBoundary = vertexIsRegionBoundary.has(vidx);
        // 嚴格邊界頂點：維持 y1 並加出挑屋簷、微微下垂
        // 非邊界頂點：依 weight 抬升形成屋脊
        let py;
        if (isStrictBoundary) {
          py = y1 - EAVE_DROOP;
          const vdx = verts[i][0] - cx;
          const vdz = verts[i][1] - cz;
          const vlen = Math.hypot(vdx, vdz);
          if (vlen > 1e-4) {
            px += (vdx / vlen) * ROOF_OVERHANG;
            pz += (vdz / vlen) * ROOF_OVERHANG;
          }
        } else {
          py = y1 + Math.max(w, 0.25) * ROOF_HEIGHT;
        }
        positions.push(px, py, pz);
        normals.push(0, 1, 0);
        // AO 依權重漸變
        pushColor(AO_ROOF_BASE + (AO_TOP_CENTER - AO_ROOF_BASE) * w);
      }
      vertBase += N;
      // centroid apex 高度：
      // - 孤立 cell（cellMaxW ~ 0，所有頂點皆 region 邊界）→ 完整 1×ROOF_HEIGHT 形成尖金字塔
      // - 有內部頂點的 cell → 至少 0.7×ROOF_HEIGHT，且高於最高頂點 0.25，避免次邊界格 apex 平貼
      const apexW = cellMaxW < 0.01 ? 1 : Math.max(cellMaxW + 0.25, 0.7);
      positions.push(cx, y1 + Math.min(1, apexW) * ROOF_HEIGHT, cz);
      normals.push(0, 1, 0);
      pushColor(AO_ROOF_APEX);
      const apexIdx = vertBase;
      vertBase += 1;
      for (let i = 0; i < N; i++) {
        indices.push(baseStart + i, baseStart + (i + 1) % N, apexIdx);
        colorGroups[block.color].push(triBase);
        faceMeta[triBase] = { type: 'top', level: lvl };
        triBase += 1;
      }
    }
  }

  // 重新依顏色排序，建立 material groups
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const newIndices = [];
  const newFaceMeta = [];
  const groups = [];
  let offsetTri = 0;
  for (let c = 0; c < PALETTE.length; c++) {
    const list = colorGroups[c];
    if (!list.length) continue;
    const startTri = offsetTri;
    for (const ti of list) {
      newIndices.push(indices[ti * 3], indices[ti * 3 + 1], indices[ti * 3 + 2]);
      newFaceMeta[offsetTri] = faceMeta[ti];
      offsetTri += 1;
    }
    groups.push({ start: startTri * 3, count: (offsetTri - startTri) * 3, mat: c });
  }
  geom.setIndex(newIndices);
  for (const g of groups) geom.addGroup(g.start, g.count, g.mat);
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, blockMaterials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { type: 'column', cellId, faceMeta: newFaceMeta };
  cellGroup.add(mesh);
  columnMeshes.set(cellId, mesh);
}

function affectedCells(cellId) {
  const s = new Set([cellId]);
  for (const nb of cells[cellId].neighbors) if (nb !== null) s.add(nb);
  return s;
}

function rebuildAll() {
  for (const m of columnMeshes.values()) {
    cellGroup.remove(m);
    m.geometry.dispose();
  }
  columnMeshes.clear();
  for (const cell of cells) if (cell.blocks.length) rebuildColumn(cell.id);
  refreshDecorations();
}

refreshDecorations();
buildGroundPick();

// ===== 操作紀錄 =====
const history = [];
function snapshot() { return cells.map(c => c.blocks.map(b => ({ ...b }))); }
function restore(snap) {
  for (let i = 0; i < cells.length; i++) cells[i].blocks = snap[i].map(b => ({ ...b }));
  rebuildAll();
  updateFocus();
}
function pushHistory() {
  history.push(snapshot());
  if (history.length > 100) history.shift();
}

// ===== 互動 =====
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

function pick(x, y) {
  pointer.x = (x / window.innerWidth) * 2 - 1;
  pointer.y = -(y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const a = raycaster.intersectObjects(cellGroup.children, false);
  const b = raycaster.intersectObjects(groundPickGroup.children, false);
  const all = a.concat(b);
  all.sort((x, y) => x.distance - y.distance);
  return all[0] || null;
}

// 放置動畫：整座柱子 Y scale 從 0.2 彈性長到 1（pivot 在地面 y=0）
function animatePlace(cellId, level) {
  const mesh = columnMeshes.get(cellId);
  if (!mesh) return;
  const s0 = 0.2;
  mesh.scale.set(1, s0, 1);
  mesh.position.set(0, 0, 0);
  addAnim({
    duration: 360, easing: Ease.outBack,
    onUpdate: (t) => { mesh.scale.set(1, s0 + (1 - s0) * t, 1); },
    onComplete: () => mesh.scale.set(1, 1, 1),
  });
}

// 移除動畫：快速 Y 脈衝（壓一下回彈）
function animateRemovePulse(cellId) {
  const mesh = columnMeshes.get(cellId);
  if (!mesh) return;
  addAnim({
    duration: 260, easing: Ease.inOutQuad,
    onUpdate: (t) => { mesh.scale.set(1, 1 - 0.12 * Math.sin(t * Math.PI), 1); },
    onComplete: () => mesh.scale.set(1, 1, 1),
  });
}

function addBlock(cellId, level) {
  if (level < 0) return;
  const cell = cells[cellId];
  if (level > cell.blocks.length) return;
  if (cell.blocks[level]) return;
  pushHistory();
  cell.blocks[level] = { color: currentColor };
  rebuildBuildings();  // 先算好建築分組，rebuildColumn 才能拿到 buildingId 做 tint
  for (const id of affectedCells(cellId)) rebuildColumn(id);
  scheduleDecorRefresh();  // 裝飾延後到下一個 RAF 合併
  animatePlace(cellId, level);
  updateFocus();
}

function removeTopBlock(cellId) {
  const cell = cells[cellId];
  if (!cell.blocks.length) return;
  pushHistory();
  cell.blocks.pop();
  rebuildBuildings();
  for (const id of affectedCells(cellId)) rebuildColumn(id);
  scheduleDecorRefresh();
  animateRemovePulse(cellId);
  updateFocus();
}

function handleClick(ev, isRight) {
  const hit = pick(ev.clientX, ev.clientY);
  if (!hit) return;
  const ud = hit.object.userData;

  if (isRight) {
    if (ud.type === 'column') {
      removeTopBlock(ud.cellId);
    }
    return;
  }

  if (ud.type === 'ground') {
    addBlock(ud.cellId, 0);
    return;
  }
  if (ud.type === 'column') {
    const meta = ud.faceMeta[hit.faceIndex];
    if (!meta) return;
    if (meta.type === 'top') {
      addBlock(ud.cellId, meta.level + 1);
    } else if (meta.type === 'side') {
      const nei = cells[ud.cellId].neighbors[meta.edgeIdx];
      if (nei !== null) addBlock(nei, cells[nei].blocks.length);
    }
  }
}

// 區分點擊與拖曳：位移 < 5px 且時間 < 350ms 才算點擊
renderer.domElement.addEventListener('pointerdown', (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY, t: performance.now(), button: ev.button };
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downPos) return;
  const d = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
  const dt = performance.now() - downPos.t;
  const btn = downPos.button;
  downPos = null;
  if (d > 5 || dt > 400) return;
  if (btn === 0) handleClick(ev, false);
  else if (btn === 2) handleClick(ev, true);
});
renderer.domElement.addEventListener('pointerleave', () => {
  downPos = null;
  showHover(null);  // 清除 ghost，避免滑鼠移到 UI 時方塊殘留在地圖上
});
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());

renderer.domElement.addEventListener('pointermove', (ev) => {
  const hit = pick(ev.clientX, ev.clientY);
  showHover(hit);
});

// Hover ghost：半透明預覽方塊（顯示會被放置的形狀與顏色）+ 柔和輪廓
let ghostState = { cellId: null, y: 0, valid: false, meshRef: null, outlineRef: null };
const ghostGroup = hoverRing; // reuse existing group

function showHover(hit) {
  disposeGroup(ghostGroup);
  ghostState.cellId = null;
  ghostState.meshRef = null;
  ghostState.outlineRef = null;
  if (!hit) return;
  const ud = hit.object.userData;
  let cellId = null;
  let yBottom = 0;
  if (ud.type === 'ground') {
    cellId = ud.cellId;
    yBottom = 0;
  } else if (ud.type === 'column') {
    const meta = ud.faceMeta[hit.faceIndex];
    if (!meta) return;
    if (meta.type === 'top') {
      cellId = ud.cellId;
      yBottom = (meta.level + 1) * BLOCK_HEIGHT;
    } else if (meta.type === 'side') {
      const nei = cells[ud.cellId].neighbors[meta.edgeIdx];
      if (nei !== null) {
        cellId = nei;
        yBottom = cells[nei].blocks.length * BLOCK_HEIGHT;
      }
    }
  }
  if (cellId === null) return;
  const cell = cells[cellId];
  const verts = cell.verts;
  const N = verts.length;
  // 幽靈方塊：側面 + 頂面（半透明），使用當前選取顏色
  const positions = [], normals = [], indices = [];
  let vb = 0;
  const y0 = yBottom, y1 = yBottom + BLOCK_HEIGHT;
  for (let i = 0; i < N; i++) {
    const a = verts[i], b = verts[(i + 1) % N];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    positions.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[1] ? null : null);
    // reset positions with full quad
  }
  // 重新正確構造 positions (上面有 typo)
  positions.length = 0;
  for (let i = 0; i < N; i++) {
    const a = verts[i], b = verts[(i + 1) % N];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    positions.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y1, a[1]);
    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
    indices.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3);
    vb += 4;
  }
  // 頂面（fan）
  const topStart = vb;
  for (let i = 0; i < N; i++) {
    positions.push(verts[i][0], y1, verts[i][1]);
    normals.push(0, 1, 0);
  }
  vb += N;
  for (let i = 1; i < N - 1; i++) {
    indices.push(topStart, topStart + i, topStart + i + 1);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  geom.computeBoundingSphere();
  const col = new THREE.Color(PALETTE[currentColor]);
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    transparent: true,
    opacity: 0.45,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    depthWrite: false,
  });
  const ghost = new THREE.Mesh(geom, mat);
  ghostGroup.add(ghost);
  // 邊緣線條加強視覺
  const edgeGeom = new THREE.BufferGeometry();
  const ep = [];
  for (let i = 0; i < N; i++) {
    const a = verts[i], b = verts[(i + 1) % N];
    ep.push(a[0], y0, a[1], b[0], y0, b[1]);
    ep.push(a[0], y1, a[1], b[0], y1, b[1]);
    ep.push(a[0], y0, a[1], a[0], y1, a[1]);
  }
  edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  const outline = new THREE.LineSegments(edgeGeom,
    new THREE.LineBasicMaterial({ color: 0x1f2733, transparent: true, opacity: 0.85, depthWrite: false }));
  ghostGroup.add(outline);
  ghostState.cellId = cellId;
  ghostState.y = yBottom;
  ghostState.meshRef = ghost;
  ghostState.outlineRef = outline;
}

// 每幀讓 ghost 做細微的上下浮動 & 呼吸透明度
function updateGhost() {
  if (!ghostState.meshRef) return;
  const t = performance.now() / 1000;
  const bob = Math.sin(t * 2.6) * 0.04;
  ghostState.meshRef.position.y = bob;
  if (ghostState.outlineRef) ghostState.outlineRef.position.y = bob;
  ghostState.meshRef.material.opacity = 0.38 + Math.sin(t * 3.2) * 0.08;
}

// ===== UI =====
const paletteEl = document.getElementById('palette') || (() => {
  const el = document.createElement('div');
  el.id = 'palette';
  document.body.appendChild(el);
  return el;
})();

PALETTE.forEach((color, i) => {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (i === currentColor ? ' active' : '');
  sw.style.background = color;
  sw.dataset.idx = i;
  sw.addEventListener('click', () => selectColor(i));
  paletteEl.appendChild(sw);
});

function selectColor(idx) {
  if (idx < 0 || idx >= PALETTE.length) return;
  currentColor = idx;
  document.querySelectorAll('.swatch').forEach(s =>
    s.classList.toggle('active', +s.dataset.idx === idx));
}

document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea')) return;
  if (/^[0-9]$/.test(ev.key)) {
    const idx = ev.key === '0' ? 9 : (+ev.key - 1);
    if (idx < PALETTE.length) selectColor(idx);
  } else if ((ev.key === 'z' || ev.key === 'Z') && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (history.length) restore(history.pop());
  }
});

document.getElementById('btn-undo').addEventListener('click', () => {
  if (history.length) restore(history.pop());
});
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!cells.some(c => c.blocks.length)) return;
  pushHistory();
  for (const c of cells) c.blocks = [];
  rebuildAll();
  updateFocus();
});
document.getElementById('btn-regen').addEventListener('click', async () => {
  document.getElementById('loading').classList.remove('hidden');
  await new Promise(r => setTimeout(r, 20));
  cells = generateGrid(13, Math.random());
  buildVertexToCells();
  history.length = 0;
  for (const m of columnMeshes.values()) {
    cellGroup.remove(m);
    m.geometry.dispose();
  }
  columnMeshes.clear();
  refreshDecorations();
  buildGroundPick();
  updateFocus();
  document.getElementById('loading').classList.add('hidden');
});

// ===== 視窗尺寸 =====
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== 動畫系統 =====
const animations = new Set();
const Ease = {
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutQuad: (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};
function addAnim(opts) {
  const anim = {
    start: performance.now(),
    duration: opts.duration || 300,
    easing: opts.easing || Ease.outCubic,
    onUpdate: opts.onUpdate,
    onComplete: opts.onComplete,
  };
  animations.add(anim);
  return anim;
}
function updateAnimations() {
  const now = performance.now();
  for (const a of animations) {
    const raw = Math.min(1, (now - a.start) / a.duration);
    const t = a.easing(raw);
    if (a.onUpdate) a.onUpdate(t, raw);
    if (raw >= 1) {
      if (a.onComplete) a.onComplete();
      animations.delete(a);
    }
  }
}

// 追蹤「最近放置/移除的 cell」以便觸發對應動畫
let lastPlaceEvent = null; // { cellId, type: 'place' | 'remove', time }

// ===== 主迴圈 =====
function animate() {
  requestAnimationFrame(animate);
  // 平滑追焦：camera 與 target 一起平移，保留使用者當前視角
  const dx = desiredTarget.x - controls.target.x;
  const dy = desiredTarget.y - controls.target.y;
  const dz = desiredTarget.z - controls.target.z;
  if (dx * dx + dy * dy + dz * dz > 1e-5) {
    const k = 0.08;  // lerp 係數：~0.5s 收斂到目標
    const mx = dx * k, my = dy * k, mz = dz * k;
    controls.target.x += mx;
    controls.target.y += my;
    controls.target.z += mz;
    camera.position.x += mx;
    camera.position.y += my;
    camera.position.z += mz;
  }
  controls.update();
  updateAnimations();
  updateGhost();
  if (skyMaterial) skyMaterial.uniforms.uTime.value = performance.now() * 0.001;
  renderer.render(scene, camera);
}
animate();

document.getElementById('loading').classList.add('hidden');
