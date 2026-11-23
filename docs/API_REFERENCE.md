# 🔌 API & Data Schema Reference

This reference documents the REST endpoints, WebSocket (Socket.IO) event contracts, and Google Cloud Firestore schemas implemented in the **FamilyCard NID Automation** platform.

---

## 1. REST Endpoints Overview

All endpoints are symmetrically supported across both the **Node.js Express Server** (`http://localhost:3000`) and the **Cloudflare Serverless Edge Worker** (`https://familycard-10n.pages.dev` or `https://familycard.afridi.app`).

```
┌───────────────────────────────┬────────┬────────────────────────────────────────┐
│ Endpoint                      │ Method │ Purpose                                │
├───────────────────────────────┼────────┼────────────────────────────────────────┤
│ `/api/ocr-nid`                │ POST   │ Primary AI Vision OCR extraction       │
│ `/api/extract-nid`            │ POST   │ Alias for `/api/ocr-nid`               │
│ `/api/room-messages`          │ GET    │ Retrieve room chat and peer state      │
│ `/api/room-messages`          │ POST   │ Broadcast chat message or NID payload  │
│ `/api/error-logs`             │ POST   │ Ingest client error & telemetry traces │
│ `/api/error-logs`             │ GET    │ Retrieve diagnostic log stream         │
│ `/api/info`                   │ GET    │ Health check, server status & models   │
└───────────────────────────────┴────────┴────────────────────────────────────────┘
```

---

## 2. OCR Extraction Endpoint

### `POST /api/ocr-nid` (or `/api/extract-nid`)

Submits a base64-encoded document image for AI vision processing, validation, transliteration, and formatting.

#### Request Headers:
```http
Content-Type: application/json
```

#### Request Payload:
```json
{
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "room": "FC-101",
  "aiProvider": "economy",
  "geminiModel": "gemini-3.5-flash-lite",
  "deepseekModel": "deepseek-flash",
  "defaultKeySlot": "auto",
  "apiKey": "AIzaSy...",
  "deepseekApiKey": "sk-...",
  "docType": "auto",
  "maritalStatus": "বিবাহিত",
  "religion": "ইসলাম",
  "mobileNumber": "01956887894"
}
```

#### Request Fields:
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `image` | string | **Yes** | Base64-encoded image string (with or without `data:image/jpeg;base64,` prefix). |
| `room` | string | No | Alphanumeric Room ID for cross-device broadcasting (Default: `FC-101`). |
| `aiProvider` | string | No | Model strategy: `economy`, `deepseek`, `gemini_lite`, `auto`, `gemini` (Default: `economy`). |
| `geminiModel` | string | No | Gemini model target: `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-argon`. |
| `deepseekModel`| string | No | DeepSeek model target: `deepseek-flash`. |
| `apiKey` | string | No | Custom Gemini API key (optional if pre-configured in server `.env` or Cloudflare secrets). |
| `deepseekApiKey`| string | No | Custom DeepSeek API key. |
| `docType` | string | No | Document type constraint: `auto`, `nid`, `birth_certificate`. |
| `maritalStatus`| string | No | Selected marital status: `বিবাহিত`, `অবিবাহিত`, `বিধবা`, `বিপত্নীক`, `তালাকপ্রাপ্ত`. |
| `religion` | string | No | Selected religion: `ইসলাম`, `হিন্দু`, `বৌদ্ধ`, `খ্রিস্টান`, `অন্যান্য`. |
| `mobileNumber` | string | No | 11-digit mobile number supplied by operator. |

#### Successful Response (`200 OK`):
```json
{
  "success": true,
  "data": {
    "doc_type": "nid",
    "doc_number": "19862611234567890",
    "nid_number": "19862611234567890",
    "birth_reg_no": "",
    "name_bn": "সিরাজ ব্যাপারী",
    "name_en": "SHIRAJ BEPARI",
    "father_bn": "রফিকুল ইসলাম",
    "father_en": "RAFIQUL ISLAM",
    "mother_bn": "নুরজাহান নেছা",
    "mother_en": "NURJAHAN NESA",
    "dob": "1986-04-12",
    "gender": "পুরুষ",
    "marital_status": "বিবাহিত",
    "religion": "ইসলাম",
    "nationality": "বাংলাদেশী",
    "mobile_number": "01956887894",
    "spouse_bn": "",
    "ocr_model_used": "gemini-3.5-flash-lite",
    "cost_usage": {
      "model": "gemini-3.5-flash-lite",
      "promptTokens": 620,
      "candidateTokens": 210,
      "totalTokens": 830,
      "costUsd": 0.000711,
      "costBdt": 0.0867
    },
    "warnings": []
  }
}
```

#### Error Response (`400 / 500`):
```json
{
  "success": false,
  "error": "NID নম্বর সঠিকভাবে পড়া যায়নি। অনুগ্রহ করে আলো ও ফোকাস ঠিক রেখে পুনরায় চেষ্টা করুন।"
}
```

---

## 3. Real-Time Room Messaging API

### `GET /api/room-messages`

Retrieves chat messages and active peer heartbeats for a given room.

#### Query Parameters:
- `room` (string, required): Room identifier (e.g. `FC-101`).
- `metaOnly` (`1` or `0`, optional): Returns only message ID markers and peer heartbeats (reduces egress bandwidth).
- `peerId` (string, optional): Current client unique identifier.
- `peerName` (string, optional): Human-readable device label (e.g. `মোবাইল-স্ক্যানার`).
- `peerClient` (string, optional): Client type: `companion`, `bookmarklet`, `extension`, `web`.

#### Response:
```json
{
  "success": true,
  "room": "FC-101",
  "meta": {
    "last_msg_id": "msg_1732371234000_a8z",
    "cleared_at_ms": 0,
    "total_messages": 14
  },
  "peers": [
    {
      "id": "web_x92k",
      "name": "ট্যাবলেট-১",
      "client": "bookmarklet",
      "lastSeen": 1732371240000
    },
    {
      "id": "comp_a11b",
      "name": "মোবাইল-স্ক্যানার",
      "client": "companion",
      "lastSeen": 1732371242000
    }
  ],
  "messages": [
    {
      "id": "msg_1732371234000_a8z",
      "room": "FC-101",
      "type": "nid_data",
      "text": "🪪 স্ক্যান: সিরাজ ব্যাপারী (19862611234567890)",
      "payload": { "...": "applicant data object" },
      "senderName": "মোবাইল-স্ক্যানার",
      "senderClient": "companion",
      "senderId": "comp_a11b",
      "ts": 1732371234000,
      "createdAt": "2026-11-23T15:33:54.000Z"
    }
  ]
}
```

---

### `POST /api/room-messages`

Broadcasts a message, applicant data payload, or command to all peers in the room.

#### Request Payload:
```json
{
  "id": "msg_1732371250000_c3d",
  "room": "FC-101",
  "type": "text",
  "text": "আবেদনকারীর মোবাইল নম্বর: 01711223344",
  "senderName": "ট্যাবলেট-১",
  "senderClient": "bookmarklet",
  "senderId": "web_x92k",
  "replyTo": "msg_1732371234000_a8z",
  "ts": 1732371250000
}
```

---

## 4. Telemetry & Error Logging API

### `POST /api/error-logs`
Captures unhandled JavaScript errors, failed OCR attempts, network timeouts, and Vuetify DOM binding exceptions:

```json
{
  "id": "err_1732371300000_f9a",
  "source": "bookmarklet",
  "level": "error",
  "stage": "vuetify-select-dispatch",
  "message": "Dropdown element .v-menu__content not rendered within 1200ms",
  "detail": "Selector: .v-select[data-field='district']",
  "ts": 1732371300000,
  "createdAt": "2026-11-23T15:35:00.000Z"
}
```

---

## 5. Socket.IO WebSocket Event Specification

When operating over WebSocket (`/server/server.js`), peers exchange binary-capable real-time events:

```mermaid
flowchart LR
    Client(["Client Socket"]) <-->|Events| Server(["Socket.IO Server"])
```

| Event Name | Direction | Payload Structure | Description |
| :--- | :--- | :--- | :--- |
| `join-room` | Client $\rightarrow$ Server | `{ room: string, clientName: string, clientType: string, clientId: string }` | Registers peer inside room channel. |
| `joined` | Server $\rightarrow$ Client | `{ success: true, room: string }` | Acknowledges room entry. |
| `scan-nid` | Client $\rightarrow$ Server | `{ image: base64, room: string, ...aiOptions }` | Transmits image for immediate OCR processing. |
| `nid-extracted` | Server $\rightarrow$ Room | `{ success: true, data: applicantObject }` | Emits processed profile to all peers in room. |
| `room-message` | Bidirectional | `{ room, type, text, payload, senderName, senderId, ts }` | Live peer-to-peer message exchange. |
| `peers-update` | Server $\rightarrow$ Room | `Array<{ id, name, client, lastSeen }>` | Pushes updated peer list upon connection change. |
| `clear-room` | Client $\rightarrow$ Server | `{ room: string }` | Clears room message history. |

---

## 6. Firestore Document Schema

Google Cloud Firestore collections structure:

### 6.1. Collection: `family_cards`
Stores completed applicant records and audit traces.
- **Document Path**: `/family_cards/{docId}` (where `docId` is the 10/17-digit citizen NID or BRC).

```json
{
  "family_id": "8743033825",
  "program_name": "ফ্যামিলি কার্ড",
  "nid_number": "19862611234567890",
  "name_bn": "সিরাজ ব্যাপারী",
  "name_en": "SHIRAJ BEPARI",
  "father_bn": "রফিকুল ইসলাম",
  "father_en": "RAFIQUL ISLAM",
  "mother_bn": "নুরজাহান নেছা",
  "mother_en": "NURJAHAN NESA",
  "mobile_number": "01956887894",
  "dob": "1986-04-12",
  "age": 38,
  "gender": "পুরুষ",
  "marital_status": "বিবাহিত",
  "religion": "ইসলাম",
  "nationality": "বাংলাদেশী",
  "section3_media": {
    "has_photo": true,
    "has_nid_front": true,
    "has_nid_back": true,
    "ratio": "৩/৩"
  },
  "section5_household": {
    "male_count": 3,
    "female_count": 2,
    "hijra_count": 0,
    "total_count": 5,
    "mfs_count": 2,
    "training_count": 1,
    "abroad_count": 0
  },
  "section9_allocation": {
    "education": 500,
    "food": 1200,
    "medical": 300,
    "business": 500,
    "total": 2500
  },
  "updated_at": "2026-11-23T15:40:00.000Z",
  "operator_id": "web_x92k"
}
```

#### Subcollections under `/family_cards/{docId}`:
- **`members/{memberId}`**: Document for each dependent added in Section 8.
- **`logs/{logId}`**: Mutation history and submission timestamps.

---

### 6.2. Collection: `room_channels`
- **Document Path**: `/room_channels/{roomCode}`
- **Subcollection**: `/room_channels/{roomCode}/messages/{messageId}`
Used for cross-device message synchronization, peer heartbeats, and live applicant sharing.

### 6.3. Collection: `fc_error_logs`
- **Document Path**: `/fc_error_logs/{logId}`
Used for centralized diagnostic aggregation across distributed field teams.
