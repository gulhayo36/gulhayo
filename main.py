import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent
HOST = "0.0.0.0"  # 0.0.0.0 = tarmoqdagi boshqa kompyuterlar ham ulana oladi
PORT = 8000
SESSION_TTL = 7 * 24 * 3600  # sessiya 7 kun amal qiladi
USERNAME_RE = re.compile(r"[A-Za-z0-9_]{3,20}")
ROOM_RE = re.compile(r"[\w-]{2,24}")

app = FastAPI(title="Suhbat")

# ---------------------------------------------------------------- Baza (SQL)
db = sqlite3.connect(BASE / "suhbat.db", check_same_thread=False)
db.execute("PRAGMA foreign_keys = ON")  # FOREIGN KEY qoidalarini yoqish
db.executescript((BASE / "schema.sql").read_text(encoding="utf-8"))
db.execute(
    "INSERT OR IGNORE INTO rooms (name, created_by, created) VALUES ('umumiy', NULL, ?)",
    (time.time(),),
)
db.commit()


# ---------------------------------------------------------------- Yordamchilar
def clean(value, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 200_000
    ).hex()


def make_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    db.execute(
        "INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)",
        (token, user_id, time.time()),
    )
    db.commit()
    return token


def user_by_token(token: str):
    row = db.execute(
        "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.created > ?",
        (token, time.time() - SESSION_TTL),
    ).fetchone()
    return {"id": row[0], "username": row[1]} if row else None


def bearer(authorization: str | None) -> str:
    return (authorization or "").removeprefix("Bearer ").strip()


async def current_user(authorization: str | None = Header(default=None)):
    user = user_by_token(bearer(authorization))
    if not user:
        raise HTTPException(401, "Kirish talab qilinadi")
    return user


# Onlayn ulanishlar: xona id -> {websocket: login}
online: dict[int, dict[WebSocket, str]] = {}


def online_names(room_id: int) -> list[str]:
    return sorted(set(online.get(room_id, {}).values()))


async def broadcast(room_id: int, payload: dict) -> None:
    dead = []
    for ws in list(online.get(room_id, {})):
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        online.get(room_id, {}).pop(ws, None)


def message_dict(row) -> dict:
    return {
        "type": "message", "id": row[0], "room_id": row[1],
        "user_id": row[2], "username": row[3], "text": row[4], "ts": row[5],
    }


# ---------------------------------------------------------------- Autentifikatsiya
class Credentials(BaseModel):
    username: str
    password: str


@app.post("/api/register", status_code=201)
async def register(body: Credentials):
    username = body.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(400, "Login 3-20 belgi: lotin harflari, raqam va _ bo'lishi mumkin")
    if not 6 <= len(body.password) <= 100:
        raise HTTPException(400, "Parol 6 dan 100 gacha belgidan iborat bo'lsin")
    salt = secrets.token_hex(16)
    try:
        cur = db.execute(
            "INSERT INTO users (username, password_hash, salt, created) VALUES (?, ?, ?, ?)",
            (username, hash_password(body.password, salt), salt, time.time()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Bu login band, boshqasini tanlang")
    return {"token": make_session(cur.lastrowid), "user": {"id": cur.lastrowid, "username": username}}


@app.post("/api/login")
async def login(body: Credentials):
    row = db.execute(
        "SELECT id, username, password_hash, salt FROM users WHERE username = ?",
        (body.username.strip(),),
    ).fetchone()
    if not row or not hmac.compare_digest(row[2], hash_password(body.password, row[3])):
        raise HTTPException(401, "Login yoki parol noto'g'ri")
    return {"token": make_session(row[0]), "user": {"id": row[0], "username": row[1]}}


@app.post("/api/logout")
async def logout(authorization: str | None = Header(default=None)):
    db.execute("DELETE FROM sessions WHERE token = ?", (bearer(authorization),))
    db.commit()
    return {"ok": True}


@app.get("/api/me")
async def me(user=Depends(current_user)):
    return user


# ---------------------------------------------------------------- Xonalar
class NewRoom(BaseModel):
    name: str


@app.get("/api/rooms")
async def list_rooms(user=Depends(current_user)):
    rows = db.execute(
        "SELECT r.id, r.name, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) "
        "FROM rooms r ORDER BY r.name"
    ).fetchall()
    return [
        {"id": r[0], "name": r[1], "messages": r[2], "online": len(online_names(r[0]))}
        for r in rows
    ]


@app.post("/api/rooms", status_code=201)
async def create_room(body: NewRoom, user=Depends(current_user)):
    name = re.sub(r"\s+", "-", body.name.strip().lower())
    if not ROOM_RE.fullmatch(name):
        raise HTTPException(400, "Xona nomi 2-24 belgi: harf, raqam, - yoki _ bo'lsin")
    try:
        cur = db.execute(
            "INSERT INTO rooms (name, created_by, created) VALUES (?, ?, ?)",
            (name, user["id"], time.time()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Bunday xona allaqachon bor")
    return {"id": cur.lastrowid, "name": name, "messages": 0, "online": 0}


# ---------------------------------------------------------------- Xabarlar
@app.get("/api/rooms/{room_id}/messages")
async def history(room_id: int, user=Depends(current_user)):
    if not db.execute("SELECT 1 FROM rooms WHERE id = ?", (room_id,)).fetchone():
        raise HTTPException(404, "Xona topilmadi")
    rows = db.execute(
        "SELECT m.id, m.room_id, m.user_id, u.username, m.text, m.created "
        "FROM messages m JOIN users u ON u.id = m.user_id "
        "WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 100",
        (room_id,),
    ).fetchall()
    return [message_dict(r) for r in reversed(rows)]


@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, user=Depends(current_user)):
    row = db.execute(
        "SELECT room_id, user_id FROM messages WHERE id = ?", (message_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Xabar topilmadi")
    if row[1] != user["id"]:
        raise HTTPException(403, "Faqat o'z xabaringizni o'chira olasiz")
    db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    db.commit()
    await broadcast(row[0], {"type": "deleted", "id": message_id})
    return {"deleted": message_id}


@app.websocket("/ws")
async def chat_socket(ws: WebSocket, token: str = "", room_id: int = 0):
    user = user_by_token(token)
    room = db.execute("SELECT id FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not user or not room:
        await ws.close(code=4401)
        return
    await ws.accept()
    online.setdefault(room_id, {})[ws] = user["username"]
    await broadcast(room_id, {"type": "presence", "users": online_names(room_id)})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                text = clean(json.loads(raw).get("text", ""), 1000)
            except (ValueError, AttributeError):
                continue
            if not text:
                continue
            ts = time.time()
            cur = db.execute(
                "INSERT INTO messages (room_id, user_id, text, created) VALUES (?, ?, ?, ?)",
                (room_id, user["id"], text, ts),
            )
            db.commit()
            await broadcast(
                room_id,
                message_dict((cur.lastrowid, room_id, user["id"], user["username"], text, ts)),
            )
    except WebSocketDisconnect:
        pass
    finally:
        online.get(room_id, {}).pop(ws, None)
        await broadcast(room_id, {"type": "presence", "users": online_names(room_id)})
        if not online.get(room_id):
            online.pop(room_id, None)


# ---------------------------------------------------------------- Frontend fayllari
@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

def lan_ip() -> str:
    """Kompyuterning tarmoqdagi (Wi-Fi) manzilini aniqlaydi."""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # hech narsa yuborilmaydi, faqat yo'nalish aniqlanadi
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn

    print("\n  Shu kompyuterda:        http://127.0.0.1:%d" % PORT)
    print("  Boshqa kompyuterlarda:  http://%s:%d\n" % (lan_ip(), PORT))
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)