# WA Gateway — Node.js + Express + WebSocket

Modern WhatsApp Gateway built with **whatsapp-web.js**, **Express**, and **WebSocket**.

## Features
- 📡 Real-time WebSocket events (QR, messages, ACK, typing)
- 💬 Send text, media (image/video/audio/PDF), and bulk messages
- 🔗 Webhook system (per-event, retry, stats)
- 🚫 Auto-reject typing indicator (configurable)
- 🔑 API Key authentication
- 📊 Modern dashboard (Control Center)
- 📤 Dedicated Sender panel

## Quick Start

```bash
npm install
# Edit .env → set API_KEY
npm start
```

Open **http://localhost:3000** → Center dashboard  
Open **http://localhost:3000/sender** → Sender panel

## REST API

All protected endpoints require header: `X-API-Key: <your-key>`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status |
| GET | `/api/qr` | QR code (base64) |
| POST | `/api/send` | Send text `{to, message}` |
| POST | `/api/send/bulk` | Bulk send `{numbers[], message, delay}` |
| POST | `/api/send/media` | Send media `{to, mediaUrl, caption}` or FormData |
| POST | `/api/send/typing` | Send typing `{to, duration}` |
| GET | `/api/chats` | Recent chats |
| GET | `/api/contacts` | Contacts |
| GET | `/api/messages/:chatId` | Chat messages |
| GET | `/api/check/:number` | Check if registered |
| POST | `/api/logout` | Logout |
| POST | `/api/restart` | Restart service |
| GET | `/api/webhooks` | List webhooks |
| POST | `/api/webhooks` | Add webhook `{url, events[], description}` |
| DELETE | `/api/webhooks/:id` | Remove webhook |
| PATCH | `/api/webhooks/:id/toggle` | Toggle active `{active}` |

## WebSocket Events

Connect to `ws://localhost:3000/ws`

| Event | Direction | Data |
|-------|-----------|------|
| `status` | Server→Client | `{status, info}` |
| `qr` | Server→Client | `{qr, qrBase64}` |
| `ready` | Server→Client | `{info}` |
| `disconnected` | Server→Client | `{reason}` |
| `message` | Server→Client | Incoming message payload |
| `message_sent` | Server→Client | Outgoing message payload |
| `message_ack` | Server→Client | `{id, to, ack, ackLabel}` |
| `typing` | Server→Client | `{chatId, name}` |
| `authenticated` | Server→Client | `{}` |

Send actions from client:
```json
{ "action": "ping" }
{ "action": "get_status" }
{ "action": "get_qr" }
```

## Webhook Payload

```json
{
  "event": "message",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { ... }
}
```

## .env Configuration

```env
PORT=3000
API_KEY=your-secret-key
AUTO_REJECT_TYPING=true
AUTO_READ_MESSAGES=false
```

## Requirements
- Node.js >= 18
- Google Chrome / Chromium (used by Puppeteer)
