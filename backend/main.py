import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI(title="how-pulse backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def send_personal_message(self, message: dict[str, Any], websocket: WebSocket) -> None:
        await websocket.send_json(message)

    async def broadcast(self, message: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)
        for connection in disconnected:
            self.disconnect(connection)


manager = ConnectionManager()
MIN_START_DELAY_SECONDS = 2.0
MAX_START_DELAY_SECONDS = 5.0
REPORT_FRESH_SECONDS = 15.0

global_state: dict[str, Any] = {
    "bpm": 120,
    "is_playing": False,
    "start_time": None,
}
client_ids: dict[WebSocket, str] = {}
client_reports: dict[str, dict[str, Any]] = {}


def compute_start_delay_seconds() -> float:
    now = time.time()
    fresh_reports = [
        report
        for report in client_reports.values()
        if (now - float(report.get("updated_at", 0.0))) <= REPORT_FRESH_SECONDS
    ]
    if not fresh_reports:
        return MIN_START_DELAY_SECONDS

    max_rtt_ms = max(float(report.get("rtt_ms", 0.0)) for report in fresh_reports)
    max_jitter_ms = max(float(report.get("jitter_ms", 0.0)) for report in fresh_reports)
    dynamic_delay = 1.8 + (max_rtt_ms * 0.0025) + (max_jitter_ms * 0.006)
    return max(MIN_START_DELAY_SECONDS, min(MAX_START_DELAY_SECONDS, dynamic_delay))


def sync_status_payload() -> dict[str, Any]:
    now = time.time()
    fresh_reports = [
        report
        for report in client_reports.values()
        if (now - float(report.get("updated_at", 0.0))) <= REPORT_FRESH_SECONDS
    ]
    ready_count = sum(1 for report in fresh_reports if bool(report.get("synced", False)))
    return {
        "connected_clients": len(client_ids),
        "reporting_clients": len(fresh_reports),
        "ready_clients": ready_count,
        "recommended_delay_sec": round(compute_start_delay_seconds(), 3),
    }


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def state_payload() -> dict[str, Any]:
    return {
        "type": "state",
        "state": global_state,
        "sync_status": sync_status_payload(),
        "server_time": time.time(),
    }


def sync_status_message() -> dict[str, Any]:
    return {
        "type": "sync_status",
        "sync_status": sync_status_payload(),
        "server_time": time.time(),
    }


@app.get("/")
def healthcheck() -> dict[str, str]:
    return {"message": "how-pulse backend running"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    client_id = uuid.uuid4().hex[:8]
    client_ids[websocket] = client_id
    await manager.send_personal_message({"type": "hello", "client_id": client_id}, websocket)
    await manager.send_personal_message(state_payload(), websocket)
    await manager.broadcast(sync_status_message())

    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                await manager.send_personal_message(
                    {"type": "error", "message": "Invalid JSON payload."},
                    websocket,
                )
                continue

            msg_type = data.get("type")
            updated = False

            if msg_type == "set_bpm":
                try:
                    bpm_value = int(data.get("bpm", global_state["bpm"]))
                    bpm_value = max(30, min(300, bpm_value))
                    if global_state["is_playing"]:
                        await manager.send_personal_message(
                            {"type": "error", "message": "Cannot change BPM while playing."},
                            websocket,
                        )
                    else:
                        global_state["bpm"] = bpm_value
                        updated = True
                except (TypeError, ValueError):
                    await manager.send_personal_message(
                        {"type": "error", "message": "bpm must be a number."},
                        websocket,
                    )
            elif msg_type == "start":
                start_delay_seconds = compute_start_delay_seconds()
                global_state["is_playing"] = True
                global_state["start_time"] = time.time() + start_delay_seconds
                updated = True
            elif msg_type == "stop":
                global_state["is_playing"] = False
                global_state["start_time"] = None
                updated = True
            elif msg_type == "request_state":
                await manager.send_personal_message(state_payload(), websocket)
            elif msg_type == "sync":
                await manager.send_personal_message(
                    {
                        "type": "sync",
                        "server_time": time.time(),
                        "client_sent_at": data.get("client_sent_at"),
                    },
                    websocket,
                )
            elif msg_type == "sync_report":
                report_owner = client_ids.get(websocket)
                if report_owner:
                    client_reports[report_owner] = {
                        "rtt_ms": to_float(data.get("rtt_ms"), 0.0),
                        "offset_ms": to_float(data.get("offset_ms"), 0.0),
                        "jitter_ms": to_float(data.get("jitter_ms"), 0.0),
                        "synced": bool(data.get("synced", False)),
                        "sample_count": to_int(data.get("sample_count"), 0),
                        "updated_at": time.time(),
                    }
                    await manager.broadcast(sync_status_message())
            else:
                await manager.send_personal_message(
                    {"type": "error", "message": f"Unknown message type: {msg_type}"},
                    websocket,
                )

            if updated:
                await manager.broadcast(state_payload())
    except WebSocketDisconnect:
        client_id = client_ids.pop(websocket, None)
        if client_id:
            client_reports.pop(client_id, None)
        manager.disconnect(websocket)
        await manager.broadcast(sync_status_message())
    except Exception:
        client_id = client_ids.pop(websocket, None)
        if client_id:
            client_reports.pop(client_id, None)
        manager.disconnect(websocket)
        await manager.broadcast(sync_status_message())
