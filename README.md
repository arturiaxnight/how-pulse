# how-pulse

Heart of Worship 節拍器

即時同步視覺節拍器 WebApp（FastAPI + 原生前端 + WebSocket + Web Worker）。

## Changelog

### 2026-06-11 — 跨裝置拍點同步大修

- **音訊改為預先排程**：拍點改用 Web Audio `source.start(when)` 在硬體時鐘上提前排程（lookahead 300ms），不再依賴 10ms tick 輪詢即時觸發，消除 tick 粒度與事件迴圈延遲
- **輸出延遲補償**：依 `outputLatency`/`baseLatency` 提前播放，補償不同裝置喇叭管線延遲
- **本地時基改用 `performance.now()`**（單調時鐘）：避免手機系統 NTP 校時跳動造成單一裝置拍點瞬間偏移
- **Offset 演算法重寫**：改用滑動視窗（10 筆）取最低 RTT 樣本，修正舊版「歷史最佳 RTT 閘門」導致 offset 凍結、漂移無法修正的問題；大偏移（>300ms）視為時鐘跳動直接跳轉並重排音訊
- **同步判定收緊**：`synced` 門檻由 RTT < 700ms 收緊為視窗最低 RTT < 200ms，鼓手面板「已對時」數字更可信
- **Wake Lock**：播放中保持螢幕常亮，避免手機鎖屏節流計時器、暫停音訊
- **音檔預載**：解鎖音訊時預載 A/B 兩種模式音檔，第一拍不再被 decode 時間吃掉
- **後端時鐘改用 monotonic**（錨定啟動時 epoch）：伺服器 NTP 校時不再影響節拍時間軸
- **broadcast 改為並行送出**：單一慢速 client 不再拖延其他裝置收到 start/state
- **自適應對時頻率**：未達 reliable 前每 500ms 對時快速收斂，穩定後退回 2s；收到 start 指令時利用倒數空檔補發 sync burst，確保第一拍前 offset 剛校正過
- **sync_status broadcast 限流**：後端最多每秒廣播一次，避免對時頻率提高後訊息量 O(N²) 放大
- **視覺統一為黃色閃爍**：取消「主拍紅、副拍白」，全部拍點改為黃色；主拍仍可由音效（模式 B）與拍數數字辨識
- **start 防呆**：播放中再按「開始」會被後端拒絕，不會重置全團時間軸（需先停止）
- **連線 watchdog**：超過 8 秒沒收到 sync 回應即判定連線假死，強制重連（含舊 socket 防重複重連保護）
- **fallback offset 修正**：只在「本頁面從未對時成功」時使用粗略 offset，重連時不再於播放中覆寫造成相位跳動
- **Wake lock 改於使用者手勢中請求**：團員點「啟用聲音」時一併取得螢幕常亮權限，提高 iOS 取得成功率

### 2026-05-26

- 新增節拍音效同步：螢幕閃爍時同步播放主拍/副拍音效
  - 模式 A：全拍使用 `Metronomes/metronome.mp3`
  - 模式 B：主拍（第 1 拍）`Metronomes/di.mp3`、副拍（第 2~4 拍）`Metronomes/du.mp3`
- 鼓手控制台 BPM 介面優化
  - BPM 顯示改為大字體
  - 新增 `-` 與 `+` 按鈕，可每次精準調整 1 BPM
  - 滑桿上限由 `240` 調整為 `180`
- BPM 範圍統一為 `40~180`（前端與後端同步限制）
- 前端顯示名稱更新為 `Heart of Worship 節拍器`

目前為 **v1 可用版**，重點是：

- 以伺服器時間作為節拍主時鐘
- client 可延後啟動，但進入同一個節拍時間軸
- 適用同網域部署（建議）

## v1 功能重點

- **角色模式（同網址）**
  - 團員（預設）：`/`
  - 鼓手：admin：`/?role=admin`
- **跨裝置同步機制**
  - WebSocket `sync` 對時
  - client RTT/jitter 回報（`sync_report`）
  - 動態建議起播延遲（server 計算）
  - 播放中 BPM 鎖定（需先停止再調整）
- **同步可觀測性**
  - 顯示連線裝置數、已對時數、建議延遲、本機 RTT/Jitter
- **手機相容性保護**
  - 優先使用 Web Worker 計時
  - Worker 不可用時自動降級為主執行緒計時

## 專案目錄

```text
how-pulse/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── timer-worker.js
│   ├── nginx.conf
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

## 啟動方式（Docker Compose，推薦）

```bash
docker compose up --build -d
```

服務位址：

- 前端：`http://localhost:5500`
- 後端健康檢查：`http://localhost:8000/`
- 鼓手管理模式：`http://localhost:5500/?role=admin`

停止服務：

```bash
docker compose down
```

## 正式環境建議（同網域）

建議所有人都使用同一個公開網域，例如 `https://pulse.example.com`：

- 團員：`https://pulse.example.com/`
- 鼓手：admin：`https://pulse.example.com/?role=admin`

避免使用不同子網域分流（較容易出現 DNS/代理規則不一致造成連線問題）。

## 多裝置驗收建議

1. 至少兩台手機（可混合行動網路/Wi-Fi）同時開啟
2. 鼓手在停止狀態先設定 BPM
3. 按開始，觀察是否同時進入第一拍並維持同步
4. 播放中確認 BPM 無法調整
5. 停止後調 BPM，再開始，重複 3-5 次

## 本機開發（非 Docker）

### 後端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 前端

```bash
cd frontend
python3 -m http.server 5500
```
