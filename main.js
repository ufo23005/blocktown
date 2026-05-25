import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import Delaunator from 'delaunator';
import { LoopSubdivision } from 'three-subdivide';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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

// ===== Townscaper 風地基常數（必須在 _railingPostGeom 等之前宣告）=====
// 地基是「海上獨立平台」概念，不受玩家配色影響，永遠灰藍石色
const FOUNDATION_STONE_COLOR = '#8a96a4';   // 石頭灰藍（牆面，略亮以平衡 brick shader）
const FOUNDATION_TOP_COLOR = '#bda280';     // 地基頂面 tan 色（陶磚地板）
const CORNICE_COLOR = '#9c4838';            // 紅色 cornice 帶（brick red）
const CORNICE_INNER_TOP_COLOR = '#b89070';  // cornice 內側 tan-orange 過渡色：與 floor 自然銜接，
                                            // 但與 FOUNDATION_TOP_COLOR 不同 → 阻止 mergeVertices 合併（避免 dome 變形）
const CORNICE_HEIGHT = 0.10;                // cornice 高度（向下延伸量，從 y1 算）
const CORNICE_BULGE = 0.12;                 // cornice 向外推距離
const CORNICE_INNER_INSET = 0.04;           // cornice 向內推距離（蓋住地板邊緣形成 rim 內側）
const CORNICE_RIM_HEIGHT = 0.04;            // cornice 頂部高出地板的「rim 高度」（小，只是讓 rim 突起在地板之上）
const FOUNDATION_BASE_FLARE = 0.08;         // 地基底部外擴距離（中段自動取 50% → 完整 barrel 曲線）
const RAILING_COLOR = '#2a2a30';            // 鑄鐵欄杆色
const RAILING_HEIGHT = 0.26;                // 欄杆總高
const RAILING_POST_SPACING = 0.30;          // 立柱間距（依邊長均分）
const RAILING_RADIUS = 0.018;               // 立柱與橫桿半徑
// 注意：FOUNDATION_BOTTOM_Y 引用 WATER_Y，但 WATER_Y 在後面才宣告
// → 用 getter 形式延後求值
// 地基底部深埋水下 0.20 → 底部邊隱於水中，又不會讓 ym 太深（避免 wall 頂角 subdivision 下沉過深）
const getFoundationBottomY = () => WATER_Y - 0.20;

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
// 4096² 每幀 1600 萬 depth 取樣，於選單模式靜止場景是浪費。
// 改 2048² 還是 4× 解析度的 PCF soft，視覺差別不大，但 GPU 負擔減 75%
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 80;
const sh = 32;
sun.shadow.camera.left = -sh;
sun.shadow.camera.right = sh;
sun.shadow.camera.top = sh;
sun.shadow.camera.bottom = -sh;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
// 預設 autoUpdate=true → 每幀重算陰影貼圖。改為手動，只在場景變動時 flag needsUpdate
// 選單繞鏡頭時建築完全靜止，省掉這筆每幀 5-30ms 的 GPU work
sun.shadow.autoUpdate = false;
sun.shadow.needsUpdate = true;     // 第一次跑要做一次
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
// Key = `${bid}_${level}_${vidx}` → per-region 隔離，避免跨建築 / 跨層污染
let vertexHeightWeight = new Map();  // region-keyed → 0..1
// 嚴格 region 邊界頂點集合：用於屋簷 overhang 判定（避免 smoothstep 模糊造成邊簷跳躍）
let vertexIsRegionBoundary = new Set();   // region-keyed

// 地基外推位置：對每個頂點，蒐集所有相鄰 cell 的外露邊（地基外圍邊），平均其外側法線。
// 兩個 Map 共用同一個 outward direction：
//  - foundationCorniceBase：頂部 cornice 外推位置（CORNICE_BULGE）
//  - foundationBaseFlare  ：底部 flare 外推位置（FOUNDATION_BASE_FLARE）
// 全域共用 → 同一個 vert 在 A、B 兩個地基的計算結果相同 → 相連地基的外圍自動對齊不斷裂
let foundationCorniceBase = new Map();   // vidx → { x, z }（頂部外推：cornice 外緣）
let foundationCorniceInner = new Map();  // vidx → { x, z }（頂部內推：cornice 內緣，蓋住地板邊緣）
let foundationBaseFlare   = new Map();   // vidx → { x, z }（底部外推：wall barrel）
function computeFoundationCorniceBase() {
  foundationCorniceBase.clear();
  foundationCorniceInner.clear();
  foundationBaseFlare.clear();
  for (const vidx of vertexToCells.keys()) {
    let sumNx = 0, sumNz = 0;
    let count = 0;
    let cellCount = 0;   // 用於凹角偵測
    for (const cid of vertexToCells.get(vidx)) {
      const c = cells[cid];
      if (!c.blocks.length) continue;   // 此 cell 沒有地基
      cellCount++;
      const vi = c.vertIdx.indexOf(vidx);
      if (vi < 0) continue;
      const edgeIndices = [vi, (vi - 1 + c.vertIdx.length) % c.vertIdx.length];
      for (const ei of edgeIndices) {
        const nb = c.neighbors[ei];
        // 鄰格也是地基 → 共邊內部，不貢獻外推方向
        if (nb !== null && cells[nb].blocks.length > 0) continue;
        const ea = c.verts[ei];
        const eb = c.verts[(ei + 1) % c.vertIdx.length];
        const edx = eb[0] - ea[0];
        const edz = eb[1] - ea[1];
        const elen = Math.hypot(edx, edz);
        if (elen > 1e-6) {
          sumNx += -edz / elen;
          sumNz +=  edx / elen;
          count++;
        }
      }
    }
    // === 凹角圓弧處理 ===
    // 偵測 L-shape 內凹角：vert 上有 ≥3 個地基 cell（標準凹角拓樸）
    // 凹角的 push 大幅縮減 → cornice/wall 在凹角處「向內收」→ 形成圓弧過渡
    // 鄰近凸角全 push、凹角 30% push → 中間漸變視覺成弧形
    const isConcave = cellCount >= 3;
    const concaveFactor = isConcave ? 0.3 : 1.0;

    const basePos = vertexPositions.get(vidx);
    if (!basePos) continue;
    const nlen = Math.hypot(sumNx, sumNz);
    if (nlen > 1e-4 && count > 0) {
      const dx = sumNx / nlen;
      const dz = sumNz / nlen;
      foundationCorniceBase.set(vidx, {
        x: basePos[0] + dx * CORNICE_BULGE * concaveFactor,
        z: basePos[1] + dz * CORNICE_BULGE * concaveFactor,
      });
      // 內推：negative dx/dz 方向（朝 cell 內）→ cornice 內緣蓋住地板邊
      foundationCorniceInner.set(vidx, {
        x: basePos[0] - dx * CORNICE_INNER_INSET * concaveFactor,
        z: basePos[1] - dz * CORNICE_INNER_INSET * concaveFactor,
      });
      foundationBaseFlare.set(vidx, {
        x: basePos[0] + dx * FOUNDATION_BASE_FLARE * concaveFactor,
        z: basePos[1] + dz * FOUNDATION_BASE_FLARE * concaveFactor,
      });
    } else {
      // 全是內部頂點（建築深處），不會用到，但保險
      foundationCorniceBase.set(vidx, { x: basePos[0], z: basePos[1] });
      foundationCorniceInner.set(vidx, { x: basePos[0], z: basePos[1] });
      foundationBaseFlare.set(vidx, { x: basePos[0], z: basePos[1] });
    }
  }
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
  computeFoundationCorniceBase();
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
        const key = `${bid}_${level}_${vidx}`;
        if (fraction <= 0.01) {
          vertexIsRegionBoundary.add(key);
        } else {
          // 激進曲線：fraction>=0.5 的頂點（典型相鄰格共邊端點）直接拉到頂端 w=1。
          // 這樣 2 格並排時共邊就完整成為屋脊，形成 Townscaper 風的 gable 而非 dome。
          // fraction<0.5 的少見退化情況才會留中間值。
          const w = Math.min(1, fraction * 2);
          vertexHeightWeight.set(key, w);
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
// 鑄鐵欄杆 group：沿地基外圍頂部包覆
const railingsGroup = new THREE.Group();
scene.add(railingsGroup);
// 水面泡沫 group：每個地基 cell 在水面外擴一圈半透明白色 halo
const foamGroup = new THREE.Group();
scene.add(foamGroup);
// 地基頂面 group：獨立 mesh，跳過 Loop subdivision → corner 精確保留在 cell 邊上、無收縮缺口
const floorsGroup = new THREE.Group();
scene.add(floorsGroup);
// 地基 cornice group：獨立 mesh，跳過 Loop subdivision
// → 避免 cornice 外角被 boundary smoothing 從 (cell+0.04) 拉到 (cell-0.1) 縮進 floor 內
const cornicesGroup = new THREE.Group();
scene.add(cornicesGroup);

// ========== 窗戶 / 大門 凹陷感建構 ==========
// 凹陷原理：外框 ExtrudeGeometry 從 z=0（牆面）向外凸出 FRAME_DEPTH（環狀，中央挖洞），
//   玻璃/門板 ShapeGeometry 放在 z=0（背面） → 從外看洞裡是凹下去的面板
// + vertex color 區分淺色外框 vs 深色玻璃，凹陷感更明顯
const FRAME_DEPTH = 0.03;           // 外框向外凸 3cm（牆外可見部分）
const FRAME_INWARD = 0.02;          // 外框向內延伸 2cm，背蓋埋進牆內隱藏 → 牆與 frame 無縫
const FRAME_THICKNESS = 0.045;       // 外框環狀邊框寬
const DOOR_FRAME_THICKNESS = 0.05;
const FRAME_COLOR = new THREE.Color(0xd8c9a8);   // 暖象牙白
const GLASS_COLOR = new THREE.Color(0x1c2230);   // 深藍黑
const DOOR_FRAME_COLOR = new THREE.Color(0xc8b890);
const DOOR_PANEL_COLOR = new THREE.Color(0x6b3f22);

// 合併 position + index 並烤入 vertex color
function _mergeWithColors(parts) {
  const positions = [];
  const colors = [];
  const indices = [];
  let base = 0;
  for (const { geom, color } of parts) {
    const pos = geom.attributes.position.array;
    const idx = geom.index ? geom.index.array : null;
    const nVerts = pos.length / 3;
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    for (let i = 0; i < nVerts; i++) colors.push(color.r, color.g, color.b);
    if (idx) {
      for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base);
    } else {
      for (let i = 0; i < nVerts; i++) indices.push(base + i);
    }
    base += nVerts;
    geom.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  out.computeVertexNormals();
  return out;
}

// 共用：把 outline + hole 做成 ExtrudeGeometry 外框
// 額外向內延伸 FRAME_INWARD → 背蓋與內側壁的後半段埋進牆內被遮住，杜絕 frame 與牆面之間的空隙
function _extrudeFrame(outerShape, holePath, outwardDepth) {
  outerShape.holes.push(holePath);
  const totalDepth = outwardDepth + FRAME_INWARD;
  const geom = new THREE.ExtrudeGeometry(outerShape, { depth: totalDepth, bevelEnabled: false });
  // 預設 z=0..totalDepth → 平移成 z=-FRAME_INWARD..outwardDepth：背蓋落在牆內，前緣落在牆外
  geom.translate(0, 0, -FRAME_INWARD);
  return geom;
}

// 拱形窗（凹陷）：外框 + 拱形玻璃在背面
function _buildArchedWindowGeom() {
  const w = 0.42, hRect = 0.28;
  const r = w / 2;
  const totalH = hRect + r;
  const cy = totalH / 2;
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, -cy);
  outer.lineTo(w / 2, -cy);
  outer.lineTo(w / 2, -cy + hRect);
  outer.absarc(0, -cy + hRect, r, 0, Math.PI, false);
  outer.lineTo(-w / 2, -cy);
  // 玻璃 outline（內縮）
  const iw = w - 2 * FRAME_THICKNESS;
  const ir = iw / 2;
  const ihRect = hRect - FRAME_THICKNESS;
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, -cy + FRAME_THICKNESS);
  hole.lineTo(iw / 2, -cy + FRAME_THICKNESS);
  hole.lineTo(iw / 2, -cy + FRAME_THICKNESS + ihRect);
  hole.absarc(0, -cy + FRAME_THICKNESS + ihRect, ir, 0, Math.PI, false);
  hole.lineTo(-iw / 2, -cy + FRAME_THICKNESS);
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);

  const glass = new THREE.Shape();
  glass.moveTo(-iw / 2, -cy + FRAME_THICKNESS);
  glass.lineTo(iw / 2, -cy + FRAME_THICKNESS);
  glass.lineTo(iw / 2, -cy + FRAME_THICKNESS + ihRect);
  glass.absarc(0, -cy + FRAME_THICKNESS + ihRect, ir, 0, Math.PI, false);
  glass.lineTo(-iw / 2, -cy + FRAME_THICKNESS);
  const glassGeom = new THREE.ShapeGeometry(glass);
  return _mergeWithColors([
    { geom: frame, color: FRAME_COLOR },
    { geom: glassGeom, color: GLASS_COLOR },
  ]);
}

// 4-pane 十字框窗（凹陷）：外框 + 單片玻璃 + 前置十字 mullion
function _buildCasementWindowGeom() {
  const w = 0.44, h = 0.52;
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, -h / 2); outer.lineTo(w / 2, -h / 2);
  outer.lineTo(w / 2, h / 2);   outer.lineTo(-w / 2, h / 2);
  outer.closePath();
  const iw = w - 2 * FRAME_THICKNESS, ih = h - 2 * FRAME_THICKNESS;
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, -ih / 2); hole.lineTo(iw / 2, -ih / 2);
  hole.lineTo(iw / 2, ih / 2);   hole.lineTo(-iw / 2, ih / 2);
  hole.closePath();
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);

  const glass = new THREE.Shape();
  glass.moveTo(-iw / 2, -ih / 2); glass.lineTo(iw / 2, -ih / 2);
  glass.lineTo(iw / 2, ih / 2);   glass.lineTo(-iw / 2, ih / 2);
  glass.closePath();
  const glassGeom = new THREE.ShapeGeometry(glass);

  // 十字 mullion：放在玻璃前方 1/3 處（z 介於玻璃 0 與外框前 FRAME_DEPTH）
  const mul = 0.018;
  const mulZ = FRAME_DEPTH * 0.45;
  const horiz = new THREE.Shape();
  horiz.moveTo(-iw / 2, -mul / 2); horiz.lineTo(iw / 2, -mul / 2);
  horiz.lineTo(iw / 2, mul / 2);   horiz.lineTo(-iw / 2, mul / 2);
  horiz.closePath();
  const horizG = new THREE.ShapeGeometry(horiz);
  horizG.translate(0, 0, mulZ);
  const vertic = new THREE.Shape();
  vertic.moveTo(-mul / 2, -ih / 2); vertic.lineTo(mul / 2, -ih / 2);
  vertic.lineTo(mul / 2, ih / 2);   vertic.lineTo(-mul / 2, ih / 2);
  vertic.closePath();
  const verticG = new THREE.ShapeGeometry(vertic);
  verticG.translate(0, 0, mulZ);

  return _mergeWithColors([
    { geom: frame, color: FRAME_COLOR },
    { geom: glassGeom, color: GLASS_COLOR },
    { geom: horizG, color: FRAME_COLOR },
    { geom: verticG, color: FRAME_COLOR },
  ]);
}

// 圓窗（凹陷）：圓環外框 + 圓玻璃在背面
function _buildRoundWindowGeom() {
  const R = 0.22, IR = R - FRAME_THICKNESS;
  const SEG = 28;
  const outer = new THREE.Shape();
  for (let i = 0; i < SEG; i++) {
    const a = (Math.PI * 2 * i) / SEG;
    const x = R * Math.cos(a), y = R * Math.sin(a);
    if (i === 0) outer.moveTo(x, y); else outer.lineTo(x, y);
  }
  outer.closePath();
  const hole = new THREE.Path();
  for (let i = 0; i < SEG; i++) {
    const a = (Math.PI * 2 * i) / SEG;
    const x = IR * Math.cos(a), y = IR * Math.sin(a);
    if (i === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
  }
  hole.closePath();
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);

  const glass = new THREE.Shape();
  for (let i = 0; i < SEG; i++) {
    const a = (Math.PI * 2 * i) / SEG;
    const x = IR * Math.cos(a), y = IR * Math.sin(a);
    if (i === 0) glass.moveTo(x, y); else glass.lineTo(x, y);
  }
  glass.closePath();
  const glassGeom = new THREE.ShapeGeometry(glass);

  return _mergeWithColors([
    { geom: frame, color: FRAME_COLOR },
    { geom: glassGeom, color: GLASS_COLOR },
  ]);
}

const _windowGeomVariants = [
  _buildArchedWindowGeom(),
  _buildCasementWindowGeom(),
  _buildRoundWindowGeom(),
];
const _windowMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.4, metalness: 0.15,
  vertexColors: true,
});

// 多個 InstancedMesh（每種 variant 一個）
let windowInstMeshes = [];

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
  // 清掉舊的 instanced meshes
  for (const m of windowInstMeshes) {
    windowsGroup.remove(m);
    m.dispose();
  }
  windowInstMeshes = [];

  // 按 variant 分桶
  const bucketsByVariant = [[], [], []];
  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    const bid = buildingId.get(cell.id);
    if (bid == null) continue;
    // 每棟建築固定一種窗戶 variant
    const variant = ((bid * 0x9E37 + 13) >>> 0) % _windowGeomVariants.length;
    for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
      if (lvl === 0) continue;          // 地基（podium）沒有窗
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[lvl]) continue;
        const isDoorWall = (lvl === 1 && doorWalls.has(`${cell.id}_${i}`));
        const a = cell.verts[i];
        const b = cell.verts[(i + 1) % cell.vertIdx.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const elen = Math.hypot(dx, dz);
        if (elen < 0.6) continue;
        const nx = -dz / elen, nz = dx / elen;
        const y = (blockBottomY(lvl) + blockTopY(lvl)) * 0.5;
        const winCount = elen > 1.4 ? 2 : 1;
        const effective = isDoorWall ? Math.max(0, winCount - 1) : winCount;
        for (let k = 0; k < effective; k++) {
          const t = winCount === 2 ? (0.33 + k * 0.34) : 0.5;
          const px = a[0] + dx * t;
          const pz = a[1] + dz * t;
          // 凹陷窗的 frame back (z=0 local) 對應牆面 → 只需 5mm offset 避免 Z-fight
          bucketsByVariant[variant].push({
            x: px + nx * 0.005,
            y,
            z: pz + nz * 0.005,
            rotY: Math.atan2(nx, nz),
          });
        }
      }
    }
  }
  const tmp = new THREE.Object3D();
  for (let v = 0; v < bucketsByVariant.length; v++) {
    const insts = bucketsByVariant[v];
    if (!insts.length) continue;
    const mesh = new THREE.InstancedMesh(_windowGeomVariants[v], _windowMat, insts.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    for (let i = 0; i < insts.length; i++) {
      tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
      tmp.rotation.set(0, insts[i].rotY, 0);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    windowsGroup.add(mesh);
    windowInstMeshes.push(mesh);
  }
}

// 大門 variant 0：拱形（凹陷）— 外框 + 拱形門板凹進去
function _buildArchedDoorGeom() {
  const w = 0.42, hRect = 0.46, r = w / 2;
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, 0); outer.lineTo(w / 2, 0);
  outer.lineTo(w / 2, hRect);
  outer.absarc(0, hRect, r, 0, Math.PI, false);
  outer.lineTo(-w / 2, 0);
  const iw = w - 2 * DOOR_FRAME_THICKNESS;
  const ir = iw / 2;
  const ihRect = hRect - DOOR_FRAME_THICKNESS;
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, 0); hole.lineTo(iw / 2, 0);
  hole.lineTo(iw / 2, ihRect);
  hole.absarc(0, ihRect, ir, 0, Math.PI, false);
  hole.lineTo(-iw / 2, 0);
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);
  const panel = new THREE.Shape();
  panel.moveTo(-iw / 2, 0); panel.lineTo(iw / 2, 0);
  panel.lineTo(iw / 2, ihRect);
  panel.absarc(0, ihRect, ir, 0, Math.PI, false);
  panel.lineTo(-iw / 2, 0);
  const panelGeom = new THREE.ShapeGeometry(panel);
  return _mergeWithColors([
    { geom: frame, color: DOOR_FRAME_COLOR },
    { geom: panelGeom, color: DOOR_PANEL_COLOR },
  ]);
}

// 大門 variant 1：矩形雙開門（凹陷）— 外框 + 整片門板 + 中央細 mullion 條
// 不留實體縫（避免縫中看到牆面變成亮線），改用前置的細條 mullion 模擬雙開門接縫
function _buildDoubleDoorGeom() {
  const w = 0.50, h = 0.74;
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, 0); outer.lineTo(w / 2, 0);
  outer.lineTo(w / 2, h);  outer.lineTo(-w / 2, h);
  outer.closePath();
  const iw = w - 2 * DOOR_FRAME_THICKNESS;
  const ih = h - DOOR_FRAME_THICKNESS;
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, 0); hole.lineTo(iw / 2, 0);
  hole.lineTo(iw / 2, ih); hole.lineTo(-iw / 2, ih);
  hole.closePath();
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);
  // 整片門板（無實體縫）
  const panel = new THREE.Shape();
  panel.moveTo(-iw / 2, 0); panel.lineTo(iw / 2, 0);
  panel.lineTo(iw / 2, ih); panel.lineTo(-iw / 2, ih);
  panel.closePath();
  // 中央 mullion 條：細條深色，前置於門板（z 略凸）模擬雙開門接縫
  const mulW = 0.018;
  const mullion = new THREE.Shape();
  mullion.moveTo(-mulW / 2, 0); mullion.lineTo(mulW / 2, 0);
  mullion.lineTo(mulW / 2, ih); mullion.lineTo(-mulW / 2, ih);
  mullion.closePath();
  const mullionGeom = new THREE.ShapeGeometry(mullion);
  mullionGeom.translate(0, 0, FRAME_DEPTH * 0.35);
  return _mergeWithColors([
    { geom: frame, color: DOOR_FRAME_COLOR },
    { geom: new THREE.ShapeGeometry(panel), color: DOOR_PANEL_COLOR },
    { geom: mullionGeom, color: DOOR_FRAME_COLOR },
  ]);
}

// 大門 variant 2：矩形單門（凹陷）+ 上方凸出雨遮
function _buildAwningDoorGeom() {
  const w = 0.42, h = 0.68;
  const outer = new THREE.Shape();
  outer.moveTo(-w / 2, 0); outer.lineTo(w / 2, 0);
  outer.lineTo(w / 2, h);  outer.lineTo(-w / 2, h);
  outer.closePath();
  const iw = w - 2 * DOOR_FRAME_THICKNESS;
  const ih = h - DOOR_FRAME_THICKNESS;
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, 0); hole.lineTo(iw / 2, 0);
  hole.lineTo(iw / 2, ih); hole.lineTo(-iw / 2, ih);
  hole.closePath();
  const frame = _extrudeFrame(outer, hole, FRAME_DEPTH);
  const panel = new THREE.Shape();
  panel.moveTo(-iw / 2, 0); panel.lineTo(iw / 2, 0);
  panel.lineTo(iw / 2, ih); panel.lineTo(-iw / 2, ih);
  panel.closePath();
  // 雨遮：矩形板，從牆面向外凸 0.12，置於門上方
  const awningW = w + 0.14, awningT = 0.04, awningD = 0.12;
  const awningGeom = new THREE.BoxGeometry(awningW, awningT, awningD);
  // 雨遮中心 z 取「向後縮 FRAME_INWARD」→ 背面 z=-FRAME_INWARD 埋進牆內隱藏
  awningGeom.translate(0, h + awningT / 2, awningD / 2 - FRAME_INWARD);
  return _mergeWithColors([
    { geom: frame, color: DOOR_FRAME_COLOR },
    { geom: new THREE.ShapeGeometry(panel), color: DOOR_PANEL_COLOR },
    { geom: awningGeom, color: DOOR_FRAME_COLOR },
  ]);
}

const _doorGeomVariants = [
  _buildArchedDoorGeom(),
  _buildDoubleDoorGeom(),
  _buildAwningDoorGeom(),
];
const _doorMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.55, metalness: 0.1,
  vertexColors: true,
});
let doorInstMeshes = [];
// 已被門佔用的牆面：`${cellId}_${edgeIdx}`
// buildDoors 寫入、buildWindows 讀取，避免同一面牆同時放門又放窗
const doorWalls = new Set();

function buildDoors() {
  for (const m of doorInstMeshes) {
    doorsGroup.remove(m);
    m.dispose();
  }
  doorInstMeshes = [];
  doorWalls.clear();
  const bucketsByVariant = [[], [], []];
  // 門數規則：每棟建築最多 ceil(cellCount / 2) 道門
  //   - 1~2 cells → 1 道
  //   - 3~4 cells → 2 道
  //   - 5~6 cells → 3 道
  // 額外限制：相鄰兩 cell 不可同時有門（放完一道後標記該 cell + 同棟鄰居為已佔用）
  // 門放在 FOUNDATION_TOP_Y 高度（站在地基上），需 cell.blocks[1] 存在才能放
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    // 每棟建築固定一種大門 variant
    const variant = ((bid * 0xB519 + 7) >>> 0) % _doorGeomVariants.length;
    const visEdges = [];
    for (const cid of cellIds) {
      const cell = cells[cid];
      if (cell.blocks.length < 2) continue;     // 只有地基沒樓層 → 無門
      for (let i = 0; i < cell.vertIdx.length; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[1]) continue;   // 1 樓共邊 → 內牆
        const a = cell.verts[i], b = cell.verts[(i + 1) % cell.vertIdx.length];
        const elen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (elen < 0.55) continue;
        visEdges.push({ a, b, elen, cellId: cid, edgeIdx: i });
      }
    }
    if (!visEdges.length) continue;
    visEdges.sort((x, y) => y.elen - x.elen);

    const maxDoors = Math.ceil(cellIds.length / 2);
    const blockedCells = new Set();   // 已放門的 cell 或其鄰居
    let placed = 0;

    for (const e of visEdges) {
      if (placed >= maxDoors) break;
      if (blockedCells.has(e.cellId)) continue;   // 此 cell 或鄰居已有門

      doorWalls.add(`${e.cellId}_${e.edgeIdx}`);
      const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1];
      const elen = e.elen;
      const nx = -dz / elen, nz = dx / elen;
      const midX = (e.a[0] + e.b[0]) / 2;
      const midZ = (e.a[1] + e.b[1]) / 2;
      // 同 buildWindows：凹陷大門 frame back 對應牆面，5mm offset 防 Z-fight
      bucketsByVariant[variant].push({
        x: midX + nx * 0.005,
        y: FOUNDATION_TOP_Y,
        z: midZ + nz * 0.005,
        rotY: Math.atan2(nx, nz),
      });
      placed++;

      // 標記此 cell + 所有同棟鄰居為已佔用
      blockedCells.add(e.cellId);
      const cell = cells[e.cellId];
      for (const nb of cell.neighbors) {
        if (nb !== null && buildingId.get(nb) === bid) {
          blockedCells.add(nb);
        }
      }
    }
  }
  const tmp = new THREE.Object3D();
  for (let v = 0; v < bucketsByVariant.length; v++) {
    const insts = bucketsByVariant[v];
    if (!insts.length) continue;
    const mesh = new THREE.InstancedMesh(_doorGeomVariants[v], _doorMat, insts.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    for (let i = 0; i < insts.length; i++) {
      tmp.position.set(insts[i].x, insts[i].y, insts[i].z);
      tmp.rotation.set(0, insts[i].rotY, 0);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    doorsGroup.add(mesh);
    doorInstMeshes.push(mesh);
  }
}

// ===== 鑄鐵欄杆：包圍地基外圍頂部 =====
// 立柱：細直圓柱（6 邊）；橫桿：水平圓柱，用 scale.x 拉長到邊長
const _railingPostGeom = new THREE.CylinderGeometry(RAILING_RADIUS, RAILING_RADIUS, RAILING_HEIGHT, 6);
// 橫桿用 1.0 單位長，再透過 scale.x 拉伸到實際邊長
const _railingBarGeom = new THREE.CylinderGeometry(RAILING_RADIUS * 0.85, RAILING_RADIUS * 0.85, 1.0, 6);
// rotateZ(-π/2)：把 CylinderGeometry 預設的 +Y 軸轉成 +X 軸（橫向）
// 這樣 instance 的 scale.x 直接控制橫桿長度
_railingBarGeom.rotateZ(-Math.PI / 2);
const _railingMat = new THREE.MeshStandardMaterial({
  color: RAILING_COLOR,
  roughness: 0.55,
  metalness: 0.35,
});
// 立柱頂端小球（finial）：略大半徑的球體
const _railingFinialGeom = new THREE.SphereGeometry(RAILING_RADIUS * 1.7, 8, 6);

let railingPostInst = null;
let railingBarInst = null;
let railingFinialInst = null;

function buildRailings() {
  if (railingPostInst) {
    railingsGroup.remove(railingPostInst);
    railingPostInst.dispose();
    railingPostInst = null;
  }
  if (railingBarInst) {
    railingsGroup.remove(railingBarInst);
    railingBarInst.dispose();
    railingBarInst = null;
  }
  if (railingFinialInst) {
    railingsGroup.remove(railingFinialInst);
    railingFinialInst.dispose();
    railingFinialInst = null;
  }

  const postInsts = [];
  const barInsts = [];
  const finialInsts = [];

  for (const cell of cells) {
    if (!cell.blocks.length) continue;   // 沒地基 → 沒欄杆
    const N = cell.vertIdx.length;
    for (let i = 0; i < N; i++) {
      const nei = cell.neighbors[i];
      if (nei !== null && cells[nei].blocks.length > 0) continue;   // 內部邊，不放欄杆
      if (doorWalls.has(`${cell.id}_${i}`)) continue;                // 大門所在邊：欄杆讓出空間避免重疊

      const vidxA = cell.vertIdx[i];
      const vidxB = cell.vertIdx[(i + 1) % N];
      const cA = foundationCorniceBase.get(vidxA);
      const cB = foundationCorniceBase.get(vidxB);
      const iA = foundationCorniceInner.get(vidxA);
      const iB = foundationCorniceInner.get(vidxB);
      if (!cA || !cB || !iA || !iB) continue;

      // 欄杆 XZ 位置：放在 cornice 的「中間」(inner 與 outer 的平均)
      // → 從外面看不會太靠邊，視覺上立在紅磚帶正中
      const mA_x = (iA.x + cA.x) / 2;
      const mA_z = (iA.z + cA.z) / 2;
      const mB_x = (iB.x + cB.x) / 2;
      const mB_z = (iB.z + cB.z) / 2;

      const ex = mB_x - mA_x, ez = mB_z - mA_z;
      const elen = Math.hypot(ex, ez);
      if (elen < 1e-4) continue;
      // 橫桿 local +X (取自 _railingBarGeom rotateZ(-π/2)) 經 rotation.y=θ 後
      // 變成 (cos θ, 0, -sin θ)；要對齊邊方向 (ex/e, 0, ez/e):
      //   cos θ = ex/e, -sin θ = ez/e → θ = atan2(-ez, ex)
      const angle = Math.atan2(-ez, ex);

      // 立柱：依邊長等分
      const numPosts = Math.max(2, Math.round(elen / RAILING_POST_SPACING) + 1);
      for (let p = 0; p < numPosts; p++) {
        const t = p / (numPosts - 1);
        const px = mA_x + ex * t;
        const pz = mA_z + ez * t;
        postInsts.push({
          x: px,
          y: FOUNDATION_TOP_Y + CORNICE_RIM_HEIGHT + RAILING_HEIGHT * 0.5,   // CylinderGeometry 是中心對齊
          z: pz,
        });
        // 立柱頂端小球
        finialInsts.push({
          x: px,
          y: FOUNDATION_TOP_Y + CORNICE_RIM_HEIGHT + RAILING_HEIGHT + RAILING_RADIUS * 0.3,
          z: pz,
        });
      }

      // 上下兩條橫桿：頂桿 + 中桿
      const barYTop = FOUNDATION_TOP_Y + CORNICE_RIM_HEIGHT + RAILING_HEIGHT - RAILING_RADIUS * 2;
      const barYMid = FOUNDATION_TOP_Y + CORNICE_RIM_HEIGHT + RAILING_HEIGHT * 0.45;
      const midX = (mA_x + mB_x) / 2;
      const midZ = (mA_z + mB_z) / 2;
      for (const by of [barYTop, barYMid]) {
        barInsts.push({ x: midX, y: by, z: midZ, scale: elen, rotY: angle });
      }
    }
  }

  if (postInsts.length > 0) {
    railingPostInst = new THREE.InstancedMesh(_railingPostGeom, _railingMat, postInsts.length);
    railingPostInst.castShadow = true;
    railingPostInst.receiveShadow = false;
    const tmp = new THREE.Object3D();
    for (let i = 0; i < postInsts.length; i++) {
      tmp.position.set(postInsts[i].x, postInsts[i].y, postInsts[i].z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      railingPostInst.setMatrixAt(i, tmp.matrix);
    }
    railingPostInst.instanceMatrix.needsUpdate = true;
    railingsGroup.add(railingPostInst);
  }

  if (barInsts.length > 0) {
    railingBarInst = new THREE.InstancedMesh(_railingBarGeom, _railingMat, barInsts.length);
    railingBarInst.castShadow = true;
    railingBarInst.receiveShadow = false;
    const tmp = new THREE.Object3D();
    for (let i = 0; i < barInsts.length; i++) {
      tmp.position.set(barInsts[i].x, barInsts[i].y, barInsts[i].z);
      tmp.rotation.set(0, barInsts[i].rotY, 0);
      tmp.scale.set(barInsts[i].scale, 1, 1);
      tmp.updateMatrix();
      railingBarInst.setMatrixAt(i, tmp.matrix);
    }
    railingBarInst.instanceMatrix.needsUpdate = true;
    railingsGroup.add(railingBarInst);
  }

  if (finialInsts.length > 0) {
    railingFinialInst = new THREE.InstancedMesh(_railingFinialGeom, _railingMat, finialInsts.length);
    railingFinialInst.castShadow = true;
    railingFinialInst.receiveShadow = false;
    const tmp = new THREE.Object3D();
    for (let i = 0; i < finialInsts.length; i++) {
      tmp.position.set(finialInsts[i].x, finialInsts[i].y, finialInsts[i].z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      railingFinialInst.setMatrixAt(i, tmp.matrix);
    }
    railingFinialInst.instanceMatrix.needsUpdate = true;
    railingsGroup.add(railingFinialInst);
  }
}

// ===== 水面泡沫光暈 =====
// 每個地基 cell 在水面位置畫一圈半透明白色 ring（cell 外擴 FOAM_RADIUS）
// 動態：環形波紋向外擴散 + 微呼吸 + 飄移雜訊，呈現「水浪打在牆上」的動態感
const FOAM_RADIUS = 0.55;
const FOAM_INNER_ALPHA = 0.62;
const _foamMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uInnerAlpha: { value: FOAM_INNER_ALPHA },
  },
  vertexShader: `
    attribute float radialT;       // 0 = 內邊（貼牆）, 1 = 外邊（最外圍）
    varying float vRadialT;
    varying vec2 vWorldXZ;
    void main() {
      vRadialT = radialT;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldXZ = wp.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform float uInnerAlpha;
    varying float vRadialT;
    varying vec2 vWorldXZ;

    // 簡易 value noise（用於泡沫飄移雜訊）
    float hash21(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
      float t = vRadialT;   // 0 (內) → 1 (外)

      // (1) 基礎徑向漸層：靠近牆面較亮，向外淡出
      float fade = pow(1.0 - t, 1.4);

      // (2) 微呼吸：整體 alpha 緩慢起伏（0.85~1.15）
      float breath = 0.85 + sin(uTime * 0.7) * 0.15;

      // (3) 向外傳播的環形波紋（亮帶）
      //     相位 = t * 頻率 − time * 速度，使亮帶從內向外移動
      float wavePhase = t * 16.0 - uTime * 2.0;
      float wave = sin(wavePhase) * 0.5 + 0.5;
      float waveHighlight = smoothstep(0.55, 0.95, wave) * 0.35;
      // 第二層波紋，頻率略不同 → 兩波交疊，更自然
      float wavePhase2 = t * 11.0 - uTime * 1.4 + 1.7;
      float wave2 = sin(wavePhase2) * 0.5 + 0.5;
      float waveHighlight2 = smoothstep(0.65, 0.95, wave2) * 0.20;
      float ripples = (waveHighlight + waveHighlight2) * fade;

      // (4) 飄移雜訊：sparkle 感
      vec2 noiseUV = vWorldXZ * 2.5 + vec2(uTime * 0.12, uTime * 0.09);
      float foamNoise = vnoise(noiseUV);
      float sparkle = smoothstep(0.62, 0.88, foamNoise) * 0.30 * fade;

      // 合成 alpha
      float alpha = fade * breath * 0.5 + ripples + sparkle;
      alpha = clamp(alpha, 0.0, 1.0) * uInnerAlpha;

      gl_FragColor = vec4(0.95, 0.97, 1.0, alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// 追蹤一棟建築的外輪廓周長（按 cell.verts CW 順序連成 closed loop）
// 回傳 [loop1, loop2, ...]，每個 loop 是 vidx 陣列（首尾不重複）
// 一般 simply-connected 建築只有一個 loop
function traceBuildingPerimeter(cellIds) {
  const cellIdSet = new Set(cellIds);
  // 每個 perimeter edge: fromVidx → toVidx
  // 收集成 outgoingMap: fromVidx → [toVidx, ...]
  const outgoingMap = new Map();
  for (const cid of cellIds) {
    const cell = cells[cid];
    for (let i = 0; i < cell.vertIdx.length; i++) {
      const nb = cell.neighbors[i];
      // 共邊內部（同棟）→ 不是 perimeter
      if (nb !== null && cellIdSet.has(nb)) continue;
      const fromV = cell.vertIdx[i];
      const toV = cell.vertIdx[(i + 1) % cell.vertIdx.length];
      if (!outgoingMap.has(fromV)) outgoingMap.set(fromV, []);
      outgoingMap.get(fromV).push(toV);
    }
  }
  // 從每個未訪問的 edge 開始追蹤 loop
  const visited = new Set();
  const loops = [];
  for (const [startFrom, edges] of outgoingMap.entries()) {
    for (const startTo of edges) {
      const startKey = `${startFrom}_${startTo}`;
      if (visited.has(startKey)) continue;
      const loop = [];
      let curFrom = startFrom, curTo = startTo;
      while (true) {
        const key = `${curFrom}_${curTo}`;
        if (visited.has(key)) break;
        visited.add(key);
        loop.push(curFrom);
        const nextList = outgoingMap.get(curTo);
        if (!nextList || nextList.length === 0) break;
        // 找下一條未訪問的 outgoing edge
        let nextTo = null;
        for (const cand of nextList) {
          if (!visited.has(`${curTo}_${cand}`)) { nextTo = cand; break; }
        }
        if (nextTo === null) break;
        curFrom = curTo;
        curTo = nextTo;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function buildWaterFoam() {
  disposeGroup(foamGroup);

  // 每棟建築一個統一的 foam ring（從建築外輪廓向外擴）
  for (let bid = 0; bid < buildingCells.length; bid++) {
    const cellIds = buildingCells[bid];
    if (!cellIds || !cellIds.length) continue;

    const loops = traceBuildingPerimeter(cellIds);

    for (const loop of loops) {
      // 內 path：建築外輪廓（vertexPositions 取得每個 vidx 的世界位置）
      const innerPath = loop.map(vidx => {
        const p = vertexPositions.get(vidx);
        return { x: p[0], z: p[1] };
      });

      // 外 path：外輪廓向外擴 FOAM_RADIUS
      // 用 foundationCorniceBase 推斷外推方向（已包含凹角 concaveFactor）：
      //   方向 × FOAM_RADIUS = (corniceBase − vert) × (FOAM_RADIUS / CORNICE_BULGE)
      const factor = FOAM_RADIUS / CORNICE_BULGE;
      const outerPath = loop.map(vidx => {
        const inP = vertexPositions.get(vidx);
        const corB = foundationCorniceBase.get(vidx);
        if (!corB) return { x: inP[0], z: inP[1] };
        return {
          x: inP[0] + (corB.x - inP[0]) * factor,
          z: inP[1] + (corB.z - inP[1]) * factor,
        };
      });

      // 建 Shape (outer) + hole (inner) → 環狀 mesh
      const shape = new THREE.Shape(outerPath.map(p => new THREE.Vector2(p.x, p.z)));
      const hole = new THREE.Path();
      hole.moveTo(innerPath[0].x, innerPath[0].z);
      for (let i = 1; i < innerPath.length; i++) {
        hole.lineTo(innerPath[i].x, innerPath[i].z);
      }
      hole.closePath();
      shape.holes.push(hole);

      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(Math.PI / 2);
      geom.translate(0, WATER_Y + 0.015, 0);

      // radialT: ShapeGeometry 產生的 vert 順序為 [outer..., hole...]
      // outer verts = 1（最外，foam 邊緣），inner verts = 0（最內，貼建築外牆）
      const outerCount = outerPath.length;
      const posCount = geom.attributes.position.count;
      const radialT = new Float32Array(posCount);
      for (let i = 0; i < posCount; i++) {
        radialT[i] = i < outerCount ? 1.0 : 0.0;
      }
      geom.setAttribute('radialT', new THREE.Float32BufferAttribute(radialT, 1));

      const mesh = new THREE.Mesh(geom, _foamMat);
      mesh.renderOrder = 0.5;
      foamGroup.add(mesh);
    }
  }
}

// ===== 地基頂面（獨立 mesh，跳過 Loop subdivision）=====
// 這是修正 corner 缺口的關鍵：Loop subdivision 對 boundary corner 強制內縮 0.125
// 把地面拆出 buildingMesh 後，corner 完全保留在 cell 邊上 → cornice 紅帶緊鄰 floor edge 無縫
let foundationFloorsMesh = null;
function buildFoundationFloors() {
  if (foundationFloorsMesh) {
    floorsGroup.remove(foundationFloorsMesh);
    foundationFloorsMesh.geometry.dispose();
    foundationFloorsMesh = null;
  }

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertBase = 0;
  const tan = new THREE.Color(FOUNDATION_TOP_COLOR);

  for (const cell of cells) {
    // 只要有地基就畫地板（蓋了樓層也保留 → 樓層站在地板上而非取代地板）
    // 地板在 cell 內側（center→perim 扇形），樓層牆在 cell perim → 共邊不重疊
    if (!cell.blocks.length) continue;
    const bid = buildingId.get(cell.id);
    if (bid == null) continue;

    const verts = cell.verts;
    const N = verts.length;
    const cx = cell.center[0];
    const cz = cell.center[1];

    // 同 buildingMesh 的 tint 計算邏輯，保持每棟視覺一致
    const baseTint = buildingTint(bid);
    const lh = ((cell.id * 7919) >>> 0);
    const tintR = baseTint[0] * (1 + (((lh & 0x7F) / 127) - 0.5) * 0.04);
    const tintG = baseTint[1] * (1 + ((((lh >> 7) & 0x7F) / 127) - 0.5) * 0.04);
    const tintB = baseTint[2] * (1 + ((((lh >> 14) & 0x7F) / 127) - 0.5) * 0.04);
    const pushVert = (ao) => colors.push(
      ao * tintR * tan.r,
      ao * tintG * tan.g,
      ao * tintB * tan.b,
    );

    // === 只畫地基頂面 floor ===
    // 中間層 floor 之前是為了「防止從屋頂看穿到水面」但實際上屋頂封閉、牆完整、窗戶不挖洞，
    // 看不到建築物內部 → 中間 floor 完全用不到。
    // 且中間 floor 沒有 cornice 蓋住邊緣，會因「floor 在 cell perim、wall 因 subdivision 內縮」
    // 凸出來變成可見的小陽台 → 移除。地基頂這層的凸出邊由 cornice 紅磚帶遮住，所以保留。
    const yLvl = blockTopY(0);
    const startV = vertBase;
    for (let i = 0; i < N; i++) {
      positions.push(verts[i][0], yLvl, verts[i][1]);
      normals.push(0, 1, 0);
      pushVert(AO_WALL_MID);
    }
    positions.push(cx, yLvl, cz);
    normals.push(0, 1, 0);
    pushVert(AO_TOP_CENTER);

    const centerIdx = startV + N;
    vertBase += N + 1;
    for (let i = 0; i < N; i++) {
      indices.push(centerIdx, startV + i, startV + (i + 1) % N);
    }
  }

  if (!indices.length) return;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeBoundingSphere();

  // 共用 buildingMaterial → 自動享有 shader 的 tile grid 圖案
  foundationFloorsMesh = new THREE.Mesh(geom, buildingMaterial);
  foundationFloorsMesh.castShadow = false;
  foundationFloorsMesh.receiveShadow = true;
  // 互動標記：點擊 floor → 在那個 cell 上疊樓層
  foundationFloorsMesh.userData = { type: 'foundation_top' };
  floorsGroup.add(foundationFloorsMesh);
}

// ===== 地基 Cornice（紅磚帶）獨立 mesh =====
// 與 floor 同策略：跳過 Loop subdivision 避免 boundary 收縮
// Subdivision 會把 cornice 外角從 (cell+0.04) 拉到 (cell-0.1)，整個縮進 floor 內 → 不可用
// 獨立 mesh 保留精確的「牆頂邊緣 + bulge 外推」位置
let foundationCornicesMesh = null;
function buildFoundationCornices() {
  if (foundationCornicesMesh) {
    cornicesGroup.remove(foundationCornicesMesh);
    foundationCornicesMesh.geometry.dispose();
    foundationCornicesMesh = null;
  }

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vertBase = 0;
  const corniceColor = new THREE.Color(CORNICE_COLOR);

  for (const cell of cells) {
    if (!cell.blocks.length) continue;
    const bid = buildingId.get(cell.id);
    if (bid == null) continue;

    const N = cell.vertIdx.length;
    const y1 = FOUNDATION_TOP_Y;
    const yCorBot = y1 - CORNICE_HEIGHT;
    const yCorTop = y1 + CORNICE_RIM_HEIGHT;   // 抬高至地板之上，形成 rim

    // tint per cell（與 wall 同邏輯）
    const baseTint = buildingTint(bid);
    const lh = ((cell.id * 7919) >>> 0);
    const tintR = baseTint[0] * (1 + (((lh & 0x7F) / 127) - 0.5) * 0.04);
    const tintG = baseTint[1] * (1 + ((((lh >> 7) & 0x7F) / 127) - 0.5) * 0.04);
    const tintB = baseTint[2] * (1 + ((((lh >> 14) & 0x7F) / 127) - 0.5) * 0.04);
    const pushVert = (ao) => colors.push(
      ao * tintR * corniceColor.r,
      ao * tintG * corniceColor.g,
      ao * tintB * corniceColor.b,
    );

    for (let i = 0; i < N; i++) {
      const nei = cell.neighbors[i];
      if (nei !== null && cells[nei].blocks.length > 0) continue;  // 內部邊，無 cornice

      const vidxA = cell.vertIdx[i];
      const vidxB = cell.vertIdx[(i + 1) % N];
      const cA = foundationCorniceBase.get(vidxA);
      const cB = foundationCorniceBase.get(vidxB);
      const iA = foundationCorniceInner.get(vidxA);   // 內推位置
      const iB = foundationCorniceInner.get(vidxB);
      if (!cA || !cB || !iA || !iB) continue;

      const a = cell.verts[i], b = cell.verts[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const nx = -dz / len, nz = dx / len;

      const startV = vertBase;
      // 8 verts（內外都加寬）：
      // 0/4: inner-bot (cell - inset, yCorBot), 1/5: inner-top (cell - inset, yCorTop)
      // 2/6: outer-top (cell + bulge, yCorTop), 3/7: outer-bot (cell + bulge, yCorBot)
      positions.push(
        iA.x, yCorBot, iA.z,    // 0 inner-bot-A
        iA.x, yCorTop, iA.z,    // 1 inner-top-A
        cA.x, yCorTop, cA.z,    // 2 outer-top-A
        cA.x, yCorBot, cA.z,    // 3 outer-bot-A
        iB.x, yCorBot, iB.z,    // 4 inner-bot-B
        iB.x, yCorTop, iB.z,    // 5 inner-top-B
        cB.x, yCorTop, cB.z,    // 6 outer-top-B
        cB.x, yCorBot, cB.z,    // 7 outer-bot-B
      );
      for (let k = 0; k < 8; k++) normals.push(nx, 0, nz);
      pushVert(AO_WALL_CORNER); pushVert(AO_WALL_MID); pushVert(AO_WALL_MID); pushVert(AO_WALL_CORNER);
      pushVert(AO_WALL_CORNER); pushVert(AO_WALL_MID); pushVert(AO_WALL_MID); pushVert(AO_WALL_CORNER);
      vertBase += 8;

      // Front face (vertical at outer): (3,7,6)(3,6,2) → 外向 +n 法線
      indices.push(startV + 3, startV + 7, startV + 6);
      indices.push(startV + 3, startV + 6, startV + 2);
      // Bottom soffit: (0,4,7)(0,7,3) → −y 法線
      indices.push(startV + 0, startV + 4, startV + 7);
      indices.push(startV + 0, startV + 7, startV + 3);
      // Top ledge: (1,2,6)(1,6,5) → +y 法線（紅磚 rim 頂面，從上方看見）
      indices.push(startV + 1, startV + 2, startV + 6);
      indices.push(startV + 1, startV + 6, startV + 5);
      // Inner face (vertical at inner): (0,1,5)(0,5,4) → 內向法線（從 cell 內看見的 rim 內側面）
      indices.push(startV + 0, startV + 1, startV + 5);
      indices.push(startV + 0, startV + 5, startV + 4);
    }
  }

  if (!indices.length) return;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeBoundingSphere();

  // 共用 buildingMaterial → 享有 shader 的 brick pattern
  foundationCornicesMesh = new THREE.Mesh(geom, buildingMaterial);
  foundationCornicesMesh.castShadow = true;
  foundationCornicesMesh.receiveShadow = true;
  cornicesGroup.add(foundationCornicesMesh);
}

function refreshDecorations() {
  rebuildBuildings();
  buildBaseGridLines();
  buildDoors();              // 先建門 → 填入 doorWalls
  buildWindows();            // 再建窗 → 讀取 doorWalls 避開門牆
  buildRailings();           // 沿地基外圍包覆鑄鐵欄杆
  buildWaterFoam();          // 地基外圍水面泡沫光暈
  buildFoundationFloors();   // 地基頂面（獨立 mesh）
  buildFoundationCornices(); // 地基 cornice 紅磚帶（獨立 mesh，避開 subdivision 收縮）
}

// ===== 裝飾刷新節流：連點放方塊時合併到下一個 RAF =====
let _decorPending = false;
function scheduleDecorRefresh() {
  if (_decorPending) return;
  _decorPending = true;
  requestAnimationFrame(() => {
    _decorPending = false;
    buildBaseGridLines();
    buildDoors();              // 順序與 refreshDecorations 一致
    buildWindows();
    buildRailings();
    buildWaterFoam();
    buildFoundationFloors();
    buildFoundationCornices();
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

       // 地基範圍（須與 JS FOUNDATION_TOP_Y=0.3 一致）
       const float FOUNDATION_TOP = 0.3;

       // ===== 朝上的水平面 =====
       // 用 abs(wN.y) 處理 DoubleSide（背面 normal 反向時仍能正確偵測水平面）
       float upN = abs(wN.y);
       float roofW = smoothstep(0.25, 0.55, upN);
       if (roofW > 0.0) {
         // 嚴格水平面（floor/cornice 等未 subdivide 的 mesh）→ tile grid
         // 帶曲率的水平面（subdivided block 屋頂）→ dot pattern
         if (upN > 0.95) {
           // 地板/cornice 頂面：方塊磚地板 grid
           vec2 t = vWPos.xz * 2.8;
           vec2 local = fract(t);
           float gapX = smoothstep(0.0, 0.045, local.x) * smoothstep(1.0, 0.955, local.x);
           float gapY = smoothstep(0.0, 0.045, local.y) * smoothstep(1.0, 0.955, local.y);
           float tile = gapX * gapY;
           vec2 tileId = floor(t);
           float bright = 0.80 + fract(sin(dot(tileId, vec2(12.9898, 78.233))) * 43758.5453) * 0.32;
           diffuseColor.rgb *= mix(0.62, bright, tile);
         } else {
           // 樓層屋頂：圓點瓦片（既有）
           vec2 t = vWPos.xz * uTileScale;
           if (mod(floor(t.y), 2.0) > 0.5) t.x += 0.5;
           vec2 local = fract(t) - 0.5;
           float d = length(local);
           float dotVal = smoothstep(0.44, 0.28, d);
           diffuseColor.rgb *= (1.0 - dotVal * uTileStrength * roofW);
         }
       }

       // ===== 垂直面（牆面）=====
       float wallW = smoothstep(0.30, 0.12, abs(wN.y));
       if (wallW > 0.0) {
         if (vWPos.y < FOUNDATION_TOP) {
           // 地基牆 + cornice 紅帶：柔化的不規則磚石紋路
           // 用 (wN.z, 0, -wN.x) 作水平切向 → 沿牆面方向取座標，與 x/z 對齊
           vec3 horizT = vec3(wN.z, 0.0, -wN.x);
           float horizCoord = dot(vWPos, horizT);
           float brickH = 0.16;
           float brickW = 0.32;
           float row = floor(vWPos.y / brickH);
           float rowOffset = mod(row, 2.0) * 0.5;
           float xLocal = fract(horizCoord / brickW + rowOffset);
           float yLocal = fract(vWPos.y / brickH);
           // 細的 mortar 線：更窄但更銳利 → 平滑表面 + 清晰磚塊邊界
           float gapX2 = smoothstep(0.0, 0.028, xLocal) * smoothstep(1.0, 0.972, xLocal);
           float gapY2 = smoothstep(0.0, 0.032, yLocal) * smoothstep(1.0, 0.968, yLocal);
           float gap = gapX2 * gapY2;
           // 磚塊亮度：壓縮變化幅度 → 整體更平滑，不會「斑駁」
           float brickId = floor(horizCoord / brickW + rowOffset) * 13.0 + row * 7.31;
           float bright = 0.92 + fract(sin(brickId * 12.9898) * 43758.5453) * 0.16;
           // Mortar 變淡（0.72）而非變深（0.48），整體不會壓暗
           diffuseColor.rgb *= mix(0.72, bright, gap);

           // === 水線白帶：在水面附近混入淡白色，與外側 foam 連成一氣 ===
           // 須與 JS WATER_Y=-0.8 一致
           const float WATER_Y_S = -0.8;
           float waterlineBlend = smoothstep(0.08, 0.0, abs(vWPos.y - WATER_Y_S));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.98), waterlineBlend * 0.45);
         } else {
           // 樓層牆：水平木板紋（既有）
           float stripe = fract(vWPos.y * uPlankScale);
           float gap = smoothstep(0.0, 0.06, stripe) * smoothstep(1.0, 0.94, stripe);
           diffuseColor.rgb *= (1.0 - (1.0 - gap) * uPlankStrength * wallW);
         }
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
    side: THREE.DoubleSide,    // 解決屋簷下底/樓層 ceiling 從特定角度透明問題
  });
  return injectBlockShader(mat);
})();

// 每個建築一個合併 mesh，套用 Loop subdivision 後變圓潤。
// 共用幾何常數（提到 module scope 避免在 rebuild 內重複宣告）
const ROOF_OVERHANG = 0.22;   // 屋簷外推（A-frame 風格），原 0.12
const EAVE_DROOP = 0.03;       // 屋簷略垂下，營造瓦片下垂感
const ROOF_THICKNESS = 0.10;   // 屋頂厚度（頂面到底面的 Y 距離）
const WALL_BULGE = 0;   // 牆面外凸量：0 = 垂直牆（Townscaper barrel 桶形拿掉）
const ROOF_COLOR_INDICES = [1, 2, 11];   // PALETTE: 紅/橙/棕
// 注意：Townscaper 地基常數（FOUNDATION_STONE_COLOR、CORNICE_*、RAILING_*）
// 必須在檔案頂端宣告，因為 _railingPostGeom 等在更上方就用到了。
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
  // 三角形屋頂高度：單格放大為 1.25，2-3 格 1.05，多格 0.85（隨 footprint 大小自動降低斜度防止屋頂過尖）
  const ROOF_HEIGHT = cellIds.length <= 1 ? 1.25 : (cellIds.length <= 3 ? 1.05 : 0.85);

  let vertBase = 0;

  for (const cellId of cellIds) {
    const cell = cells[cellId];
    const verts = cell.verts;
    const N = verts.length;
    const cx = cell.center[0];
    const cz = cell.center[1];

    for (let lvl = 0; lvl < cell.blocks.length; lvl++) {
      const block = cell.blocks[lvl];
      // 地基 (lvl=0) 強制使用石頭色，忽略 block.color；樓層 (lvl>=1) 才用玩家配色
      // → Townscaper 概念：地基是環境平台，不是房屋的一部分
      const wallColor = lvl === 0
        ? new THREE.Color(FOUNDATION_STONE_COLOR)
        : new THREE.Color(PALETTE[block.color]);
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
      // 地基頂面 tan 色（提到此處共用 → cornice inner-top 也能用 pushFloor，
      // 與地面 perimeter 在同位置同顏色 → mergeVertices 自動合併）
      const floorTileColorObj = new THREE.Color(FOUNDATION_TOP_COLOR);
      const pushFloor = (ao) => colors.push(
        ao * tint[0] * floorTileColorObj.r,
        ao * tint[1] * floorTileColorObj.g,
        ao * tint[2] * floorTileColorObj.b,
      );

      // 高度：lvl=0 是地基（從水下底到 FOUNDATION_TOP_Y），lvl≥1 是樓層 (BLOCK_HEIGHT)
      const y0 = blockBottomY(lvl);
      const y1 = blockTopY(lvl);
      const isTop = lvl === cell.blocks.length - 1;
      const isFoundation = lvl === 0;

      // === 屋頂底 (roof base)：先算好供牆頂與 roof fan 共用 ===
      // 把 boundary 屋簷外推 / interior 抬升 / blocked 齊牆頂 三種邏輯抽到此處一次運算，
      // 然後牆頂直接走到 roof base → 牆 / 屋簷 / 屋頂三者完全無縫，不會有透明空洞
      let roofBase = null;
      if (isTop && !isFoundation) {
        roofBase = new Array(N);
        for (let k = 0; k < N; k++) {
          const vidx = cell.vertIdx[k];
          const regionKey = `${bid}_${lvl}_${vidx}`;
          const w = vertexHeightWeight.get(regionKey) ?? 0;
          const isStrictBoundary = vertexIsRegionBoundary.has(regionKey);
          let px = verts[k][0], pz = verts[k][1], py;

          // === 水平外推：所有 boundary vert（含 ridge）都推 22cm → 屋簷均勻不縮減 ===
          // 跨 region 累加所有同 region cell 的非共邊法線 → 共邊兩端推外方向跨 cell 一致，無裂縫
          // 牆頂跟 roofBase.y 但 XZ 留在 cell perim → 牆在 ridge 端垂直延伸成 gable 牆，
          //   屋簷在外側 22cm 同樣升高，中間用 soffit 水平條銜接
          let nxSum = 0, nzSum = 0;
          let nonInternalCount = 0;
          for (const cid of vertexToCells.get(vidx)) {
            if (buildingId.get(cid) !== bid) continue;
            const c = cells[cid];
            if (!c.blocks[lvl]) continue;
            const vi = c.vertIdx.indexOf(vidx);
            if (vi < 0) continue;
            const edgeIndices = [vi, (vi - 1 + c.vertIdx.length) % c.vertIdx.length];
            for (const ei of edgeIndices) {
              const nb = c.neighbors[ei];
              const internal = nb !== null && cells[nb].blocks[lvl];
              if (internal) continue;
              const blocking = nb !== null && cells[nb].blocks.length > lvl + 1;
              if (blocking) continue;
              const ea = c.verts[ei];
              const eb = c.verts[(ei + 1) % c.vertIdx.length];
              const edx = eb[0] - ea[0];
              const edz = eb[1] - ea[1];
              const elen2 = Math.hypot(edx, edz);
              if (elen2 > 1e-6) {
                nxSum += -edz / elen2;
                nzSum +=  edx / elen2;
                nonInternalCount++;
              }
            }
          }
          const nlen = Math.hypot(nxSum, nzSum);
          if (nonInternalCount > 0 && nlen > 1e-4) {
            px += (nxSum / nlen) * ROOF_OVERHANG;
            pz += (nzSum / nlen) * ROOF_OVERHANG;
          }

          // === Y：ridge raise 或 eave droop ===
          if (isStrictBoundary) {
            py = nonInternalCount > 0 ? (y1 - EAVE_DROOP) : y1;
          } else {
            py = y1 + w * ROOF_HEIGHT;
          }

          roofBase[k] = { x: px, y: py, z: pz, w };
        }
      }

      // 牆面：3×5 細分（5 rows）含「對稱 anchor row」緊鄰頂部與底部
      // 為什麼用 5 rows：4-row 只有 top anchor，Loop subdivision 把 Row 0 角拉向 Row 1（中段），
      //   floor wall 底角從 y0=0.30 被拉到 0.42（上浮 12cm，看起來不貼地）。
      //   加 bot anchor row 在 y0+0.04 處 → Row 0 角的鄰居都接近 y0 → 底角下沉 < 1cm。
      // Row 0 (bottom):     y0, 100% flare for foundation
      // Row 1 (bot anchor): y0+0.04, ~97% flare       ★新增
      // Row 2 (mid):        (y0+topAy)/2, 50% flare
      // Row 3 (top anchor): topAy-0.04, ~3% flare
      // Row 4 (top):        topAy, 0% flare (or roofBase)
      const ANCHOR_OFFSET = 0.04;
      const T_BOT_ANCHOR = 0.04;   // t 在 [0,1] 沿 Y 方向，bot anchor 位於 4% 處
      const T_MID = 0.5;
      const T_TOP_ANCHOR = 0.96;
      for (let i = 0; i < N; i++) {
        const nei = cell.neighbors[i];
        if (nei !== null && cells[nei].blocks[lvl]) continue;
        const a = verts[i], b = verts[(i + 1) % N];
        const ax = a[0], az = a[1], bx = b[0], bz = b[1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        const nx = -dz / len, nz = dx / len;

        // === 牆「底」位置（Row 0）：foundation 100% flare，floor 0 flare ===
        let botAx = ax, botAz = az;
        let botBx = bx, botBz = bz;
        let botMx = mx, botMz = mz;
        let flareA = null, flareB = null;
        if (isFoundation) {
          flareA = foundationBaseFlare.get(cell.vertIdx[i]);
          flareB = foundationBaseFlare.get(cell.vertIdx[(i + 1) % N]);
          if (flareA && flareB) {
            botAx = flareA.x; botAz = flareA.z;
            botBx = flareB.x; botBz = flareB.z;
            botMx = (botAx + botBx) / 2;
            botMz = (botAz + botBz) / 2;
          }
        }

        // === 牆「頂」位置（Row 4）===
        // 牆面強制垂直：XZ 鎖在 cell perim
        // 頂層 Y 跟 roofBase.y 升到 ridge 形成垂直 gable 三角牆，但 cap 在 (apex - SAFETY)
        // 避免牆頂頂點與屋頂 apex 共平面導致 Z-fight 破圖
        const WALL_TOP_SAFETY = 0.10;     // 牆頂留 10cm 給屋頂，保證不貼面
        const wallTopMaxY = y1 + ROOF_HEIGHT - WALL_TOP_SAFETY;
        let topAx = ax, topAy = y1, topAz = az;
        let topBx = bx, topBy = y1, topBz = bz;
        let topMx = mx, topMy = y1, topMz = mz;
        if (roofBase) {
          const rA = roofBase[i];
          const rB = roofBase[(i + 1) % N];
          topAy = Math.min(rA.y, wallTopMaxY);
          topBy = Math.min(rB.y, wallTopMaxY);
          topMy = (topAy + topBy) / 2;
        }

        // === 中央 bulge（樓層才有）：只對 Row 2 中央生效 ===
        const bulge = isFoundation ? 0 : Math.min(WALL_BULGE, len * 0.08);

        // === 透過 t lerp 算各 row 的 XZ 與 Y ===
        // t=0 為 bot，t=1 為 top，XZ 與 Y 都線性內插
        const interp = (t) => {
          const aax = botAx + (topAx - botAx) * t;
          const aaz = botAz + (topAz - botAz) * t;
          const aay = y0 + (topAy - y0) * t;
          const bbx = botBx + (topBx - botBx) * t;
          const bbz = botBz + (topBz - botBz) * t;
          const bby = y0 + (topBy - y0) * t;
          const mmx = botMx + (topMx - botMx) * t;
          const mmz = botMz + (topMz - botMz) * t;
          const mmy = y0 + (topMy - y0) * t;
          return { aax, aay, aaz, bbx, bby, bbz, mmx, mmy, mmz };
        };

        const r0 = { aax: botAx, aay: y0, aaz: botAz, bbx: botBx, bby: y0, bbz: botBz, mmx: botMx, mmy: y0, mmz: botMz };
        const r1 = interp(T_BOT_ANCHOR);     // bot anchor
        const r2 = interp(T_MID);             // mid（含 bulge）
        const r3 = interp(T_TOP_ANCHOR);      // top anchor
        const r4 = { aax: topAx, aay: topAy, aaz: topAz, bbx: topBx, bby: topBy, bbz: topBz, mmx: topMx, mmy: topMy, mmz: topMz };

        // Row 2 中央加 bulge（沿牆外側法線推出）
        const r2_cmx = r2.mmx + nx * bulge;
        const r2_cmz = r2.mmz + nz * bulge;

        // === Push 15 verts（5 rows × 3 cols）===
        positions.push(
          // Row 0 (verts 0-2): bottom
          r0.aax, r0.aay, r0.aaz,    r0.mmx, r0.mmy, r0.mmz,       r0.bbx, r0.bby, r0.bbz,
          // Row 1 (verts 3-5): bot anchor ★新增
          r1.aax, r1.aay, r1.aaz,    r1.mmx, r1.mmy, r1.mmz,       r1.bbx, r1.bby, r1.bbz,
          // Row 2 (verts 6-8): mid（含 bulge）
          r2.aax, r2.aay, r2.aaz,    r2_cmx, r2.mmy, r2_cmz,       r2.bbx, r2.bby, r2.bbz,
          // Row 3 (verts 9-11): top anchor
          r3.aax, r3.aay, r3.aaz,    r3.mmx, r3.mmy, r3.mmz,       r3.bbx, r3.bby, r3.bbz,
          // Row 4 (verts 12-14): top
          r4.aax, r4.aay, r4.aaz,    r4.mmx, r4.mmy, r4.mmz,       r4.bbx, r4.bby, r4.bbz,
        );
        for (let k = 0; k < 15; k++) normals.push(nx, 0, nz);
        // AO pattern: Row 0 + Row 4 corners 偏暗，其他 mid
        pushWall(AO_WALL_CORNER); pushWall(AO_WALL_MID); pushWall(AO_WALL_CORNER);  // Row 0
        pushWall(AO_WALL_MID);    pushWall(AO_WALL_MID); pushWall(AO_WALL_MID);     // Row 1 anchor
        pushWall(AO_WALL_MID);    pushWall(AO_WALL_MID); pushWall(AO_WALL_MID);     // Row 2 mid
        pushWall(AO_WALL_MID);    pushWall(AO_WALL_MID); pushWall(AO_WALL_MID);     // Row 3 anchor
        pushWall(AO_WALL_CORNER); pushWall(AO_WALL_MID); pushWall(AO_WALL_CORNER);  // Row 4
        // 16 三角形（8 quads = 4 垂直 × 2 水平）
        indices.push(
          // Row 0 → Row 1 (bot anchor 緊鄰底 → boundary smoothing 不會把底角拉上)
          vertBase + 0, vertBase + 1, vertBase + 4,   vertBase + 0, vertBase + 4, vertBase + 3,
          vertBase + 1, vertBase + 2, vertBase + 5,   vertBase + 1, vertBase + 5, vertBase + 4,
          // Row 1 → Row 2
          vertBase + 3, vertBase + 4, vertBase + 7,   vertBase + 3, vertBase + 7, vertBase + 6,
          vertBase + 4, vertBase + 5, vertBase + 8,   vertBase + 4, vertBase + 8, vertBase + 7,
          // Row 2 → Row 3
          vertBase + 6, vertBase + 7, vertBase + 10,  vertBase + 6, vertBase + 10, vertBase + 9,
          vertBase + 7, vertBase + 8, vertBase + 11,  vertBase + 7, vertBase + 11, vertBase + 10,
          // Row 3 → Row 4 (top anchor 緊鄰頂 → boundary smoothing 不會把頂角拉下)
          vertBase + 9,  vertBase + 10, vertBase + 13,  vertBase + 9,  vertBase + 13, vertBase + 12,
          vertBase + 10, vertBase + 11, vertBase + 14,  vertBase + 10, vertBase + 14, vertBase + 13,
        );
        vertBase += 15;

        // === Soffit（屋簷下底）：把垂直牆頂 → 外推 roofBase 的 horizontal 縫補起來 ===
        // 只有頂層、且 roofBase 在 boundary vert 處有外推（rA/rB 與 cell perim XZ 不同）才需要
        // 沒有外推的內部 vert（ridge）→ 退化三角形不會渲染，無傷
        if (roofBase) {
          const rA = roofBase[i];
          const rB = roofBase[(i + 1) % N];
          const rMx = (rA.x + rB.x) / 2;
          const rMy = (rA.y + rB.y) / 2;
          const rMz = (rA.z + rB.z) / 2;
          // 3 個 soffit verts：對應 Row 4 三 column 外推位置
          positions.push(
            rA.x, rA.y, rA.z,
            rMx, rMy, rMz,
            rB.x, rB.y, rB.z,
          );
          // soffit 向下：normal (0, -1, 0)
          for (let k = 0; k < 3; k++) normals.push(0, -1, 0);
          pushWall(AO_WALL_CORNER); pushWall(AO_WALL_MID); pushWall(AO_WALL_CORNER);
          // 4 個 triangle 接到 Row 4 (vertBase-3..-1 = 牆頂 12,13,14)
          // Row 4: a=vertBase-3, m=vertBase-2, b=vertBase-1
          // Soffit: ra=vertBase, rm=vertBase+1, rb=vertBase+2
          // 法線朝下，CCW 看下方為正：(a, ra, m) → (m, ra, rm) → (m, rm, b) → (b, rm, rb)
          indices.push(
            vertBase - 3, vertBase + 0, vertBase - 2,
            vertBase - 2, vertBase + 0, vertBase + 1,
            vertBase - 2, vertBase + 1, vertBase - 1,
            vertBase - 1, vertBase + 1, vertBase + 2,
          );
          vertBase += 3;
        }
      }

      // 地基底面：封住 lvl=0 的水下底（深埋於 water 之下）
      // 底面也用 foundationBaseFlare 位置以對齊牆 bottom row
      if (lvl === 0) {
        const startV = vertBase;
        for (let i = 0; i < N; i++) {
          const flare = foundationBaseFlare.get(cell.vertIdx[i]);
          const px = flare ? flare.x : verts[i][0];
          const pz = flare ? flare.z : verts[i][1];
          positions.push(px, y0, pz);
          normals.push(0, -1, 0);
          pushWall(AO_BOTTOM);
        }
        vertBase += N;
        for (let i = 1; i < N - 1; i++) {
          indices.push(startV, startV + i + 1, startV + i);
        }
      }

      // === Cornice 紅色薄條（沿著牆頂邊緣生成）===
      // 設計：薄高 0.05 的紅磚條緊貼牆頂，外推 0.04 形成小鑲邊
      // 為什麼薄條：4-row 牆面 barrel 曲線在低 Y 處外推大（y=0.10 處 0.016 外推），
      //   若 cornice 太高會與 barrel 衝突。改為只在 y=0.255~0.305 範圍（牆頂附近 wall ≤0.008 外推），
      //   小幅外推 0.04 就能完全跳開 barrel，cornice 完全可見
      // 「牆頂在哪 cornice 就在那」：cornice 範圍貼著 wall row 3 (y=y1) 與 row 2 (y=0.26)，
      //   foundationCorniceBase 使用 cell 頂點計算，與 wall 共用同樣的邊形
      //
      // 結構（per segment, 8 verts）：
      //   - inner-bot/top in cell perim（被外推 cornice 蓋住，從外面看不到）
      //   - outer-bot/top in cell + CORNICE_BULGE（紅磚 band 主體）
      // Faces：
      //   - Front face (vertical at outer)：薄紅磚帶，從側面看
      //   - Top ledge (horizontal at yCorTop)：花圃外緣，從上面看
      //   - Bottom soffit (horizontal at yCorBot)：仰望時看到的屋簷底
      // 加 +0.005 nudge 到 yCorTop 防止與 floor 在 y=y1 Z-fight
      // Cornice 已移至獨立 mesh (buildFoundationCornices) 處理
      // → 跳過 Loop subdivision 的 boundary 收縮，cornice 外角保留在 cell + bulge 外側

      // 頂面處理：
      //  - 地基為最頂層（只有地基無樓層）→ 畫「平頂蓋」，無屋頂
      //  - 樓層為最頂層 → 畫斜屋頂
      //  - 中間樓層（被上層覆蓋）→ 不畫頂
      if (isTop && isFoundation) {
        // 地基平頂改由獨立的 buildFoundationFloors() 處理（不參與 Loop subdivision）
        // → 避免 subdivision boundary 收縮造成 corner 處 0.125 寬的「凹陷缺口」
        // 此處刻意不畫，留給 floorsGroup
      } else if (isTop) {
        // === 樓層屋頂：斜屋頂（3 層幾何：頂面 + 底面 + 屋簷側壁，仿 door/window frame 凹陷做法）===

        // (1) 外層 fan — 屋頂頂面
        const baseStart = vertBase;
        let cellMaxW = 0;
        let perimMaxY = -Infinity;
        for (let i = 0; i < N; i++) {
          const b = roofBase[i];
          if (b.w > cellMaxW) cellMaxW = b.w;
          if (b.y > perimMaxY) perimMaxY = b.y;
          positions.push(b.x, b.y, b.z);
          normals.push(0, 1, 0);
          pushRoof(AO_ROOF_BASE + (AO_TOP_CENTER - AO_ROOF_BASE) * b.w);
        }
        vertBase += N;
        // Apex 位置：原樣式
        //   - 單 cell（無共邊）：apex 在 cell 中心、全 pyramid 高度 → 標準金字塔
        //   - 多 cell（有共邊）：apex 在共邊中點平均、Y = ridge 高度
        //     ➜ 1 條共邊時 apex 與 V0、V1 共線 → degenerate 三角形（無扁平）
        //     ➜ 2+ 條共邊時 apex 落 cell 中心 → V_ridge/apex 同高但不共線 → 中段會扁平（已知 trade-off）
        let apexX = cx, apexZ = cz, apexY;
        if (cellMaxW < 0.01) {
          apexY = y1 + ROOF_HEIGHT;
        } else {
          let sharedSumX = 0, sharedSumZ = 0, sharedCount = 0;
          for (let i = 0; i < N; i++) {
            const nei = cell.neighbors[i];
            if (nei !== null && cells[nei].blocks[lvl]) {
              const va = verts[i], vb = verts[(i + 1) % N];
              sharedSumX += (va[0] + vb[0]) * 0.5;
              sharedSumZ += (va[1] + vb[1]) * 0.5;
              sharedCount++;
            }
          }
          if (sharedCount > 0) {
            apexX = sharedSumX / sharedCount;
            apexZ = sharedSumZ / sharedCount;
          }
          apexY = perimMaxY;
        }
        positions.push(apexX, apexY, apexZ);
        normals.push(0, 1, 0);
        pushRoof(AO_ROOF_APEX);
        const apexIdx = vertBase;
        vertBase += 1;
        for (let i = 0; i < N; i++) {
          indices.push(baseStart + i, baseStart + (i + 1) % N, apexIdx);
        }

        // (2) 內層 fan — 屋頂底面（整體下移 ROOF_THICKNESS，反向 winding 法線朝下）
        // 仰望屋簷時看到的「下底」，AO ×0.55 較暗模擬陰影
        const innerStart = vertBase;
        for (let i = 0; i < N; i++) {
          const b = roofBase[i];
          positions.push(b.x, b.y - ROOF_THICKNESS, b.z);
          normals.push(0, -1, 0);
          pushRoof((AO_ROOF_BASE + (AO_TOP_CENTER - AO_ROOF_BASE) * b.w) * 0.55);
        }
        vertBase += N;
        positions.push(apexX, apexY - ROOF_THICKNESS, apexZ);
        normals.push(0, -1, 0);
        pushRoof(AO_ROOF_APEX * 0.55);
        const innerApexIdx = vertBase;
        vertBase += 1;
        for (let i = 0; i < N; i++) {
          // 反向：(i+1, i, apex) 而非 (i, i+1, apex)
          indices.push(innerStart + (i + 1) % N, innerStart + i, innerApexIdx);
        }

        // (3) 屋簷側壁 — 厚度可見條帶
        // 只在 boundary edges（沒同 region 鄰格）建側壁；共邊位置由鄰格屋頂接過去
        for (let i = 0; i < N; i++) {
          const nei = cell.neighbors[i];
          if (nei !== null && cells[nei].blocks[lvl]) continue;
          const o_i = baseStart + i;
          const o_n = baseStart + (i + 1) % N;
          const in_i = innerStart + i;
          const in_n = innerStart + (i + 1) % N;
          // 法線朝外（離 cell 中心）：(o_i, in_i, in_n) + (o_i, in_n, o_n)
          indices.push(o_i, in_i, in_n);
          indices.push(o_i, in_n, o_n);
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

  // 取消 Loop subdivision：
  //  - 牆已強制垂直、屋頂為單環扇形 → subdivision 只會把 apex 周圍 vert「拉向平均」變不規則球面（屋頂凹凸不平）
  //  - 同時把 boundary（牆頂、soffit、roofBase）vert 拉內收 → 與其他獨立 mesh 不對齊產生細縫透明
  //  - 不需 mergeVertices 因為已無 subdivision 平滑需求；保留分離 vert 讓法線維持 flat 面
  geom.computeVertexNormals();
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
  // 先 refresh：refreshDecorations() 內部會 rebuildBuildings() 重算 buildingCells，
  // 否則下面的迴圈會跑在「過時」的 buildingCells 上（首次種 demo town 時就是空的）
  refreshDecorations();
  for (let bid = 0; bid < buildingCells.length; bid++) {
    rebuildBuildingMesh(bid);
  }
  sun.shadow.needsUpdate = true;   // 場景變動 → 下一幀重算陰影
}

refreshDecorations();
buildGroundPick();

// ===== 開始選單：示範小鎮（讓首頁背景有風景看）=====
// 在中央附近隨機種一批方塊，營造「正在發生」的小鎮畫面
function seedDemoTown(seed = 0xC0FFEE) {
  // 簡單 LCG，種子穩定 → 同次預覽不會抖動
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // 依離中心距離排序，取最內部約一半 cell，再隨機洗牌挑一部分蓋
  const sorted = [...cells].sort((a, b) =>
    Math.hypot(a.center[0], a.center[1]) - Math.hypot(b.center[0], b.center[1])
  );
  const pool = sorted.slice(0, Math.max(8, Math.floor(cells.length * 0.45)));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const target = Math.max(6, Math.floor(pool.length * 0.55));

  for (let i = 0; i < target; i++) {
    const c = pool[i];
    // 避開最外圈，讓示範看起來是中央聚落
    if (Math.hypot(c.center[0], c.center[1]) > 9) continue;
    const color = 1 + Math.floor(rnd() * (PALETTE.length - 1));
    // 必須連續疊（blocks 不能稀疏，否則 rebuildBuildingMesh 會炸）
    c.blocks.push({ color });                                 // 地基
    if (rnd() < 0.85) {
      c.blocks.push({ color });                               // 1 樓
      if (rnd() < 0.55) {
        c.blocks.push({ color });                             // 2 樓
        if (rnd() < 0.22) c.blocks.push({ color });           // 3 樓（少見）
      }
    }
  }
  rebuildAll();
}

function clearAllBlocks() {
  for (const c of cells) c.blocks = [];
  rebuildAll();
}

// 初始：先種一座示範小鎮供選單背景顯示
seedDemoTown(Date.now() & 0x7FFFFFFF);

// ===== 選單模式：鏡頭自動繞行 + 停用 OrbitControls =====
let menuMode = true;
controls.enabled = false;        // 選單模式時使用者不能拖鏡頭
const MENU_ORBIT_RADIUS = 24;
const MENU_ORBIT_HEIGHT = 16;
const MENU_ORBIT_SPEED  = 0.05;  // rad/sec — 緩慢繞行
let menuOrbitT = Math.random() * Math.PI * 2;   // 初始角度隨機

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
  const a = raycaster.intersectObjects(cellGroup.children, false);          // 牆/屋頂/cornice (in buildingMesh)
  const b = raycaster.intersectObjects(groundPickGroup.children, false);    // 空地隱形 pick 平面
  const c = raycaster.intersectObjects(floorsGroup.children, false);        // 地基頂面 (獨立 mesh，需納入才能在頂上疊樓)
  const all = a.concat(b).concat(c);
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
  sun.shadow.needsUpdate = true;   // 玩家放/拆方塊 → 重算陰影
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
    // 右鍵：移除頂層方塊
    if (ud.type === 'column' || ud.type === 'foundation_top') {
      const cellId = closestCellAt(hit.point.x, hit.point.z);
      if (cellId >= 0) removeTopBlock(cellId);
    }
    return;
  }

  if (ud.type === 'ground') {
    addBlock(ud.cellId, 0);
    return;
  }
  // 左鍵點擊地基頂面 → 在該 cell 上疊樓層
  if (ud.type === 'foundation_top') {
    const cellId = closestCellAt(hit.point.x, hit.point.z);
    if (cellId >= 0) addBlock(cellId, cells[cellId].blocks.length);
    return;
  }
  if (ud.type === 'column') {
    // 屋頂厚度引入了「法線朝下的內層 fan」與「法線水平的屋簷側壁」，純看 n.y 無法區分。
    // 改用 hit.point.y 比較該 cell 的牆頂高度：在牆頂以上 = 屋頂區域不論法線朝哪 → 往上疊
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const cellId = closestCellAt(hit.point.x, hit.point.z);
    if (cellId >= 0) {
      const wallTop = cellTopY(cells[cellId]);
      if (hit.point.y > wallTop - 0.05) {
        // 屋頂區域（含頂面、屋簷下底、側壁厚度條帶）→ 往上疊
        addBlock(cellId, cells[cellId].blocks.length);
      } else if (n) {
        // 牆面 → 朝 normal 外側推 0.6 找鄰格
        const targetCellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
        if (targetCellId >= 0) {
          addBlock(targetCellId, cells[targetCellId].blocks.length);
        }
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
  } else if (ud.type === 'foundation_top') {
    cellId = closestCellAt(hit.point.x, hit.point.z);
    if (cellId >= 0) action = `疊第 ${cells[cellId].blocks.length} 層`;
  } else if (ud.type === 'column') {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const cid = closestCellAt(hit.point.x, hit.point.z);
    if (cid >= 0) {
      const wallTop = cellTopY(cells[cid]);
      if (hit.point.y > wallTop - 0.05) {
        cellId = cid;
        action = `疊第 ${cells[cellId].blocks.length} 層`;
      } else if (n) {
        cellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
        if (cellId >= 0) action = cells[cellId].blocks.length ? `疊第 ${cells[cellId].blocks.length} 層` : '建地基';
      }
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
  } else if (ud.type === 'foundation_top') {
    // 地基頂面：在該 cell 上疊樓層
    cellId = closestCellAt(hit.point.x, hit.point.z);
    if (cellId >= 0) yBottom = cellTopY(cells[cellId]);
  } else if (ud.type === 'column') {
    // per-building mesh：hit.point.y 與該 cell 牆頂比較（覆蓋屋頂內層 fan + 側壁）
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    const cid = closestCellAt(hit.point.x, hit.point.z);
    if (cid >= 0) {
      const wallTop = cellTopY(cells[cid]);
      if (hit.point.y > wallTop - 0.05) {
        cellId = cid;
        yBottom = cellTopY(cells[cellId]);
      } else if (n) {
        cellId = closestCellAt(hit.point.x + n.x * 0.6, hit.point.z + n.z * 0.6);
        if (cellId >= 0) yBottom = cellTopY(cells[cellId]);
      }
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
  // 地基永遠石色（不受 currentColor 影響），讓 ghost 與實際結果一致
  const col = isFoundationPlacement
    ? new THREE.Color(FOUNDATION_STONE_COLOR)
    : new THREE.Color(PALETTE[currentColor]);
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

// ===== 開始選單按鈕串接 =====
const startScreenEl = document.getElementById('start-screen');
const modalHowto = document.getElementById('modal-howto');
const modalAbout = document.getElementById('modal-about');

function openModal(el) { el.classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }

// 「開始建造」：清除示範小鎮 → 淡出選單 → 啟用控制
document.getElementById('btn-start').addEventListener('click', () => {
  if (!menuMode) return;
  clearAllBlocks();
  history.length = 0;
  startScreenEl.classList.add('hidden');
  document.body.classList.remove('menu-active');
  // 等淡出動畫進行中順便把鏡頭過渡到玩家視角
  menuMode = false;
  controls.enabled = true;
  // 給一個友善的初始視角（與 camera.position.set 初值一致）
  camera.position.set(22, 18, 22);
  controls.target.set(0, 1, 0);
  desiredTarget.set(0, 1, 0);
  updateFocus();
});

// 「換一座島」：重新生成地圖 + 示範小鎮，停留在選單模式
document.getElementById('btn-shuffle').addEventListener('click', async () => {
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
  seedDemoTown(Date.now() & 0x7FFFFFFF);
  document.getElementById('loading').classList.add('hidden');
});

document.getElementById('btn-howto').addEventListener('click', () => openModal(modalHowto));
document.getElementById('btn-about').addEventListener('click', () => openModal(modalAbout));

// ===== 專案技術介紹頁（PROJECT INFO）=====
const infoScreen = document.getElementById('info-screen');
let infoRevealObserver = null;

function openInfo() {
  infoScreen.classList.remove('hidden');
  infoScreen.setAttribute('aria-hidden', 'false');
  document.body.classList.add('info-open');
  // 重置：再次開啟時清掉舊的 .is-revealed，讓動畫再播一次
  infoScreen.querySelectorAll('[data-reveal].is-revealed')
            .forEach(el => el.classList.remove('is-revealed'));
  // 等下一個 frame 讓 visibility 切換完成、layout 穩定，再啟動 reveal 與 observer
  requestAnimationFrame(() => {
    infoScreen.scrollTop = 0;
    revealVisibleNow();           // 立即把目前在 viewport 內的元素揭露
    startInfoObserver();          // 之後 scroll 觸發剩餘元素
  });
}
function closeInfo() {
  infoScreen.classList.add('hidden');
  infoScreen.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('info-open');
  // 銷毀 observer，下次開啟重建
  if (infoRevealObserver) {
    infoRevealObserver.disconnect();
    infoRevealObserver = null;
  }
}

document.getElementById('btn-info').addEventListener('click', openInfo);
infoScreen.querySelectorAll('[data-info-close]').forEach(el =>
  el.addEventListener('click', closeInfo)
);

// 立即揭露：把目前在 viewport 內的 [data-reveal] 加 .is-revealed
// 用 setTimeout stagger 製造由上而下的進場節奏（hero 統計卡卡片之間錯開 80ms）
function revealVisibleNow() {
  const targets = Array.from(infoScreen.querySelectorAll('[data-reveal]'));
  const vh = window.innerHeight;
  let stagger = 0;
  for (const el of targets) {
    const rect = el.getBoundingClientRect();
    if (rect.top < vh - 40) {                   // 在 viewport 內或臨界外緣
      setTimeout(() => el.classList.add('is-revealed'), stagger);
      stagger += 70;
    }
  }
}

// IntersectionObserver：負責 scroll 後段的 reveal（hero 之後 scroll 到才看見的卡片）
function startInfoObserver() {
  if (infoRevealObserver) return;
  infoRevealObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !e.target.classList.contains('is-revealed')) {
        e.target.classList.add('is-revealed');
        infoRevealObserver.unobserve(e.target);
      }
    }
  }, {
    root: infoScreen,
    threshold: 0.1,
    rootMargin: '0px 0px -60px 0px',
  });
  infoScreen.querySelectorAll('[data-reveal]:not(.is-revealed)')
            .forEach(el => infoRevealObserver.observe(el));
}

// Modal 關閉：✕ 按鈕 / 點背景 / Esc
document.querySelectorAll('[data-close]').forEach(b => {
  b.addEventListener('click', () => closeModal(b.closest('.modal')));
});
[modalHowto, modalAbout].forEach(m => {
  m.addEventListener('click', (ev) => {
    if (ev.target === m) closeModal(m);   // 點到背景才關，點到卡片內不關
  });
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    // 由內向外關：modal > info-screen
    if (!modalHowto.classList.contains('hidden')) closeModal(modalHowto);
    else if (!modalAbout.classList.contains('hidden')) closeModal(modalAbout);
    else if (!infoScreen.classList.contains('hidden')) closeInfo();
  }
});

// 「回到選單」：保留現有建築物當作下次預覽
document.getElementById('btn-back-menu').addEventListener('click', () => {
  if (menuMode) return;
  menuMode = true;
  controls.enabled = false;
  document.body.classList.add('menu-active');
  startScreenEl.classList.remove('hidden');
  setMenuActive(-1);   // 重置鍵盤選中狀態
});

// ===== 選單鍵盤導航 =====
// ↑/↓ 移動高亮、Enter / Space 觸發、滑鼠移入會讓位（避免鍵盤與 hover 雙重高亮）
const menuItemsEls = Array.from(document.querySelectorAll('#start-menu-buttons .menu-item'));
let menuActiveIdx = -1;   // -1 = 無預設選中

function setMenuActive(idx) {
  menuActiveIdx = idx;
  menuItemsEls.forEach((el, i) => {
    if (i === idx) el.setAttribute('data-active', '');
    else el.removeAttribute('data-active');
  });
}

// 滑鼠進入任一項 → 清掉鍵盤選中（hover 接手高亮）
menuItemsEls.forEach(el => {
  el.addEventListener('pointerenter', () => {
    if (menuActiveIdx >= 0) setMenuActive(-1);
  });
});

document.addEventListener('keydown', (ev) => {
  if (!menuMode) return;
  // 有 modal 開著 → Esc 由原本 handler 處理，箭頭/Enter 不要動
  if (!modalHowto.classList.contains('hidden') || !modalAbout.classList.contains('hidden')) return;

  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    setMenuActive(menuActiveIdx < 0 ? 0 : (menuActiveIdx + 1) % menuItemsEls.length);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    setMenuActive(menuActiveIdx <= 0 ? menuItemsEls.length - 1 : menuActiveIdx - 1);
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    if (menuActiveIdx >= 0) {
      ev.preventDefault();
      menuItemsEls[menuActiveIdx].click();
    }
  }
});

// ===== 主迴圈 =====
// 用真實 delta time 跑動畫，避免「假設 60fps」造成的停頓感
// clampDt：tab 切走 / 重操作後一次累積太多 ms，這裡截斷以免鏡頭跳秒
let _lastFrameT = performance.now();
const MAX_DT = 0.1;   // 100ms 上限

function animate() {
  requestAnimationFrame(animate);

  const _now = performance.now();
  const dt = Math.min(MAX_DT, (_now - _lastFrameT) / 1000);
  _lastFrameT = _now;

  if (menuMode) {
    // 選單模式：鏡頭緩慢繞著小鎮中心轉（牆鐘等速，frame time 無關）
    menuOrbitT += MENU_ORBIT_SPEED * dt;
    const angle = menuOrbitT;
    camera.position.set(
      Math.cos(angle) * MENU_ORBIT_RADIUS,
      MENU_ORBIT_HEIGHT,
      Math.sin(angle) * MENU_ORBIT_RADIUS,
    );
    controls.target.set(0, 2, 0);
    camera.lookAt(controls.target);
    // 同步 desiredTarget，離開選單時不會被舊值拉回
    desiredTarget.set(0, 1, 0);
  } else {
    // 編輯模式：平滑追焦
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
  }

  const _t = performance.now() * 0.001;
  if (skyMaterial) skyMaterial.uniforms.uTime.value = _t;
  if (_foamMat) _foamMat.uniforms.uTime.value = _t;   // 水波紋動態

  // PROJECT INFO 全螢幕黑底時 canvas 完全被擋住 → 跳過 render 省整套 GPU pipeline
  // menuOrbitT 仍然 dt 累加，info-screen 關掉後鏡頭已在正確位置
  const canvasObscured = !infoScreen.classList.contains('hidden');
  if (!canvasObscured) {
    if (composer) composer.render(); else renderer.render(scene, camera);
  }
}
animate();

document.getElementById('loading').classList.add('hidden');
