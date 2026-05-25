# how-pulse

Heart of Worship 節拍器

即時同步視覺節拍器 WebApp（FastAPI + 原生前端 + WebSocket + Web Worker）。

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
