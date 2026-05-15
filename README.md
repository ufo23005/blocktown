# Blocktown

一個受 [Townscaper](https://oskarstalberg.com/Townscaper/) 啟發的瀏覽器小鎮建築玩具。使用 [Three.js](https://threejs.org/) 與 Delaunay 三角剖分產生不規則格網地形，再以滑鼠堆疊彩色方塊建造屬於自己的小鎮。

> 本專案為動畫程式課程作品，僅供學習與練習使用。

## ✨ 特色

- 🗺️ **程序生成地圖**：以 Delaunay 三角剖分產生有機感的不規則格網
- 🎨 **14 色調色盤**：模仿 Townscaper 的柔和北歐色系
- ☁️ **自訂 Shader 天空**：漸層天空球 + 動態雲層
- 🌫️ **景深霧效**：營造遠近層次
- ↶ **無限復原**：失手不用怕
- ⚡ **零建置依賴**：純 ES Module + Import Map，打開 HTML 就能跑

## 🎮 操作說明

| 操作 | 功能 |
|---|---|
| 滑鼠左鍵點擊 | 放置方塊 |
| 滑鼠右鍵點擊 | 移除方塊 |
| 左鍵拖曳 | 旋轉視角 |
| 中鍵拖曳 | 平移畫面 |
| 滾輪 | 縮放 |
| 數字鍵 `1`–`9`, `0` | 切換顏色 |
| `⌘Z` / `Ctrl+Z` | 復原上一步 |

## 🛠️ 技術棧

- [Three.js 0.160](https://threejs.org/) — 3D 渲染
- [Delaunator](https://github.com/mapbox/delaunator) — 不規則格網生成
- 純 HTML / CSS / JavaScript（ES Module）
- 自訂 GLSL Shader（天空漸層、雲層動畫）

## 🚀 本機執行

由於使用了 ES Module 與 Import Map，需透過 HTTP server 開啟（不能直接點開 HTML）：

```bash
# 方法 1：Python
python3 -m http.server 8000

# 方法 2：Node.js
npx serve .

# 方法 3：VS Code Live Server 擴充套件
```

打開瀏覽器到 `http://localhost:8000` 即可。

## 🌐 部署到 GitHub Pages

1. 推到 GitHub 後，到 repo 的 **Settings → Pages**
2. **Source** 選擇 `Deploy from a branch`
3. **Branch** 選擇 `main` / `/ (root)`
4. 儲存後等候 1-2 分鐘，於 `https://<username>.github.io/blocktown/` 開啟

## 📁 專案結構

```
blocktown/
├── index.html      入口檔案
├── main.js         主要邏輯（場景、互動、地形生成、Shader）
├── styles.css      UI 樣式
└── README.md
```

## 📜 授權與致謝

- 靈感來自 Oskar Stålberg 的 **Townscaper**，本專案為非商業教學練習作品
- Three.js 採 MIT License
- Delaunator 採 ISC License
