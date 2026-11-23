# 🚀 Deployment, Build & Infrastructure Guide

This guide details the complete deployment lifecycle for the **FamilyCard NID Automation** platform across local development environments, cloud hosts (Cloudflare, Firebase, Render), browser extensions, and zero-install mobile bookmarklet bundles.

---

## 1. System Requirements & Prerequisites

- **Node.js**: `v18.0.0` or higher (tested up to Node.js v22 LTS).
- **Package Manager**: `npm` (v9.0.0+) or `pnpm` / `yarn`.
- **API Keys**:
  - [Google Gemini API Key](https://aistudio.google.com/) (Required for Gemini 3.5 Flash-Lite / 3.8 Flash).
  - [DeepSeek API Key](https://platform.deepseek.com/) (Optional for DeepSeek Flash off-peak engine).
- **CLI Tools (Optional for Cloud Deployments)**:
  - `firebase-tools`: `npm install -g firebase-tools`
  - `wrangler` (Cloudflare): `npm install -g wrangler`

---

## 2. Local Environment Setup

### Step 1: Clone Repository
```bash
git clone https://github.com/ShadhinAfridi/FamilyCard.git
cd FamilyCard
```

### Step 2: Install Dependencies
Install dependencies for both the root build pipeline and the backend server:
```bash
# Install root build toolchain (Terser minifier)
npm install

# Install server runtime dependencies (Express, CORS, Socket.IO, Dotenv)
npm run install:server
```

### Step 3: Configure Environment Variables
Create a `.env` file in the `server/` directory from the provided template:
```bash
cp server/.env.example server/.env
```

Edit `server/.env`:
```ini
PORT=3000
GEMINI_API_KEY=AIzaSyYourGeminiApiKeyHere
DEEPSEEK_API_KEY=sk-YourDeepSeekApiKeyHere
NODE_ENV=production
```

### Step 4: Run the Application
To start the Node.js server:
```bash
npm start
```

Or on Windows systems, double-click:
```cmd
start.bat
```

The server launches at `http://localhost:3000`. It automatically discovers and displays all local LAN IP addresses (e.g. `http://192.168.1.15:3000`) so mobile phones on the same Wi-Fi or mobile hotspot can connect directly.

---

## 3. Bookmarklet Build Pipeline

The project features an automated JavaScript bundling and minification pipeline that generates production-ready bookmarklets and userscripts from the source script `bookmarklet/bookmarklet.js`.

### Running the Build:
```bash
npm run build:bookmarklet
```

### Pipeline Output Artifacts:
```
┌──────────────────────────────────────┬─────────────┬────────────────────────────────────────────────────────┐
│ Generated File Path                  │ Size (Chars)│ Purpose                                                │
├──────────────────────────────────────┼─────────────┼────────────────────────────────────────────────────────┤
│ `public/bookmarklet/app.min.js`      │ ~387 KB     │ Pure minified JS bundle loaded remotely by mobile CDN  │
│ `public/bookmarklet/loader.min.js`   │ ~1,003 B    │ 1-line Network-First mobile Chrome loader bookmarklet  │
│ `public/bookmarklet/bookmarklet.min.js`│ ~649 KB   │ Self-contained drag-and-drop bookmarklet for desktop   │
│ `public/bookmarklet/familycard.user.js`│ ~388 KB   │ Tampermonkey / Violentmonkey auto-run userscript       │
│ `public/bookmarklet/index.html`      │ ~28 KB      │ Mobile setup instructions & 1-tap copy UI page         │
└──────────────────────────────────────┴─────────────┴────────────────────────────────────────────────────────┘
```

The build script automatically synchronizes artifacts into the `/public/` directory for immediate hosting via Firebase or Cloudflare Pages.

---

## 4. Cloud Deployments

### 4.1. Cloudflare Pages & Workers Deployment
The production edge API and CDN are hosted on Cloudflare:
- **Production Custom Domain**: `https://familycard.afridi.app`
- **Pages Staging URL**: `https://familycard-10n.pages.dev`

#### Deploying Cloudflare Worker (`cloudflare/worker.js`):
1. Authenticate with Cloudflare:
   ```bash
   wrangler login
   ```
2. Configure Cloudflare Secrets:
   ```bash
   wrangler secret put GEMINI_API_KEY
   wrangler secret put DEEPSEEK_API_KEY
   ```
3. Deploy Worker:
   ```bash
   wrangler deploy cloudflare/worker.js --name familycard-edge-api
   ```

---

### 4.2. Firebase Hosting & Firestore Rules Deployment
The project uses Firebase Hosting for low-latency global edge delivery of static assets and Google Cloud Firestore for data persistence.

#### Configuration Files:
- `.firebaserc`: Targets projects `rajbari-city-app-16601` and `questionbank-diu`.
- `firebase.json`: Defines CORS headers (`Access-Control-Allow-Origin: *`) and caching strategies (`no-cache, must-revalidate` for live bundles).
- `firestore.rules`: Secures database paths while permitting enumerator app access.

#### Deploy Commands:
```bash
# Login to Firebase
firebase login

# Deploy static web app and bookmarklet assets
firebase deploy --only hosting

# Deploy database security rules
firebase deploy --only firestore:rules
```

---

### 4.3. Render.com Deployment (`render.yaml`)
For hosting the persistent Node.js WebSocket backend with zero operational overhead, the repository includes a Render blueprint:

```yaml
services:
  - type: web
    name: familycard-nid-bridge
    env: node
    plan: free
    buildCommand: npm --prefix server install
    startCommand: npm --prefix server start
    envVars:
      - key: GEMINI_API_KEY
        sync: false
```

#### Steps to Deploy on Render:
1. Connect your GitHub repository on [Render.com](https://render.com).
2. Choose **New > Blueprint** and select `render.yaml`.
3. In the Render Dashboard under **Environment**, enter your `GEMINI_API_KEY`.
4. Deploy the service. Render provides an instant HTTPS URL (e.g. `https://familycard-nid-bridge.onrender.com`).

---

## 5. Client Installation & Setup

### 5.1. Mobile Chrome Tablet (Zero-Install Bookmarklet)
*Recommended for locked Android tablets where Play Store or app installation is restricted.*

1. Open Google Chrome on the tablet and visit:  
   👉 **`https://familycard.afridi.app/bookmarklet/`**
2. Tap the green button: **"📋 বুকমার্ক কোড কপি করুন"** (Copies `loader.min.js`).
3. Bookmark any random webpage in Chrome by tapping the **Star (⭐)** icon.
4. Edit the bookmark:
   - **Name**: `nid`
   - **URL**: Paste the copied javascript code.
5. Navigate to the government portal:  
   👉 `https://fc.bhata.gov.bd/online-application-family-card`
6. In the Chrome URL address bar, type `nid` and tap the bookmark result from the suggestions list.
7. The floating **`📸 NID স্ক্যান`** button immediately appears over the government form!

---

### 5.2. Android Kiwi Browser / Lemur Browser (Extension)
*Best for enumerators using personal Android tablets who desire permanent background syncing.*

1. Install **Kiwi Browser** from Google Play Store.
2. Download or transfer `extension.zip` from this repository to the tablet.
3. Open Kiwi Browser, tap the three dots (⋮) $\rightarrow$ **Extensions**.
4. Enable **Developer mode** toggle.
5. Tap **`+(from .zip/.crx/.user.js)`** and select `extension.zip`.
6. Open `https://fc.bhata.gov.bd/online-application-family-card`. The FamilyCard floating action bar is permanently embedded.

---

### 5.3. Desktop PC (Chrome / Edge / Brave)
1. Open `chrome://extensions` in your browser.
2. Turn on **Developer mode** (top right switch).
3. Click **Load unpacked** (বামপাশে "আনপ্যাকড লোড করুন").
4. Select the `extension/` folder inside the cloned repository.
5. Pin the extension icon to your toolbar.
