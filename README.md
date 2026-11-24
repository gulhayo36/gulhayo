# Suhbat — Vue 3 + FastAPI + SQL (real vaqtli chat)

## Ishga tushirish
    python -m pip install -r requirements.txt
    python main.py
Brauzerda oching: http://127.0.0.1:8000
(8000-port band bo'lsa, eski serverni Ctrl+C bilan to'xtating yoki main.py ichida PORT ni o'zgartiring.)

Eslatma: Vue kutubxonasi internetdan (jsDelivr CDN) yuklanadi, shuning uchun brauzerda internet kerak.

## Texnologiyalar
- HTML5 — static/index.html
- CSS — static/css/style.css
- JavaScript + **Vue 3** (frontend framework) — static/js/app.js (3 ta komponent: auth-form, room-list, chat-panel)
- Backend — FastAPI (main.py), WebSocket real vaqt uchun
- **SQL (relatsion) baza** — SQLite, schema.sql

## Ma'lumotlar bazasi (ER)
    users (id PK, username UNIQUE, password_hash, salt, created)
      │ 1
      ├──< * messages (id PK, room_id FK→rooms, user_id FK→users, text, created)
      │ 1                        ^
      ├──< * sessions (token PK, user_id FK→users, created)     │ *
      │ 1                                                       │
      └──< * rooms (id PK, name UNIQUE, created_by FK→users, created) ──┘ 1

Bog'lanishlar FOREIGN KEY bilan berilgan (ON DELETE CASCADE / SET NULL). Xabarlarni o'qishda
`messages JOIN users` ishlatiladi.

## API
| Yo'l | Vazifa |
|---|---|
| POST /api/register | ro'yxatdan o'tish |
| POST /api/login | kirish (token qaytaradi) |
| POST /api/logout | chiqish |
| GET /api/me | joriy foydalanuvchi |
| GET /api/rooms, POST /api/rooms | xonalar ro'yxati, yangi xona |
| GET /api/rooms/{id}/messages | xona tarixi |
| DELETE /api/messages/{id} | o'z xabarini o'chirish |
| WS /ws?token=..&room_id=.. | real vaqtli xabarlar |
| /docs | FastAPI avtomatik hujjati |

## Xavfsizlik
Parollar PBKDF2-SHA256 (200 000 iteratsiya) va tasodifiy salt bilan saqlanadi, ochiq holda emas.
Xabarlar Vue `{{ }}` orqali chiqariladi (avtomatik escape), SQL so'rovlar parametrlangan.
