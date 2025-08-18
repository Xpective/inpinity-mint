# inpinity-mint
Mint a collection of Pi Pyramid 0-9999
# Pi Pyramid — Public Mint | Inpinity.online

Official **NFT minting dApp** for the **Pi Pyramid Collection** (10,000 items, #0–#9999) deployed on **Solana**.  
This repository contains both:

1. **Frontend Website** (`index.html`, `app.js`) – the user-facing minting page.
2. **Cloudflare Worker Proxy** – routes RPC and claims requests securely.

---

## ✨ Features

### 🖥 Frontend (Mint Website)
- **Wallet Connection**
  - Connect with [Phantom Wallet](https://phantom.app).
  - Displays connected wallet address & SOL balance.
- **NFT Preview**
  - Enter token ID manually or auto-select a free one.
  - Fetch metadata (`.json`) from IPFS.
  - Show preview image or animation before minting.
- **Minting**
  - Fixed creator fee: `0.02 SOL`.
  - Optional donation (`0.01 SOL`, `0.1 SOL`, `1 SOL`, or custom).
  - Full cost estimation updated live.
- **Transaction Flow**
  - Signs & sends mint transaction directly via Phantom.
  - Displays status (`ok / warn / error`) with live logs.
- **UI / UX**
  - Responsive, mobile-ready layout.
  - Dark theme with styled buttons, cards, and modals.
  - Built-in log console for debugging.

### ⚙️ Backend (Worker Proxy)
- **Routes all requests through Cloudflare Worker**
  - `/rpc` → forwards Solana RPC requests (`getBalance`, `sendTransaction`, etc.).
  - `/claims` → returns claim list (JSON with already minted IDs).
- **Security**
  - Hides direct Solana RPC endpoint.
  - Prevents CORS issues with browsers.
- **Scalability**
  - Can be updated without touching frontend.
  - Supports caching for IPFS/JSON files.

---

## 🛠 Tech Stack
- **Frontend**: HTML5, CSS3 (inline styles), Vanilla JavaScript (ES Modules).
- **Wallet Integration**: Phantom Wallet Adapter.
- **Blockchain**: Solana Mainnet (`https://api.mainnet-beta.solana.com`).
- **Worker**: Cloudflare Workers (for RPC + claims routing).
- **Assets**: Hosted on IPFS (via Pinata / Cloudflare-IPFS Gateway).

---

## 🚀 Deployment

### Update Repo & Push to GitHub
```bash
# Move into your repo
cd /workspaces/inpinity-mint

# Add changed frontend files
git add index.html app.js mint/index.html mint/app.js

# Commit with message
git commit -m "update: styled frontend + improved worker proxy (v9)"

# Push to GitHub
git push origin main