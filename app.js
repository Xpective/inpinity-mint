/* ==================== BUILD-ID (for cache & debug) ==================== */
const BUILD_TAG = "mint-v11";

/* ==================== CONFIG ==================== */
const CFG = {
  // Prefer workers.dev first, domain route as fallback
  RPCS: [
    "https://inpinity-rpc-proxy.s-plat.workers.dev/rpc",
    "https://api.inpinity.online/rpc"
  ],
  CLAIMS: [
    "https://inpinity-rpc-proxy.s-plat.workers.dev/claims",
    "https://api.inpinity.online/claims"
  ],

  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  MINT_FEE_SOL: 0.02,
  COLLECTION_MINT: "DmKi8MtrpfQXVQvNjUfxWgBC3xFL2Qn5mvLDMgMZrNmS",

  ROYALTY_BPS: 700,
  TOKEN_STANDARD: 4,
  MAX_INDEX: 9999,

  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",
  MP4_BASE_CID:  "",

  GATEWAYS: [
    "https://ipfs.inpinity.online/ipfs",
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs"
  ],
};

/* ==================== IMPORTS ==================== */
import {
  createUmi, generateSigner, publicKey as umiPk, base58, transactionBuilder, some, lamports
} from "https://esm.sh/@metaplex-foundation/umi@1.2.0?bundle";
import { createUmi as createUmiDefaults } from "https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.2.0?bundle";
import { walletAdapterIdentity } from "https://esm.sh/@metaplex-foundation/umi-signer-wallet-adapters@1.2.0?bundle";

import {
  mplTokenMetadata, createV1, mintV1
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";

import {
  setComputeUnitLimit, setComputeUnitPrice, transferSol, findAssociatedTokenPda
} from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0?bundle";

import {
  Connection, PublicKey, VersionedTransaction, TransactionMessage
} from "https://esm.sh/@solana/web3.js@1.95.3";

/* ==================== FETCH REWRITE (redirect mainnet → worker) ==================== */
(function installFetchRewrite(){
  const MAINNET = /https:\/\/api\.mainnet-beta\.solana\.com\/?$/i;
  const TARGET  = CFG.RPCS[0]; // workers.dev first
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : (input?.url || "");
      if (MAINNET.test(url)) {
        console.warn("[rewrite] mainnet-beta → worker", { from: url, to: TARGET });
        return _fetch(TARGET, init);
      }
    } catch {}
    return _fetch(input, init);
  };
})();

/* ==================== HELPERS ==================== */
const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = "") => { const el = $("status"); if (!el) return; el.className = `status ${cls}`; el.innerHTML = t; };
const log = (msg, obj) => {
  const el = $("log"); if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}${obj ? " " + JSON.stringify(obj,null,2) : ""}\n`;
  el.scrollTop = el.scrollHeight;
};
const setSpin = (on) => {
  const sp = document.querySelector(".spinner");
  const lbl = document.querySelector(".btn-label");
  if (!sp || !lbl) return;
  sp.hidden = !on; lbl.style.opacity = on ? 0.75 : 1;
};
const toHttp = (u) => {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.replace("ipfs://","").replace(/^ipfs\//,"")}`;
  if (u.startsWith("/ipfs/"))  return `${CFG.GATEWAYS[0]}${u}`;
  return u;
};
const uriForId  = (id) => `ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const httpForId = (id, gw=0) => `${CFG.GATEWAYS[gw]}/${CFG.JSON_BASE_CID}/${id}.json`;

/* ==================== STATE ==================== */
let umi = null;
let phantom = null;
let rpcConn = null; // web3.js Connection via worker
let originalBtnText = "";
let claimedSet = new Set();
let availableIds = [];

/* ==================== RPC via Worker ==================== */
async function pickRpcEndpoint() {
  for (const url of CFG.RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "processed" }] }),
      });
      if (r.ok) return url;
    } catch {}
  }
  return CFG.RPCS[0];
}
async function ensureConnection() {
  if (rpcConn) return rpcConn;
  const chosen = await pickRpcEndpoint();
  rpcConn = new Connection(chosen, { commitment: "confirmed" });
  log("RPC ready", { rpc: chosen, build: BUILD_TAG });
  return rpcConn;
}

/* ==================== UI: Donation ==================== */
function getSelectedDonation() {
  const sel = document.querySelector('#donationOptions input[name="donation"]:checked');
  if (!sel) return 0;
  if (sel.value === 'custom') {
    const v = parseFloat($("customDonationInput").value);
    return isNaN(v) ? 0 : v;
  }
  return parseFloat(sel.value);
}
function updateEstimatedCost() {
  const total = CFG.MINT_FEE_SOL + getSelectedDonation();
  const lbl = $("costLabel"); if (lbl) lbl.textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ==================== WALLET (Phantom only) ==================== */
async function connectPhantom() {
  try {
    const w = window.solana;
    if (!w?.isPhantom) throw new Error("Phantom not found. Please install Phantom.");

    const resp = await w.connect(); // popup
    phantom = w;

    // UMI against our worker RPC
    umi = createUmiDefaults(CFG.RPCS[0]).use(walletAdapterIdentity(phantom)).use(mplTokenMetadata());

    // web3 Connection via worker
    await ensureConnection();

    const pk58 = resp.publicKey.toString();
    $("walletLabel").textContent = `${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent  = "Phantom connected";
    $("mintBtn").disabled = false;
    setStatus(`Wallet connected (${BUILD_TAG}). Ready to mint.`, "ok");
    log("Wallet connected", { address: pk58 });

    await updateBalance();

    phantom.on?.("disconnect", () => {
      $("walletLabel").textContent = "not connected";
      $("connectBtn").textContent  = "Connect Phantom";
      $("mintBtn").disabled = true;
      setStatus("Wallet disconnected. Please reconnect.", "warn");
    });
  } catch (e) {
    handleError("Wallet connection failed:", e);
  }
}

async function updateBalance() {
  if (!phantom?.publicKey) return;
  try {
    const conn = await ensureConnection();
    const lam = await conn.getBalance(new PublicKey(phantom.publicKey.toString()));
    const sol = lam / 1e9;
    $("balanceLabel").textContent = `${sol.toFixed(4)} SOL`;
  } catch (e) {
    $("balanceLabel").textContent = "—";
    log("Balance not available (RPC).", String(e?.message||e));
  }
}

/* ==================== CLAIMS (Worker) ==================== */
async function fetchClaims() {
  for (const url of CFG.CLAIMS) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const arr = Array.isArray(j) ? j : Array.isArray(j?.claimed) ? j.claimed : [];
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  return [];
}
async function markClaimed(i) {
  for (const url of CFG.CLAIMS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: i }) });
      if (r.ok) return;
    } catch {}
  }
}
function recomputeAvailable() {
  availableIds = [];
  for (let i = 0; i <= CFG.MAX_INDEX; i++) if (!claimedSet.has(i)) availableIds.push(i);
  const el = $("freeCounter"); if (el) el.textContent = `${availableIds.length} / ${CFG.MAX_INDEX + 1}`;
}
async function bootstrapClaims() {
  const arr = await fetchClaims();
  claimedSet = new Set(arr);
  recomputeAvailable();
}
async function isIdAvailable(id) {
  if (claimedSet.has(id)) return false;
  const checks = CFG.GATEWAYS.map(gw => fetch(`${gw}/${CFG.JSON_BASE_CID}/${id}.json`, { method: 'HEAD', cache: 'no-store' }).then(r=>r.ok).catch(()=>false));
  return (await Promise.all(checks)).some(Boolean);
}
async function pickRandomFreeId() {
  if (availableIds.length === 0) return 0;
  const shuffled = [...availableIds].sort(()=>Math.random()-0.5);
  for (const id of shuffled.slice(0,80)) if (await isIdAvailable(id)) return id;
  return shuffled[0] || 0;
}
async function setRandomFreeId() {
  const inp = $("tokenId"); if (!inp) return;
  setStatus("Searching free ID…", "info");
  const id = await pickRandomFreeId();
  inp.value = String(id);
  await updatePreview();
}

/* ==================== PREVIEW ==================== */
const previewCache = {};
async function updatePreview() {
  const id = Number($("tokenId").value || 0);
  $("previewUri").textContent = uriForId(id);
  $("uriStatus").textContent  = "checking URI…";

  const media = $("mediaBox");
  const metaBox = $("metaBox");
  media.innerHTML = '<span class="muted">Loading preview…</span>';
  metaBox.innerHTML = "";

  if (previewCache[id]) { renderPreview(id, previewCache[id]); return; }

  let meta = null;
  for (let i = 0; i < CFG.GATEWAYS.length; i++) {
    try {
      const res = await fetch(httpForId(id, i), { cache: "no-store" });
      if (!res.ok) continue;
      meta = await res.json();
      break;
    } catch {}
  }

  if (meta && !meta.image && CFG.PNG_BASE_CID)         meta.image = `ipfs://${CFG.PNG_BASE_CID}/${id}.png`;
  if (meta && !meta.animation_url && CFG.MP4_BASE_CID) meta.animation_url = `ipfs://${CFG.MP4_BASE_CID}/${id}.mp4`;

  if (!meta) {
    $("uriStatus").textContent = "⚠️ metadata not found";
    media.textContent = "—";
    return;
  }

  previewCache[id] = meta;
  renderPreview(id, meta);
}
function renderPreview(id, meta) {
  $("uriStatus").textContent = "✅ metadata loaded";

  const errs = [];
  if (!meta.name) errs.push("name missing");
  if (!meta.image && !meta.animation_url) errs.push("no media");
  if (meta.seller_fee_basis_points !== undefined && meta.seller_fee_basis_points !== CFG.ROYALTY_BPS) {
    errs.push(`royalties not ${CFG.ROYALTY_BPS / 100}%`);
  }
  if (errs.length) $("uriStatus").textContent += ` ⚠️ ${errs.join(", ")}`;

  const media = $("mediaBox");
  const mediaUrl = toHttp(meta.animation_url || meta.image);
  if (meta.animation_url) media.innerHTML = `<video src="${mediaUrl}" controls autoplay loop muted playsinline></video>`;
  else                    media.innerHTML = `<img src="${toHttp(meta.image)}" alt="Preview ${id}" />`;

  const metaBox = $("metaBox");
  const dl = document.createElement("dl");
  const add = (k,v)=>{ const dt=document.createElement("dt");dt.textContent=k; const dd=document.createElement("dd");dd.textContent=v; dl.append(dt,dd); };
  add("Name", meta.name || `Pi Pyramid #${id}`);
  if (meta.description) add("Description", meta.description);
  if (Array.isArray(meta.attributes)) add("Attributes", meta.attributes.map(a => `${a.trait_type||'Trait'}: ${a.value}`).join(" · "));
  metaBox.innerHTML = ""; metaBox.appendChild(dl);
}

/* ==================== MINT ==================== */
async function doMint() {
  try {
    const btn = $("mintBtn");
    btn.disabled = true;
    originalBtnText = btn.querySelector(".btn-label").textContent;
    btn.querySelector(".btn-label").textContent = "Processing…";
    setSpin(true);

    if (!umi || !phantom?.publicKey) throw new Error("Wallet not connected");
    const id = Number($("tokenId").value || 0);
    if (!Number.isInteger(id) || id < 0 || id > CFG.MAX_INDEX) throw new Error(`Invalid ID (0–${CFG.MAX_INDEX})`);

    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);

    await updateBalance().catch(()=>{});

    setStatus("Building transaction…", "info");
    log("Start mint", { id, donation });

    // ========== UMI: Instructions ==========
    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri  = uriForId(id);

    const collectionMint = umiPk(CFG.COLLECTION_MINT);
    const tokenAccount   = findAssociatedTokenPda(umi, { mint: mint.publicKey, owner: umi.identity.publicKey });

    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 300_000 }))
      .add(setComputeUnitPrice(umi, { microLamports: 5_000 }));

    // 0) fixed creator fee
    builder = builder.add(transferSol(umi, {
      from: umi.identity,
      to: umiPk(CFG.CREATOR),
      amount: lamports(Math.round(CFG.MINT_FEE_SOL * 1e9))
    }));

    // 0b) optional donation
    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    // 1) create NFT (unverified; verify on-chain later)
    builder = builder.add(createV1(umi, {
      mint,
      name: nftName,
      uri: nftUri,
      sellerFeeBasisPoints: CFG.ROYALTY_BPS,
      creators: some([{ address: umiPk(CFG.CREATOR), verified: false, share: 100 }]),
      collection: some({ key: collectionMint, verified: false }),
      tokenStandard: CFG.TOKEN_STANDARD,
      isMutable: true,
    }));

    // 2) mint to minter
    builder = builder.add(mintV1(umi, {
      mint: mint.publicKey,
      authority: umi.identity,
      token: tokenAccount,
      amount: 1,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: CFG.TOKEN_STANDARD,
    }));

    // ========== Blockhash (explicit) ==========
    const conn = await ensureConnection();
    let recentBlockhash;
    try {
      const { blockhash } = await conn.getLatestBlockhash("finalized");
      recentBlockhash = blockhash;
    } catch (e) {
      log("Could not fetch blockhash via worker RPC.", String(e?.message||e));
    }

    // IMPORTANT: set blockhash on the UMI builder to avoid SDK error
    if (recentBlockhash && typeof builder.setBlockhash === 'function') {
      try { builder = builder.setBlockhash(recentBlockhash); } catch {}
    }

    // Build UMI transaction
    const built = await builder.build(umi);

    // Convert to VersionedTransaction for Phantom
    const payer = new PublicKey(umi.identity.publicKey.toString());
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: recentBlockhash ?? base58.encode(
        built.getTransaction().message.recentBlockhash ?? new Uint8Array()
      ),
      instructions: built.getInstructions().map(ix => ({
        programId: new PublicKey(ix.getProgramAddress().toString()),
        keys: ix.getAccountMetas().map(m => ({
          pubkey: new PublicKey(m.address.toString()),
          isSigner: !!m.isSigner,
          isWritable: !!m.isWritable
        })),
        data: ix.getDataBytes()
      }))
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msg);

    // ========== Phantom sign+send ==========
    setStatus("Please sign in Phantom…", "info");
    const { signature } = await phantom.signAndSendTransaction(vtx);
    log("sent", { signature });

    setStatus(`⏳ Confirming transaction…`, "info");
    try {
      await conn.confirmTransaction(signature, "confirmed");
    } catch (e) {
      log("Confirmation via worker RPC failed (non-fatal).", String(e?.message||e));
    }

    const link = `https://solscan.io/tx/${signature}`;
    setStatus(`✅ Mint successful! <a class="link" href="${link}" target="_blank" rel="noopener">View on Solscan</a>`, "ok");

    await markClaimed(id);
    claimedSet.add(id); recomputeAvailable(); await setRandomFreeId();

  } catch (e) {
    handleError("Mint failed:", e);
  } finally {
    setSpin(false);
    const btn = $("mintBtn");
    if (btn) {
      btn.disabled = false;
      const lbl = btn.querySelector(".btn-label");
      if (lbl && originalBtnText) lbl.textContent = originalBtnText;
    }
  }
}

/* ==================== ERROR HANDLING ==================== */
function handleError(context, e) {
  console.error(context, e);
  let msg = e?.message || String(e);
  let user = msg;
  if (/user rejected|reject|denied|abgelehnt/i.test(msg)) user = "Signature rejected";
  else if (/insufficient funds|insufficient/i.test(msg)) user = "Insufficient SOL balance";
  setStatus(`❌ ${user}`, "err");
  log(`${context} ${msg}`);
}

/* ==================== UI WIRING ==================== */
function wireUI() {
  $("connectBtn")?.addEventListener("click", connectPhantom);
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  // Donation pills
  const pills = Array.from(document.querySelectorAll('#donationOptions .pill'));
  const customContainer = $("customDonationContainer");
  const customInput = $("customDonationInput");

  const applyDonationSelection = () => {
    pills.forEach(p => p.classList.remove("active"));
    const checked = document.querySelector('#donationOptions input[name="donation"]:checked');
    if (!checked) return;
    const pill = checked.closest(".pill");
    if (pill) pill.classList.add("active");
    customContainer.style.display = (checked.value === "custom") ? "inline-flex" : "none";
    updateEstimatedCost();
  };

  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      const radio = pill.querySelector('input[name="donation"]');
      if (!radio) return;
      radio.checked = true;
      applyDonationSelection();
    });
  });

  document.querySelectorAll('#donationOptions input[name="donation"]').forEach(radio => {
    radio.addEventListener("change", applyDonationSelection);
  });

  customInput?.addEventListener("input", updateEstimatedCost);

  applyDonationSelection();
  updateEstimatedCost();
}

/* ==================== BOOT ==================== */
document.addEventListener("DOMContentLoaded", async () => {
  log("System boot", { build: BUILD_TAG, rpcs: CFG.RPCS });
  wireUI();
  await bootstrapClaims().catch(()=>{});
  const inp = $("tokenId");
  if (inp) inp.value = "0";
  await setRandomFreeId();
});