/* ========= OPTIMIERTE MAINNET KONFIGURATION ========= */
const CFG = {
  RPCs: [
    "https://solana-mainnet.g.alchemy.com/v2/cBEi0C9aUmPjjBTGGJ02-9",
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana"
  ],
  currentRPC: 0,
  TREASURY: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  COLLECTION_MINT: "DmKi8MtrpfQXVQvNjUfxWgBC3xFL2Qn5mvLDMgMZrNmS",
  ROYALTY_BPS: 700, // 7% Royalties
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  CLAIMS_CID: "bafkreibxkf7f6pognam7mh22po4kzymsckbecxyqkuos335fypvqtbnvoa",
  MAX_INDEX: 9999, // 0-9999 NFTs
  GATEWAYS: [
    "https://cloudflare-ipfs.com/ipfs",
    "https://ipfs.io/ipfs",
    "https://dweb.link/ipfs"
  ],
  BASE_ESTIMATED_COST: 0.003, // Realistische Mainnet-Gebühren
  TOKEN_STANDARD: 4 // Metaplex Token Standard (NFT)
};

/* ========= MAINNET IMPORTS ========= */
import { createUmi } from "https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.2.0?bundle";
import { publicKey as umiPk, generateSigner, transactionBuilder, lamports, base58, some } from "https://esm.sh/@metaplex-foundation/umi@1.2.0?bundle";
import { walletAdapterIdentity } from "https://esm.sh/@metaplex-foundation/umi-signer-wallet-adapters@1.2.0?bundle";
import {
  mplTokenMetadata,
  createV3,
  mintV1,
  findMasterEditionPda,
  findMetadataPda,
  findAssociatedTokenPda
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";
import { setComputeUnitLimit, setComputeUnitPrice, transferSol } from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0?bundle";

/* ========= UTILS ========= */
const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = "") => {
  const el = $("status");
  if (el) {
    el.className = `status ${cls}`;
    el.innerHTML = t;
  }
};
const log = (msg, obj) => {
  try {
    const logEl = $("log");
    if (!logEl) return;
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    if (obj) console.debug(line, obj);
    logEl.textContent += line + (obj ? " " + JSON.stringify(obj, null, 2) : "") + "\n";
    logEl.scrollTop = logEl.scrollHeight;
    if (/error|warn/i.test(msg)) {
      logEl.classList.remove("hidden");
      $("toggleLogs").textContent = "Ausblenden";
    }
  } catch {}
};
const setSpin = (on) => {
  const sp = document.querySelector(".spinner");
  const lbl = document.querySelector(".btn-label");
  if (sp && lbl) {
    sp.hidden = !on;
    lbl.style.opacity = on ? 0.75 : 1;
  }
};
const uriForId = (id) => `ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const httpForId = (id, gatewayIndex = 0) => `${CFG.GATEWAYS[gatewayIndex]}/${CFG.JSON_BASE_CID}/${id}.json`;

/* ========= SPENDE ========= */
function getSelectedDonation() {
  const selected = document.querySelector('#donationOptions input[name="donation"]:checked');
  if (!selected) return 0;
  if (selected.value === 'custom') {
    const v = parseFloat($("customDonationInput").value);
    return isNaN(v) ? 0 : v;
  }
  return parseFloat(selected.value);
}
function updateEstimatedCost() {
  const donation = getSelectedDonation();
  const total = CFG.BASE_ESTIMATED_COST + donation;
  const costLabel = $("costLabel");
  if (costLabel) costLabel.textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ========= WALLET ========= */
let wallet = null;
let umi = null;
let originalText = "";

async function connectWallet(walletType) {
  try {
    let adapter = null;
    switch (walletType) {
      case "phantom": adapter = window.solana?.isPhantom ? window.solana : null; break;
      case "backpack": adapter = window.backpack?.isBackpack ? window.backpack : null; break;
      case "solflare": adapter = window.solflare?.isSolflare ? window.solflare : null; break;
    }
    if (!adapter) throw new Error(`${walletType} nicht verfügbar`);

    const resp = await adapter.connect();
    wallet = adapter;
    const pk58 = resp.publicKey.toString();
    $("walletLabel").textContent = `${pk58.slice(0, 4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent = walletType.charAt(0).toUpperCase() + walletType.slice(1);
    $("walletMenu").classList.remove("active");
    log("Wallet verbunden", { wallet: walletType, address: pk58 });

    // Mainnet UMI mit Fallback-RPCs
    umi = createUmi(CFG.RPCs[CFG.currentRPC])
      .use(walletAdapterIdentity(wallet))
      .use(mplTokenMetadata());

    await updateBalance();
    $("mintBtn").disabled = false;
    setStatus("Wallet verbunden. Bereit zum Minten.", "ok");

    // Wallet Disconnect-Handler
    wallet.on?.("disconnect", () => {
      log("Wallet getrennt");
      $("walletLabel").textContent = "nicht verbunden";
      $("connectBtn").textContent = "Wallet verbinden";
      $("mintBtn").disabled = true;
      setStatus("Wallet getrennt. Bitte erneut verbinden.", "warn");
    });
  } catch (e) {
    handleError("Wallet-Verbindung fehlgeschlagen: ", e);
  }
}

/* ========= CLAIMS ========= */
let claimedSet = new Set();
let availableIds = [];
let claimsLoaded = false;

async function loadClaims() {
  if (claimsLoaded) return;
  try {
    const url = `${CFG.GATEWAYS[0]}/${CFG.CLAIMS_CID}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    claimedSet = new Set(Array.isArray(j) ? j : (j.claimed || []));
    log(`Claims geladen: ${claimedSet.size} IDs`);
    claimsLoaded = true;
  } catch (e) {
    log(`Claims nicht geladen: ${e?.message || e}`);
  }
  recomputeAvailable();
}
function recomputeAvailable() {
  availableIds = [];
  for (let i = 0; i <= CFG.MAX_INDEX; i++) {
    if (!claimedSet.has(i)) availableIds.push(i);
  }
  const el = $("freeCounter");
  if (el) el.textContent = `${availableIds.length} / ${CFG.MAX_INDEX + 1}`;
}
async function isIdAvailable(id) {
  if (claimedSet.has(id)) return false;
  
  // Parallel Gateway-Check
  const checks = CFG.GATEWAYS.map(gateway => 
    fetch(`${gateway}/${CFG.JSON_BASE_CID}/${id}.json`, { method: 'HEAD' })
      .then(res => res.ok)
      .catch(() => false)
  );
  
  const results = await Promise.all(checks);
  return results.some(ok => ok);
}
async function pickRandomFreeId() {
  if (availableIds.length === 0) return 0;
  
  // Zufällige IDs priorisieren
  const shuffled = [...availableIds].sort(() => Math.random() - 0.5);
  
  // Schnelle Verfügbarkeitsprüfung
  for (const id of shuffled.slice(0, 50)) {
    if (await isIdAvailable(id)) return id;
  }
  return shuffled[0] || 0;
}
async function setRandomFreeId() {
  const inp = $("tokenId");
  if (!inp) return;
  setStatus("Suche freie ID...", "info");
  const id = await pickRandomFreeId();
  inp.value = String(id);
  await updatePreview();
}

/* ========= PREVIEW ========= */
const previewCache = {};
async function updatePreview() {
  const id = Number($("tokenId").value || 0);
  $("previewUri").textContent = uriForId(id);
  $("uriStatus").textContent = "prüfe URI …";

  const media = $("mediaBox");
  const metaBox = $("metaBox");
  media.innerHTML = '<span class="muted">Lade Vorschau…</span>';
  metaBox.innerHTML = "";

  // Cache-Check
  if (previewCache[id]) {
    renderPreview(id, previewCache[id]);
    return;
  }

  try {
    let meta = null;
    for (let i = 0; i < CFG.GATEWAYS.length; i++) {
      try {
        const res = await fetch(httpForId(id, i), { cache: "no-store" });
        if (!res.ok) continue;
        meta = await res.json();
        previewCache[id] = meta; // Cache
        break;
      } catch {}
    }

    if (!meta) {
      $("uriStatus").textContent = "⚠️ Metadaten nicht gefunden";
      media.textContent = "—";
      return;
    }

    renderPreview(id, meta);
  } catch (e) {
    $("uriStatus").textContent = "⚠️ Fehler beim Laden";
    media.textContent = "—";
    log(`Preview Fehler: ${e?.message || e}`);
  }
}

function renderPreview(id, meta) {
  $("uriStatus").textContent = "✅ Metadaten geladen";
  
  // Validierung
  const errors = [];
  if (!meta.name) errors.push("Name fehlt");
  if (!meta.image && !meta.animation_url) errors.push("Medien fehlen");
  if (!meta.attributes) errors.push("Attributes fehlen");
  if (meta.seller_fee_basis_points !== CFG.ROYALTY_BPS) {
    errors.push(`Royalties nicht ${CFG.ROYALTY_BPS / 100}%`);
  }
  if (errors.length) {
    $("uriStatus").textContent += ` ⚠️ ${errors.join(", ")}`;
  }

  // Medien anzeigen
  const media = $("mediaBox");
  const mediaUrl = meta.animation_url || meta.image;
  if (mediaUrl) {
    if (meta.animation_url) {
      media.innerHTML = `<video src="${mediaUrl}" controls autoplay loop muted playsinline></video>`;
    } else {
      media.innerHTML = `<img src="${mediaUrl}" alt="Preview ${id}" />`;
    }
  } else {
    media.textContent = "Kein Medieninhalt";
  }

  // Metadaten anzeigen
  const metaBox = $("metaBox");
  const dl = document.createElement("dl");
  const addMeta = (key, value) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  };
  
  addMeta("Name", meta.name || `Pi Pyramid #${id}`);
  if (meta.description) addMeta("Beschreibung", meta.description);
  if (Array.isArray(meta.attributes)) {
    addMeta("Attribute", meta.attributes.map(a => 
      `${a.trait_type || 'Eigenschaft'}: ${a.value}`
    ).join(" · "));
  }
  
  metaBox.innerHTML = "";
  metaBox.appendChild(dl);
}

/* ========= MINT ========= */
async function doMint() {
  try {
    // UI vorbereiten
    const mintBtn = $("mintBtn");
    mintBtn.disabled = true;
    originalText = mintBtn.querySelector(".btn-label").textContent;
    mintBtn.querySelector(".btn-label").textContent = "Verarbeite...";
    setSpin(true);

    // Validierungen
    if (!umi) throw new Error("Wallet nicht verbunden");
    const id = Number($("tokenId").value || 0);
    if (isNaN(id) || id < 0 || id > CFG.MAX_INDEX) {
      throw new Error(`Ungültige ID: Muss zwischen 0-${CFG.MAX_INDEX} sein`);
    }

    // Spende berechnen
    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);
    
    // SOL-Balance prüfen
    const balance = await umi.rpc.getBalance(umi.identity.publicKey);
    const solBalance = Number(balance.basisPoints) / 1e9;
    const totalCost = CFG.BASE_ESTIMATED_COST + donation;
    if (solBalance < totalCost) {
      throw new Error(`Unzureichendes SOL: Benötigt ${totalCost.toFixed(3)} SOL`);
    }

    setStatus(`Baue Transaktion...`);
    log("Starte Mint", { id, donation });

    // NFT Parameter
    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri = uriForId(id);

    // Collection Referenzen
    const collectionMint = umiPk(CFG.COLLECTION_MINT);
    const collectionMetadata = findMetadataPda(umi, { mint: collectionMint });
    const collectionEdition = findMasterEditionPda(umi, { mint: collectionMint });

    // NFT Accounts
    const metadata = findMetadataPda(umi, { mint: mint.publicKey });
    const tokenAccount = findAssociatedTokenPda(umi, { 
      mint: mint.publicKey, 
      owner: umi.identity.publicKey 
    });

    // Transaktion bauen
    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 400_000 })) // Optimierte Compute Units
      .add(setComputeUnitPrice(umi, { microLamports: 5000 })); // Priorisierte Gebühr

    // Spende hinzufügen (wenn >0)
    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    // NFT erstellen
    builder = builder.add(createV3(umi, {
      mint,
      name: nftName,
      uri: nftUri,
      sellerFeeBasisPoints: CFG.ROYALTY_BPS,
      creators: some([{ 
        address: umiPk(CFG.CREATOR), 
        verified: true, 
        share: 100 
      }]),
      collection: some({ 
        key: collectionMint, 
        verified: false // Wichtig für public mint!
      }),
      tokenStandard: CFG.TOKEN_STANDARD,
      isMutable: true,
    }));

    // NFT minten
    builder = builder.add(mintV1(umi, {
      mint: mint.publicKey,
      authority: umi.identity,
      token: tokenAccount,
      amount: 1,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: CFG.TOKEN_STANDARD,
    }));

    setStatus("Bitte signieren...", "info");
    log("Sende Transaktion...");

    // Transaktion senden (mit RPC-Fallback)
    let result;
    for (let attempt = 0; attempt < CFG.RPCs.length; attempt++) {
      try {
        umi.rpc = createUmi(CFG.RPCs[attempt]).rpc;
        result = await builder.sendAndConfirm(umi);
        break;
      } catch (e) {
        log(`RPC Fehler (${CFG.RPCs[attempt]}): ${e.message}`);
        if (attempt === CFG.RPCs.length - 1) throw e;
      }
    }

    // Erfolgsmeldung
    const txSig = base58.encode(result.signature);
    log("Mint erfolgreich", { tx: txSig });
    const explorerLink = `https://solscan.io/tx/${txSig}?cluster=mainnet`;
    setStatus(`✅ Mint erfolgreich! <a href="${explorerLink}" target="_blank">Transaktion ansehen</a>`, "ok");

    // UI aktualisieren
    claimedSet.add(id);
    recomputeAvailable();
    await setRandomFreeId();

  } catch (e) {
    handleError("Mint fehlgeschlagen: ", e);
  } finally {
    setSpin(false);
    $("mintBtn").disabled = false;
    $("mintBtn").querySelector(".btn-label").textContent = originalText;
  }
}

/* ========= ERROR HANDLING ========= */
function handleError(context, e) {
  console.error(context, e);
  let msg = e?.message || String(e);
  let userMsg = msg;
  
  // Benutzerfreundliche Fehlermeldungen
  if (/user rejected/i.test(msg)) userMsg = "Signierung abgebrochen";
  else if (/insufficient funds/i.test(msg)) userMsg = "Unzureichendes SOL-Guthaben";
  else if (/already in use/i.test(msg)) userMsg = "ID bereits gemintet";
  else if (/invalid public key/i.test(msg)) userMsg = "Ungültige Wallet";
  
  setStatus(`❌ ${userMsg}`, "err");
  log(`Fehler: ${msg}`);
}

/* ========= UI ========= */
function wireUI() {
  // Wallet Handling
  $("connectBtn")?.addEventListener("click", () => 
    $("walletMenu").classList.toggle("active"));
  
  document.querySelectorAll(".wallet-option").forEach(btn => 
    btn.addEventListener("click", () => connectWallet(btn.dataset.wallet)));

  // Mint Handling
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  // Log Handling
  $("toggleLogs")?.addEventListener("click", () => {
    const logEl = $("log");
    logEl.classList.toggle("hidden");
    $("toggleLogs").textContent = logEl.classList.contains("hidden") ? "Anzeigen" : "Ausblenden";
  });

  // Spenden Handling
  document.querySelectorAll('#donationOptions input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.value === 'custom') {
        $("customDonationContainer").classList.add("visible");
      } else {
        $("customDonationContainer").classList.remove("visible");
      }
      updateEstimatedCost();
    });
  });

  $("customDonationInput")?.addEventListener("input", updateEstimatedCost);
}

async function updateBalance() {
  if (!umi) return;
  try {
    const balance = await umi.rpc.getBalance(umi.identity.publicKey);
    const solBalance = Number(balance.basisPoints) / 1e9;
    $("balanceLabel").textContent = `${solBalance.toFixed(4)} SOL`;

    const donation = getSelectedDonation();
    const totalCost = CFG.BASE_ESTIMATED_COST + donation;

    // Warnung bei niedrigem Guthaben
    if (solBalance < totalCost * 1.2) {
      $("balanceLabel").classList.add("low-balance");
      setStatus(`⚠️ Niedriges Guthaben (${solBalance.toFixed(4)} SOL)`, "warn");
    } else {
      $("balanceLabel").classList.remove("low-balance");
    }
  } catch (e) {
    log("Balance Fehler", e);
  }
}

/* ========= MAINNET START ========= */
document.addEventListener("DOMContentLoaded", async () => {
  wireUI();
  updateEstimatedCost();
  
  // Mainnet Initialisierung
  log("Starte auf Solana Mainnet");
  await loadClaims();
  await updatePreview();
  
  // Auto-Connect wenn Wallet verbunden
  if (window.solana?.isConnected) {
    connectWallet("phantom");
  }
});