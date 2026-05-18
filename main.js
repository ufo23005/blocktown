import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import Delaunator from 'delaunator';
import { LoopSubdivision } from 'three-subdivide';

// Townscaper 風奶油北歐配色：飽和度略降、明度略升，整體更柔和
const PALETTE = [
  '#f0d8b0', // 奶米
  '#e08070', // 暖紅（飽和度降）
  '#eaa860', // 暖橙
  '#f0d568', // 蛋黃
  '#a8d080', // 嫩綠
  '#6cb088', // 草綠（中綠）
  '#8ccdd2', // 海青
  '#7298c8', // 中藍
  '#a094d0', // 淡紫
  '#dc94b0', // 粉
  '#f5ecd9', // 奶白
  '#a08068', // 暖棕
  '#b0b8c4', // 淺灰藍
  '#4a5460', // 深岩灰
];

let currentColor = 1;

const BLOCK_HEIGHT = 1.0;
// 兩階段建造：第一次點擊 = 矮地基（block[0]），之後 = 正常樓層 + 屋頂
// 地基為單一物件：從略沉水下到水面上 0.3 處（不需額外 cliffMat 基座）
const FOUNDATION_TOP_Y = 0.3;              // 地基頂 = 樓層底
// 注意：FOUNDATION_BOTTOM_Y 引用 WATER_Y，但 WATER_Y 在後面才宣告
// → 用 getter 形式延後求值
const getFoundationBottomY = () => WATER_Y - 0.05;

// 樓層底/頂 y 計算（lvl=0 是地基，lvl≥1 是樓層）
const blockBottomY = (lvl) => lvl <= 0 ? getFoundationBottomY() : FOUNDATION_TOP_Y + (lvl - 1) * BLOCK_HEIGHT;
const blockTopY = (lvl) => lvl < 0 ? 0 : (lvl === 0 ? FOUNDATION_TOP_Y : FOUNDATION_TOP_Y + lvl * BLOCK_HEIGHT);
const cellTopY = (cell) => cell.blocks.length === 0 ? 0 : blockTopY(cell.blocks.length - 1);

// ===== 場景初始化 =====
const app = document.getElementById('app');
const scene = new THREE.Scene();
// 天空改由 shader 球體呈現漸層；fog 顏色取地平線色以便無縫銜接
scene.background = null;
scene.fog = new THREE.Fog('#2c4651', 45, 180);   // 深海平面霧色，跟壓暗的水銜接

// 倒置天空球：漸層 + 飄動雲層
let skyMaterial = null;
(function setupSkyDome() {
  const geom = new THREE.SphereGeometry(380, 48, 24);
  skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith:  { value: new THREE.Color('#2c5680') },   // 深天空藍
      uHorizon: { value: new THREE.Color('#6e8b9a') },   // 中灰藍（往深水色靠）
      uGround:  { value: new THREE.Color('#8a8170') },   // 暗一級的地平線下色
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

// ===== 後處理：UnrealBloom 微弱暈光，增加溫暖夢幻感 =====
// strength 設低（0.35）避免過曝；threshold 0.85 只挑亮部（高光屋頂、邊緣）
let composer = null;
{
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.35,    // strength
    0.6,     // radius
    0.85,    // threshold
  ));
  composer.addPass(new OutputPass());
}

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
      sy += (blockBottomY(lvl) + blockTopY(lvl)) * 0.5;   // block 中心 y（地基/樓層通用）
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

// ===== 水面（Townscaper 風）=====
// 水面只負責顯示海洋；地基由 block[0] 自身延伸至水下完成（無 cliffMat）
const WATER_Y = -0.8;          // 水面：地基會延伸到此面下方一點點

// 水面：簡易 sin 波 + 邊緣淡色泡沫
let waterMaterial = null;
{
  const waterGeom = new THREE.PlaneGeometry(400, 400, 1, 1);
  waterGeom.rotateX(-Math.PI / 2);
  waterMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWPos;
      void main() {
        // 純平滑漸層：中央深、向外漸淺
        // center: #0E3340 (0.055, 0.200, 0.251) — 深海藍黑
        // edge:   #1F4D5C (0.122, 0.302, 0.361) — 深青藍
        vec3 deepCenter  = vec3(0.055, 0.200, 0.251);
        vec3 shallowEdge = vec3(0.122, 0.302, 0.361);
        float d = length(vWPos.xz);
        vec3 col = mix(deepCenter, shallowEdge, smoothstep(0.0, 60.0, d));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const water = new THREE.Mesh(waterGeom, waterMaterial);
  water.position.y = WATER_Y;
  water.renderOrder = -0.5;  // 在天空 (-1) 之後但其他物件之前
  scene.add(water);
}

// ===== 正方形格網 + 圓形 mask 地圖生成（Townscaper 風的近正方形 quad）=====
// 演算法（徹底改變思路：放棄 hex 底，直接用正方形格網）：
// 1. 列舉 (N+1)×(N+1) 正方形 vertex 格網
// 2. 每個 (i,j) cell 由 4 個鄰角構成 quad；用 radius 圓形 mask 限制範圍
// 3. 內部頂點加小幅 jitter（boundary 固定 → 保持圓形外輪廓）
// 4. 少量 shape-aware smoothing 收斂邊長
// 結果：100% 接近正方形的 quad、行列結構清晰、外圍自然圓潤、無 triangle
function generateGrid(radius = 12, seed = Math.random()) {
  console.group(`%c[generateGrid] 開始建立地圖`, 'color:#4af;font-weight:bold');
  console.log(`參數: radius=${radius}, seed=${seed.toFixed(6)}`);
  const t0 = performance.now();

  // seeded RNG
  let s = Math.floor(seed * 2 ** 31) >>> 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const JITTER = 0.12;            // 小幅 per-vertex 隨機（不規則微擾）
  const CURVE_AMP = 0.35;         // 整片彎曲振幅（行列會跟著彎）
  const CURVE_FREQ = 0.32;        // 彎曲頻率（越大波浪越密）
  const SHAPE_PASSES = 10;        // smoothing 輪數（保留彎曲，不要拉直）
  const SHAPE_STRENGTH = 0.25;

  // ===== 1. 建立 (N+1)×(N+1) vertex 格網 =====
  const N = radius * 2 + 1;       // 邊長 N cells，需要 N+1 條 vertex
  const halfN = N / 2;
  const pts = [];
  const vIdxAt = (i, j) => j * (N + 1) + i;   // 索引函式（取代 Map，速度更快）
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      pts.push([i - halfN, j - halfN]);
    }
  }
  console.log(`[Step 1] vertex 格網 (${N + 1}×${N + 1}) = ${pts.length} 個頂點`);

  // ===== 2. 生成 quad cells（圓形 mask）=====
  // 每 cell 由 (i,j), (i,j+1), (i+1,j+1), (i+1,j) 四個 vertex 組成
  // 順序 [v00, v01, v11, v10] 是 CW from above（符合下游 wall normal 約定）
  const rawCells = [];
  const cellExists = new Set();   // "i,j"
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const cx = i + 0.5 - halfN;
      const cz = j + 0.5 - halfN;
      if (Math.hypot(cx, cz) > radius) continue;

      const v00 = vIdxAt(i, j);
      const v01 = vIdxAt(i, j + 1);
      const v11 = vIdxAt(i + 1, j + 1);
      const v10 = vIdxAt(i + 1, j);

      const vIdx = [v00, v01, v11, v10];   // CW from above
      rawCells.push({
        id: rawCells.length,
        vertIdx: vIdx,
        verts: vIdx.map(v => pts[v].slice()),
        blocks: [],
      });
      cellExists.add(`${i},${j}`);
    }
  }
  console.log(`[Step 2] Cells 生成（圓形 mask radius=${radius}）: ${rawCells.length} 個`);

  // ===== 3. 標記 boundary vertices（不被 jitter / 不被 smoothing 移動）=====
  // 規則：周圍 4 個 cell 不全都存在 → 邊界頂點
  const usedVerts = new Set();
  for (const c of rawCells) for (const v of c.vertIdx) usedVerts.add(v);
  const isBoundaryVert = new Set();
  for (const v of usedVerts) {
    const p = pts[v];
    const i = Math.round(p[0] + halfN);
    const j = Math.round(p[1] + halfN);
    let count = 0;
    if (cellExists.has(`${i - 1},${j - 1}`)) count++;
    if (cellExists.has(`${i},${j - 1}`)) count++;
    if (cellExists.has(`${i - 1},${j}`)) count++;
    if (cellExists.has(`${i},${j}`)) count++;
    if (count < 4) isBoundaryVert.add(v);
  }
  console.log(`[Step 3] vertex 分類: 使用中 ${usedVerts.size}, 內部 ${usedVerts.size - isBoundaryVert.size}, 邊界 ${isBoundaryVert.size}`);

  // ===== 3.5 Curve distortion: 整片格網施加平滑波形位移 =====
  // 讓行列像水波一樣彎曲（Townscaper 風的「flow」感）
  // 全部 vertex 都施加（含 boundary），所以 cell 排列會跟著彎，外輪廓也有微波感
  // 雙層 sine 波相位錯開 → 形狀不規則，不會看出直接的網格走向
  // seed 影響相位，讓每次生成的彎法不同
  const phaseX = rnd() * Math.PI * 2;
  const phaseZ = rnd() * Math.PI * 2;
  for (const v of usedVerts) {
    const [x, z] = pts[v];
    // x 位移取決於 z（垂直波）
    const dx = Math.sin(z * CURVE_FREQ + phaseX) * CURVE_AMP
             + Math.sin(z * CURVE_FREQ * 1.73 + phaseX + 1.1) * CURVE_AMP * 0.4;
    // z 位移取決於 x（水平波）
    const dz = Math.cos(x * CURVE_FREQ + phaseZ) * CURVE_AMP
             + Math.cos(x * CURVE_FREQ * 1.73 + phaseZ + 2.3) * CURVE_AMP * 0.4;
    pts[v] = [x + dx, z + dz];
  }
  console.log(`[Step 3.5] Curve distortion: 雙層 sine 波 (amp ${CURVE_AMP}, freq ${CURVE_FREQ}) 套用到 ${usedVerts.size} 個頂點`);

  // ===== 4. Jitter 內部頂點 =====
  let jitteredCount = 0;
  for (const v of usedVerts) {
    if (isBoundaryVert.has(v)) continue;
    const p = pts[v];
    pts[v] = [p[0] + (rnd() - 0.5) * JITTER, p[1] + (rnd() - 0.5) * JITTER];
    jitteredCount++;
  }
  console.log(`[Step 4] Jitter: ${jitteredCount} 個內部頂點（強度 ${JITTER}）`);

  // ===== 5. Shape-aware smoothing：邊長等長 =====
  // 少量 pass 即可：square 格網本身就接近目標形狀
  const edgePairs = new Map();
  for (const c of rawCells) {
    for (let i = 0; i < 4; i++) {
      const a = c.vertIdx[i];
      const b = c.vertIdx[(i + 1) % 4];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgePairs.has(k)) edgePairs.set(k, [Math.min(a, b), Math.max(a, b)]);
    }
  }
  const edgeList = [...edgePairs.values()];

  let edgeLenInitial = 0;
  for (const [a, b] of edgeList) edgeLenInitial += Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
  edgeLenInitial /= edgeList.length;

  for (let pass = 0; pass < SHAPE_PASSES; pass++) {
    let totalLen = 0;
    for (const [a, b] of edgeList) totalLen += Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
    const targetLen = totalLen / edgeList.length;

    const disp = pts.map(() => [0, 0]);
    const cnt = new Uint16Array(pts.length);

    for (const [a, b] of edgeList) {
      const dx = pts[b][0] - pts[a][0];
      const dz = pts[b][1] - pts[a][1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const half = (len - targetLen) * 0.5;
      const ex = (dx / len) * half;
      const ez = (dz / len) * half;
      disp[a][0] += ex; disp[a][1] += ez; cnt[a]++;
      disp[b][0] -= ex; disp[b][1] -= ez; cnt[b]++;
    }

    for (let i = 0; i < pts.length; i++) {
      if (isBoundaryVert.has(i)) continue;
      if (cnt[i] === 0) continue;
      pts[i][0] += (disp[i][0] / cnt[i]) * SHAPE_STRENGTH;
      pts[i][1] += (disp[i][1] / cnt[i]) * SHAPE_STRENGTH;
    }
  }

  let edgeLenFinal = 0;
  for (const [a, b] of edgeList) edgeLenFinal += Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
  edgeLenFinal /= edgeList.length;

  // 同步更新 cells.verts
  for (const c of rawCells) c.verts = c.vertIdx.map(v => pts[v].slice());
  console.log(`[Step 5] Shape-aware smoothing: ${SHAPE_PASSES} pass，邊長平均 ${edgeLenInitial.toFixed(3)} → ${edgeLenFinal.toFixed(3)}`);

  // ===== 6. 中心點 + 鄰接 =====
  for (const c of rawCells) {
    let cx = 0, cz = 0;
    for (const v of c.verts) { cx += v[0]; cz += v[1]; }
    c.center = [cx / c.verts.length, cz / c.verts.length];
  }
  const _ek = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
  const edgeMap = new Map();
  for (const c of rawCells) {
    c.neighbors = new Array(c.vertIdx.length).fill(null);
    for (let i = 0; i < c.vertIdx.length; i++) {
      const a = c.vertIdx[i];
      const b = c.vertIdx[(i + 1) % c.vertIdx.length];
      const k = _ek(a, b);
      if (!edgeMap.has(k)) edgeMap.set(k, []);
      edgeMap.get(k).push({ cellId: c.id, edgeIdx: i });
    }
  }
  for (const entries of edgeMap.values()) {
    if (entries.length === 2) {
      const [a, b] = entries;
      rawCells[a.cellId].neighbors[a.edgeIdx] = b.cellId;
      rawCells[b.cellId].neighbors[b.edgeIdx] = a.cellId;
    }
  }
  // 鄰接統計
  let totalEdges = 0, internalEdges = 0, boundaryEdges = 0;
  for (const c of rawCells) {
    for (const nb of c.neighbors) {
      totalEdges++;
      if (nb !== null) internalEdges++;
      else boundaryEdges++;
    }
  }
  console.log(`[Step 6] 鄰接表: cells=${rawCells.length}, 總邊數=${totalEdges}, 內部邊=${internalEdges}, 邊界邊=${boundaryEdges}`);

  // ===== 7. 防呆檢查：保證 100% quad =====
  const beforeFilter = rawCells.length;
  const finalCells = keepLargestComponent(rawCells);
  const droppedByComponent = beforeFilter - finalCells.length;
  const nonQuad = finalCells.filter(c => c.vertIdx.length !== 4);
  if (nonQuad.length > 0) {
    console.warn(`%c⚠ 發現 ${nonQuad.length} 個非 quad cell（已過濾）:`, 'color:#fa0', nonQuad.slice(0, 5));
  }
  const quadOnly = finalCells.filter(c => c.vertIdx.length === 4);
  const remap = new Map(quadOnly.map((c, i) => [c.id, i]));
  for (const c of quadOnly) c.id = remap.get(c.id);
  for (const c of quadOnly) {
    for (let i = 0; i < c.neighbors.length; i++) {
      const nb = c.neighbors[i];
      c.neighbors[i] = (nb != null && remap.has(nb)) ? remap.get(nb) : null;
    }
  }
  console.log(`[Step 7] 連通分量過濾: 丟棄 ${droppedByComponent} 個離島 cell, 最終 ${quadOnly.length} quad cells`);

  // ===== Debug: 詳細資訊 =====
  console.group(`%c📊 最終地圖資訊`, 'color:#4f8;font-weight:bold');
  console.log(`總 cell 數: ${quadOnly.length}`);
  console.log(`頂點數: ${pts.length}`);

  // 邊數分佈（應 100% 是 4）
  const finalSideHist = {};
  for (const c of quadOnly) finalSideHist[c.vertIdx.length] = (finalSideHist[c.vertIdx.length] || 0) + 1;
  console.log(`邊數分佈:`, finalSideHist);
  const tris = quadOnly.filter(c => c.vertIdx.length === 3).length;
  if (tris === 0) {
    console.log(`%c✓ 0 個三角形（100% quad 確認）`, 'color:#4f8;font-weight:bold');
  } else {
    console.error(`%c✗ 偵測到 ${tris} 個三角形！`, 'color:#f44;font-weight:bold');
  }

  // 鄰居數分佈（每 cell 有幾個鄰居：0~4）
  const nbHist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const c of quadOnly) {
    const n = c.neighbors.filter(x => x !== null).length;
    nbHist[n] = (nbHist[n] || 0) + 1;
  }
  console.log(`鄰居數分佈:`, nbHist);

  // 面積統計
  let areaSum = 0, areaMin = Infinity, areaMax = 0;
  for (const c of quadOnly) {
    let a = 0;
    for (let i = 0; i < c.verts.length; i++) {
      const [x1, z1] = c.verts[i];
      const [x2, z2] = c.verts[(i + 1) % c.verts.length];
      a += x1 * z2 - x2 * z1;
    }
    const area = Math.abs(a) / 2;
    areaSum += area;
    if (area < areaMin) areaMin = area;
    if (area > areaMax) areaMax = area;
  }
  console.log(`面積: 平均 ${(areaSum / quadOnly.length).toFixed(3)}, 最小 ${areaMin.toFixed(3)}, 最大 ${areaMax.toFixed(3)}, 總和 ${areaSum.toFixed(2)}`);

  // 邊長統計
  let edgeLenSum = 0, edgeLenMin = Infinity, edgeLenMax = 0, edgeCount = 0;
  for (const c of quadOnly) {
    for (let i = 0; i < c.verts.length; i++) {
      const [x1, z1] = c.verts[i];
      const [x2, z2] = c.verts[(i + 1) % c.verts.length];
      const len = Math.hypot(x2 - x1, z2 - z1);
      edgeLenSum += len;
      if (len < edgeLenMin) edgeLenMin = len;
      if (len > edgeLenMax) edgeLenMax = len;
      edgeCount++;
    }
  }
  console.log(`邊長: 平均 ${(edgeLenSum / edgeCount).toFixed(3)}, 最短 ${edgeLenMin.toFixed(3)}, 最長 ${edgeLenMax.toFixed(3)}`);

  // 前 3 個 cell 的完整明細
  console.log(`前 3 個 cell 完整內容:`);
  for (let i = 0; i < Math.min(3, quadOnly.length); i++) {
    const c = quadOnly[i];
    console.log(`  cell #${c.id}:`, {
      vertIdx: c.vertIdx,
      verts: c.verts.map(v => `(${v[0].toFixed(2)}, ${v[1].toFixed(2)})`),
      center: `(${c.center[0].toFixed(2)}, ${c.center[1].toFixed(2)})`,
      neighbors: c.neighbors,
    });
  }

  console.groupEnd();
  console.log(`%c耗時: ${(performance.now() - t0).toFixed(1)} ms`, 'color:#888');
  console.groupEnd();

  return quadOnly;
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

let cells = generateGrid(12, Math.random());    // square grid + 圓形 mask，radius 12 ≈ ~450 cells

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
// 讓屋頂高度形成平滑圓頂
let vertexHeightWeight = new Map();  // vidx → 0..1（每次 rebuildBuildings 後重算）
// 嚴格 region 邊界頂點集合：用於屋簷 overhang 判定（避免 smoothstep 模糊造成邊簷跳躍）
let vertexIsRegionBoundary = new Set();

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

// 為每個頂點計算「region 內部度」權重（0=純邊界、1=最內部）
// 方法：對每個 (region, vert)，掃描該頂點周圍所有 (cell, edge) pair，
//      計算「內部邊」(該邊兩側都是同 region 同層 cell) 佔的比例。
// 這個指標比「3 cell 都在 region」嚴格條件能更早捕捉到「半內部」頂點：
//   - 孤立 cell：所有頂點都是純邊界 → 完整金字塔
//   - 2 格相鄰：共邊兩端頂點 fraction≈0.5 → 中間自動形成屋脊
//   - 3 cell 共角：那個角頂點 fraction=1 → 完全抬升
//   - 大叢集內部：所有邊都內部 → 完全抬升 → 平頂
function computeVertexHeightWeights() {
  vertexHeightWeight.clear();
  vertexIsRegionBoundary.clear();
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    const levelsSet = new Set();
    for (const cid of cellIds) levelsSet.add(cells[cid].blocks.length - 1);
    for (const level of levelsSet) {
      const regionCells = cellIds.filter(c => cells[c].blocks.length - 1 === level);
      const regionSet = new Set(regionCells);
      const vertsInRegion = new Set();
      for (const cid of regionCells) {
        for (const vidx of cells[cid].vertIdx) vertsInRegion.add(vidx);
      }
      for (const vidx of vertsInRegion) {
        // 掃此 vert 周圍每個 region 內 cell 中與 vert 相鄰的 2 條邊
        let internalEdges = 0, totalEdges = 0;
        for (const cid of vertexToCells.get(vidx)) {
          if (!regionSet.has(cid)) continue;
          const cell = cells[cid];
          const vi = cell.vertIdx.indexOf(vidx);
          if (vi < 0) continue;
          // 該頂點在這個 cell 中接觸 2 條邊：edge[vi-1] 與 edge[vi]
          const edgeIdxs = [vi, (vi - 1 + cell.vertIdx.length) % cell.vertIdx.length];
          for (const ei of edgeIdxs) {
            totalEdges++;
            const nb = cell.neighbors[ei];
            if (nb !== null && regionSet.has(nb)) internalEdges++;
          }
        }
        const fraction = totalEdges > 0 ? internalEdges / totalEdges : 0;
        if (fraction <= 0.01) {
          vertexIsRegionBoundary.add(vidx);
        } else {
          // 激進曲線：fraction>=0.5 的頂點（典型相鄰格共邊端點）直接拉到頂端 w=1。
          // 這樣 2 格並排時共邊就完整成為屋脊，形成 Townscaper 風的 gable 而非 dome。
          // fraction<0.5 的少見退化情況才會留中間值。
          const w = Math.min(1, fraction * 2);
          vertexHeightWeight.set(vidx, w);
        }
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

// 可建格線：浮在水面上方一點，提示玩家「可放置範圍」
const baseGridLines = new THREE.Group();
scene.add(baseGridLines);

const groundPickGroup = new THREE.Group();
scene.add(groundPickGroup);

const hoverRing = new THREE.Group();
scene.add(hoverRing);

// 裝飾群組：樓梯、煙囪、窗戶、牆角柱
const windowsGroup = new THREE.Group();
scene.add(windowsGroup);
const doorsGroup = new THREE.Group();
scene.add(doorsGroup);

// 拱形窗戶：Shape 做上半圓 + 下矩形
function _buildArchedWindowGeom() {
  const w = 0.38, h = 0.55, r = w / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(w / 2, h / 2 - r);
  shape.absarc(0, h / 2 - r, r, 0, Math.PI, false);
  shape.lineTo(-w / 2, -h / 2);
  return new THREE.ShapeGeometry(shape);
}
const _windowGeom = _buildArchedWindowGeom();
const _windowMat = new THREE.MeshStandardMaterial({
  color: 0x1c2230, roughness: 0.4, metalness: 0.15,
});

let windowInstMesh = null;

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

// 可建格線：浮在水面正上方，提示玩家可放置範圍
// 只畫「空 cell」的邊（與另一個空 cell 之間）；已蓋格的邊由建築自己顯示
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
      if (cellHasBlock || nbHasBlock) continue;
      const va = c.verts[i];
      const vb = c.verts[(i + 1) % c.verts.length];
      positions.push(va[0], WATER_Y + 0.02, va[1], vb[0], WATER_Y + 0.02, vb[1]);
    }
  }
  if (!positions.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // 對比強化：純白 + 高透明度（深青水面上會非常清楚）
  baseGridLines.add(new THREE.LineSegments(g,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    })));
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
      if (lvl === 0) continue;          // 地基（podium）沒有窗
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[lvl]) continue;
        // 一樓地面層第一面（i==0）幾乎一定會放門 → 第 0 面跳過避免門+窗重疊
        const isDoorWall = (lvl === 1 && i === 0);
        const a = cell.verts[i];
        const b = cell.verts[(i + 1) % cell.vertIdx.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const elen = Math.hypot(dx, dz);
        if (elen < 0.6) continue;  // 邊太短不放窗
        const nx = -dz / elen, nz = dx / elen;
        const y = (blockBottomY(lvl) + blockTopY(lvl)) * 0.5;   // 該層牆面中點
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
            x: px + nx * 0.045,    // 補償 subdivision 後牆面內縮，讓窗戶仍貼牆外側
            y,
            z: pz + nz * 0.045,
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
  // 整棟一道門：每棟建築收集所有「至少 1 樓外露」的邊，挑最長那段放門
  // 大棟建築允許 1~2 道（每 6 cell + 1 道）
  // 門放在 FOUNDATION_TOP_Y 高度（站在地基上），需要有 lvl≥1 樓層才放門
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    const visEdges = [];
    for (const cid of cellIds) {
      const cell = cells[cid];
      if (cell.blocks.length < 2) continue;     // 只有地基沒樓層 → 無門
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[1]) continue;   // 1 樓共邊 → 內牆，不放門
        const a = cell.verts[i], b = cell.verts[(i + 1) % cell.vertIdx.length];
        const elen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (elen < 0.55) continue;
        visEdges.push({ a, b, elen });
      }
    }
    if (!visEdges.length) continue;
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
        x: midX + nx * 0.045,
        y: FOUNDATION_TOP_Y,      // 站在地基平頂上
        z: midZ + nz * 0.045,
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

function refreshDecorations() {
  rebuildBuildings();
  buildBaseGridLines();
  buildWindows();
  buildDoors();
}

// ===== 裝飾刷新節流：連點放方塊時合併到下一個 RAF =====
let _decorPending = false;
function scheduleDecorRefresh() {
  if (_decorPending) return;
  _decorPending = true;
  requestAnimationFrame(() => {
    _decorPending = false;
    buildBaseGridLines();
    buildWindows();
    buildDoors();
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

// 單一共享材質：subdivision 不支援 material groups，所有顏色資訊烤進 vertex colors。
// flatShading 改 false：subdivision 之後使用 smooth normals 才能呈現 Townscaper 的圓潤感。
const buildingMaterial = (() => {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,           // 白底，全靠 vertex color 上色
    roughness: 0.88,
    metalness: 0.0,
    flatShading: false,
    vertexColors: true,
  });
  return injectBlockShader(mat);
})();

// 每個建築一個合併 mesh，套用 Loop subdivision 後變圓潤。
// 共用幾何常數（提到 module scope 避免在 rebuild 內重複宣告）
const ROOF_OVERHANG = 0.12;
const EAVE_DROOP = 0.02;
const WALL_BULGE = 0.045;
const ROOF_COLOR_INDICES = [1, 2, 11];   // PALETTE: 紅/橙/棕
const AO_WALL_CORNER = 0.72;
const AO_WALL_MID = 0.98;
const AO_TOP_CENTER = 1.0;
const AO_ROOF_BASE = 0.80;
const AO_ROOF_APEX = 1.05;
const AO_BOTTOM = 0.55;

const buildingMeshes = new Map();   // bid → THREE.Mesh

// 構建單一建築（同一 buildingId 內所有 cell）的合併 mesh + Loop subdivision
function rebuildBuildingMesh(bid) {
  const old = buildingMeshes.get(bid);
  if (old) {
    cellGroup.remove(old);
    old.geometry.dispose();
    buildingMeshes.delete(bid);
  }
  const cellIds = buildingCells[bid];
  if (!cellIds || !cellIds.length) return;

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  // 棟級配色：tint + roof color
  const baseTint = buildingTint(bid);
  const roofColorIdx = ROOF_COLOR_INDICES[((bid + 1) * 0x9E3779B1 >>> 0) % ROOF_COLOR_INDICES.length];
  const roofColor = new THREE.Color(PALETTE[roofColorIdx]);
  const ROOF_HEIGHT = cellIds.length <= 1 ? 0.65 : (cellIds.length <= 3 ? 0.55 : 0.42);

  let vertBase = 0;

  for (const cellId of cellIds) {
    const cell = cells[cellId];
    const verts = cell.verts;
    const N = verts.length;
    const cx = cell.center[0];
    const cz = cell.center[1];

    for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
      const block = cell.blocks[lvl];
      const wallColor = new THREE.Color(PALETTE[block.color]);
      const lh = ((cell.id * 7919 + lvl * 6427) >>> 0);
      const tint = [
        baseTint[0] * (1 + (((lh & 0x7F) / 127) - 0.5) * 0.04),
        baseTint[1] * (1 + ((((lh >> 7) & 0x7F) / 127) - 0.5) * 0.04),
        baseTint[2] * (1 + ((((lh >> 14) & 0x7F) / 127) - 0.5) * 0.04),
      ];
      // 牆與屋頂分別把顏色「烤進」vertex color（material 本身是白色）
      const pushWall = (ao) => colors.push(
        ao * tint[0] * wallColor.r,
        ao * tint[1] * wallColor.g,
        ao * tint[2] * wallColor.b,
      );
      const pushRoof = (ao) => colors.push(
        ao * tint[0] * roofColor.r,
        ao * tint[1] * roofColor.g,
        ao * tint[2] * roofColor.b,
      );

      // 高度：lvl=0 是地基（從水下底到 FOUNDATION_TOP_Y），lvl≥1 是樓層 (BLOCK_HEIGHT)
      const y0 = blockBottomY(lvl);
      const y1 = blockTopY(lvl);
      const isTop = lvl === cell.blocks.length - 1;
      const isFoundation = lvl === 0;

      // 牆面：3×3 細分，中央外推
      for (let i = 0; i < N; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[lvl]) continue;
        const a = verts[i], b = verts[(i + 1) % N];
        const ax = a[0], az = a[1], bx = b[0], bz = b[1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        const nx = -dz / len, nz = dx / len;
        const ym = (y0 + y1) / 2;
        // 地基不外推（牆很高，bulge 在水面附近會看起來變形），樓層才用 pudding 效果
        const bulge = isFoundation ? 0 : Math.min(WALL_BULGE, len * 0.08);
        const cmx = mx + nx * bulge, cmz = mz + nz * bulge;
        positions.push(
          ax, y0, az,   mx, y0, mz,    bx, y0, bz,
          ax, ym, az,   cmx, ym, cmz,  bx, ym, bz,
          ax, y1, az,   mx, y1, mz,    bx, y1, bz,
        );
        for (let k = 0; k < 9; k++) normals.push(nx, 0, nz);
        pushWall(AO_WALL_CORNER); pushWall(AO_WALL_MID); pushWall(AO_WALL_CORNER);
        pushWall(AO_WALL_MID);    pushWall(AO_WALL_MID); pushWall(AO_WALL_MID);
        pushWall(AO_WALL_CORNER); pushWall(AO_WALL_MID); pushWall(AO_WALL_CORNER);
        indices.push(
          vertBase + 0, vertBase + 1, vertBase + 4,   vertBase + 0, vertBase + 4, vertBase + 3,
          vertBase + 1, vertBase + 2, vertBase + 5,   vertBase + 1, vertBase + 5, vertBase + 4,
          vertBase + 3, vertBase + 4, vertBase + 7,   vertBase + 3, vertBase + 7, vertBase + 6,
          vertBase + 4, vertBase + 5, vertBase + 8,   vertBase + 4, vertBase + 8, vertBase + 7,
        );
        vertBase += 9;
      }

      // 最底層底面
      if (lvl === 0) {
        const startV = vertBase;
        for (let i = 0; i < N; i++) {
          positions.push(verts[i][0], 0, verts[i][1]);
          normals.push(0, -1, 0);
          pushWall(AO_BOTTOM);
        }
        vertBase += N;
        for (let i = 1; i < N - 1; i++) {
          indices.push(startV, startV + i + 1, startV + i);
        }
      }

      // 頂面處理：
      //  - 地基為最頂層（只有地基無樓層）→ 畫「平頂蓋」，無屋頂
      //  - 樓層為最頂層 → 畫斜屋頂
      //  - 中間樓層（被上層覆蓋）→ 不畫頂
      if (isTop && isFoundation) {
        // === 地基平頂：水平 N-2 三角扇 ===
        const startV = vertBase;
        for (let i = 0; i < N; i++) {
          positions.push(verts[i][0], y1, verts[i][1]);
          normals.push(0, 1, 0);
          pushWall(AO_TOP_CENTER * 0.92);   // 比建築頂面稍暗，視覺像石板
        }
        vertBase += N;
        // CW from above 的扇形（normal up）→ 翻轉為 CCW
        for (let i = 1; i < N - 1; i++) {
          indices.push(startV, startV + i, startV + i + 1);
        }
      } else if (isTop) {
        // === 樓層屋頂：斜屋頂（既有邏輯）===
        const baseStart = vertBase;
        let cellMaxW = 0;
        let perimMaxY = -Infinity;
        for (let i = 0; i < N; i++) {
          const vidx = cell.vertIdx[i];
          const w = vertexHeightWeight.get(vidx) ?? 0;
          if (w > cellMaxW) cellMaxW = w;
          let px = verts[i][0], pz = verts[i][1];
          const isStrictBoundary = vertexIsRegionBoundary.has(vidx);
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
            py = y1 + w * ROOF_HEIGHT;
          }
          if (py > perimMaxY) perimMaxY = py;
          positions.push(px, py, pz);
          normals.push(0, 1, 0);
          pushRoof(AO_ROOF_BASE + (AO_TOP_CENTER - AO_ROOF_BASE) * w);
        }
        vertBase += N;
        let apexY;
        if (cellMaxW < 0.01) {
          apexY = y1 + ROOF_HEIGHT;
        } else {
          const pyramidY = y1 + ROOF_HEIGHT;
          apexY = pyramidY * (1 - cellMaxW) + perimMaxY * cellMaxW;
        }
        positions.push(cx, apexY, cz);
        normals.push(0, 1, 0);
        pushRoof(AO_ROOF_APEX);
        const apexIdx = vertBase;
        vertBase += 1;
        for (let i = 0; i < N; i++) {
          indices.push(baseStart + i, baseStart + (i + 1) % N, apexIdx);
        }
      }
    }
  }

  if (!indices.length) return;

  let geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);

  // Loop subdivision：1 次迭代 → 每個三角形變 4 個，邊角圓潤
  // split: false 略過 coplanar 分割（省 CPU；我們的牆已是 8 三角不需要再切）
  // uvSmooth: false 不平均 UV（我們沒用 UV，省事）
  geom = LoopSubdivision.modify(geom, 1, { split: false, uvSmooth: false });
  geom.computeVertexNormals();   // subdivision 後重算法線確保平滑
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, buildingMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { type: 'column', buildingId: bid, cellIds: cellIds.slice() };
  cellGroup.add(mesh);
  buildingMeshes.set(bid, mesh);
}

// 受影響的建築：cellId 所在建築 + 鄰居所在建築（可能因合併/分裂改變 bid）
function affectedBuildings(cellId) {
  const s = new Set();
  const bid = buildingId.get(cellId);
  if (bid != null) s.add(bid);
  for (const nb of cells[cellId].neighbors) {
    if (nb === null) continue;
    const nbid = buildingId.get(nb);
    if (nbid != null) s.add(nbid);
  }
  return s;
}

function rebuildAll() {
  for (const m of buildingMeshes.values()) {
    cellGroup.remove(m);
    m.geometry.dispose();
  }
  buildingMeshes.clear();
  for (let bid = 0; bid < buildingCells.length; bid++) {
    rebuildBuildingMesh(bid);
  }
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

// 任何 cell 變動 → 全部 building meshes 重建。
// 為何不做增量：buildingId 在 rebuildBuildings 之後可能整盤重編號，追蹤代價反而更高。
// 對於 < 20 棟的典型小鎮，subdivision 總計 < 50ms，可接受。
function rebuildAffectedBuildings(cellId) {
  rebuildBuildings();   // 先重新分組（更新 buildingId / buildingCells）
  // 為求簡單：直接全部重建。日後若需要增量，再追蹤 before/after 比較
  for (const m of buildingMeshes.values()) {
    cellGroup.remove(m);
    m.geometry.dispose();
  }
  buildingMeshes.clear();
  for (let bid = 0; bid < buildingCells.length; bid++) {
    rebuildBuildingMesh(bid);
  }
}

function addBlock(cellId, level) {
  if (level < 0) return;
  const cell = cells[cellId];
  if (level > cell.blocks.length) return;
  if (cell.blocks[level]) return;
  pushHistory();
  cell.blocks[level] = { color: currentColor };
  rebuildAffectedBuildings(cellId);
  scheduleDecorRefresh();
  updateFocus();
}

function removeTopBlock(cellId) {
  const cell = cells[cellId];
  if (!cell.blocks.length) return;
  pushHistory();
  cell.blocks.pop();
  rebuildAffectedBuildings(cellId);
  scheduleDecorRefresh();
  updateFocus();
}

// per-building mesh 之後 hit 點推不出單一 cellId，改用「hit 點 xz 最近的 cell」
function closestCellAt(x, z) {
  let bestId = -1, bestD = Infinity;
  for (const c of cells) {
    const dx = c.center[0] - x;
    const dz = c.center[1] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; bestId = c.id; }
  }
  return bestId;
}

function handleClick(ev, isRight) {
  const hit = pick(ev.clientX, ev.clientY);
  if (!hit) return;
  const ud = hit.object.userData;

  if (isRight) {
    if (ud.type === 'column') {
      // 移除頂層方塊：以 hit 點 xz 找最近的 cell，移除其頂層
      const cellId = closestCellAt(hit.point.x, hit.point.z);
      if (cellId >= 0) removeTopBlock(cellId);
    }
    return;
  }

  if (ud.type === 'ground') {
    addBlock(ud.cellId, 0);
    return;
  }
  if (ud.type === 'column') {
    // 依 hit 法線方向判斷：朝上 (y > 0.5) = 屋頂 → 在最近 cell 疊一層
    // 否則 (側牆) = 朝 normal 外側方向偏移找鄰格 → 在那格放新方塊
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    if (n && n.y > 0.5) {
      const cellId = closestCellAt(hit.point.x, hit.point.z);
      if (cellId >= 0) addBlock(cellId, cells[cellId].blocks.length);
    } else if (n) {
      // 側牆：往法線外側推 0.6 找鄰格
      const targetCellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
      if (targetCellId >= 0) {
        addBlock(targetCellId, cells[targetCellId].blocks.length);
      }
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

// 游標 tooltip（HTML overlay），跟著滑鼠顯示 hover cell 與世界座標
const cursorInfoEl = document.getElementById('cursor-info');
function updateCursorInfo(ev, hit) {
  if (!cursorInfoEl) return;
  if (!hit) {
    cursorInfoEl.classList.remove('show');
    return;
  }
  const ud = hit.object.userData;
  let cellId = -1, action = '—';
  if (ud.type === 'ground') {
    cellId = ud.cellId;
    action = cells[cellId]?.blocks.length ? `疊第 ${cells[cellId].blocks.length} 層` : '建地基';
  } else if (ud.type === 'column') {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    if (n && n.y > 0.5) {
      cellId = closestCellAt(hit.point.x, hit.point.z);
      if (cellId >= 0) action = `疊第 ${cells[cellId].blocks.length} 層`;
    } else if (n) {
      cellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
      if (cellId >= 0) action = cells[cellId].blocks.length ? `疊第 ${cells[cellId].blocks.length} 層` : '建地基';
    }
  }
  const cell = cellId >= 0 ? cells[cellId] : null;
  const cellInfo = cell
    ? `<b>cell #${cellId}</b> · ${cell.blocks.length} blocks · <span class="dim">(${cell.center[0].toFixed(2)}, ${cell.center[1].toFixed(2)})</span>`
    : `<span class="dim">無 cell</span>`;
  cursorInfoEl.innerHTML =
    `<span class="row">${cellInfo}</span>` +
    `<span class="row">hit <b>(${hit.point.x.toFixed(2)}, ${hit.point.y.toFixed(2)}, ${hit.point.z.toFixed(2)})</b></span>` +
    `<span class="row">↪ <b>${action}</b></span>`;
  cursorInfoEl.style.left = `${ev.clientX}px`;
  cursorInfoEl.style.top = `${ev.clientY}px`;
  cursorInfoEl.classList.add('show');
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  const hit = pick(ev.clientX, ev.clientY);
  showHover(hit);
  updateCursorInfo(ev, hit);
});

renderer.domElement.addEventListener('pointerleave', () => {
  if (cursorInfoEl) cursorInfoEl.classList.remove('show');
  showHover(null);
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
    // per-building mesh：用 hit 法線判斷頂面 / 側面，再用 closest-cell 推 cellId
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    if (n && n.y > 0.5) {
      cellId = closestCellAt(hit.point.x, hit.point.z);
      if (cellId >= 0) yBottom = cellTopY(cells[cellId]);
    } else if (n) {
      cellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
      if (cellId >= 0) yBottom = cellTopY(cells[cellId]);
    }
  }
  if (cellId === null || cellId < 0) return;
  const cell = cells[cellId];
  const verts = cell.verts;
  const N = verts.length;
  const isFoundationPlacement = (cell.blocks.length === 0);

  // 決定要預覽什麼形狀：
  //  - 第一次放置 → 預覽地基（從水下到 FOUNDATION_TOP_Y），對應 block[0] 實際形狀
  //  - 疊高樓層 → 預覽 1 格高的方塊在現有頂面之上
  const y0 = isFoundationPlacement ? blockBottomY(0) : yBottom;
  const y1 = isFoundationPlacement ? blockTopY(0)    : yBottom + BLOCK_HEIGHT;
  // 腳印高度：地基模式貼在水面，樓層模式貼在底面之上
  const footprintY = isFoundationPlacement ? (WATER_Y + 0.025) : (y0 + 0.012);

  // === 3D 半透明方塊預覽 ===
  const positions = [], normals = [], indices = [];
  let vb = 0;
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
    opacity: isFoundationPlacement ? 0.45 : 0.60,   // 地基較透（不擋視線），樓層稍實
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    depthWrite: false,
  });
  const ghost = new THREE.Mesh(geom, mat);
  ghostGroup.add(ghost);

  // === Footprint：水面 / 頂面亮白色貼面，標示對應 cell 位置 ===
  const shape = new THREE.Shape(verts.map(v => new THREE.Vector2(v[0], v[1])));
  const fpGeom = new THREE.ShapeGeometry(shape);
  fpGeom.rotateX(Math.PI / 2);
  const footprintMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.40, depthWrite: false, side: THREE.DoubleSide,
  });
  const footprint = new THREE.Mesh(fpGeom, footprintMat);
  footprint.position.y = footprintY;
  ghostGroup.add(footprint);

  // ghost 邊緣線條（白色）
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
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0, depthWrite: false }));
  ghostGroup.add(outline);

  ghostState.cellId = cellId;
  ghostState.y = yBottom;
  ghostState.meshRef = ghost;
  ghostState.outlineRef = outline;
  ghostState.footprintRef = footprint;
}

// 每幀讓 ghost 做細微的上下浮動 & 呼吸透明度
function updateGhost() {
  if (!ghostState.meshRef) return;
  const t = performance.now() / 1000;
  const bob = Math.sin(t * 2.6) * 0.04;
  ghostState.meshRef.position.y = bob;
  if (ghostState.outlineRef) ghostState.outlineRef.position.y = bob;
  // ghost block 呼吸 0.45 ~ 0.65
  const baseOp = ghostState.meshRef.material.opacity > 0.5 ? 0.60 : 0.45;
  ghostState.meshRef.material.opacity = baseOp + Math.sin(t * 3.2) * 0.10;
  if (ghostState.footprintRef) {
    ghostState.footprintRef.material.opacity = 0.40 + Math.sin(t * 3.2 + 0.5) * 0.12;
  }
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
  cells = generateGrid(12, Math.random());
  buildVertexToCells();
  history.length = 0;
  for (const m of buildingMeshes.values()) {
    cellGroup.remove(m);
    m.geometry.dispose();
  }
  buildingMeshes.clear();
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
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

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
  updateGhost();
  const _t = performance.now() * 0.001;
  if (skyMaterial) skyMaterial.uniforms.uTime.value = _t;
  if (composer) composer.render(); else renderer.render(scene, camera);
}
animate();

document.getElementById('loading').classList.add('hidden');
