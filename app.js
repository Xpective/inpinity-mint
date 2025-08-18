/* ========= KONFIGURATION ========= */
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
  ROYALTY_BPS: 700,
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  CLAIMS_CID: "bafkreibxkf7f6pognam7mh22po4kzymsckbecxyqkuos335fypvqtbnvoa",
  MAX_INDEX: 9999,
  GATEWAYS: [
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs",
    "https://dweb.link/ipfs"
  ],
  BASE_ESTIMATED_COST: 0.012, // Basisgebühren ohne Spende (nur grobe Schätzung)
  TOKEN_STANDARD: 4
};

/* ========= IMPORTS ========= */
import { createUmi } from "https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.2.0";
import { publicKey as umiPk, generateSigner, transactionBuilder, lamports, base58, some } from "https://esm.sh/@metaplex-foundation/umi@1.2.0";
import { walletAdapterIdentity } from "https://esm.sh/@metaplex-foundation/umi-signer-wallet-adapters@1.2.0";
import {
  mplTokenMetadata,
  createV3,
  mintV1,
  findMasterEditionPda,
  findMetadataPda,
  findAssociatedTokenPda
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0";
import { setComputeUnitLimit, transferSol } from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0";

/* ========= UTILS ========= */
const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = "") => {
  const el = $("status");
  if (!el) return;
  el.className = `status ${cls}`;
  el.innerHTML = t;
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
  if (!sp || !lbl) return;
  sp.hidden = !on;
  lbl.style.opacity = on ? 0.75 : 1;
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
  $("costLabel").textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ========= WALLET ========= */
let wallet = null;
let umi = null;
let originalText = "";

async function connectWallet(walletType) {
  try {
    let adapter = null;
    switch (walletType) {
      case "phantom":
        if (window.solana?.isPhantom) adapter = window.solana;
        break;
      case "backpack":
        if (window.backpack?.isBackpack) adapter = window.backpack;
        break;
      case "solflare":
        if (window.solflare?.isSolflare) adapter = window.solflare;
        break;
    }
    if (!adapter) throw new Error(`${walletType} nicht verfügbar (Extension installieren?)`);

    const resp = await adapter.connect();
    wallet = adapter;

    const pk58 = resp.publicKey.toBase58();
    $("walletLabel").textContent = `${pk58.slice(0, 4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent = walletType.charAt(0).toUpperCase() + walletType.slice(1);
    $("walletMenu").classList.remove("active");
    log("wallet connected", { wallet: walletType, address: pk58 });

    umi = createUmi(CFG.RPCs[CFG.currentRPC])
      .use(walletAdapterIdentity(wallet))
      .use(mplTokenMetadata());

    await updateBalance();
    $("mintBtn").disabled = false;
    setStatus("Wallet verbunden. Bereit zum Minten.", "ok");

    wallet.on?.("disconnect", () => {
      log("wallet disconnected");
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

async function loadClaims() {
  try {
    const url = `${CFG.GATEWAYS[0]}/${CFG.CLAIMS_CID}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (Array.isArray(j.claimed) ? j.claimed : []);
    claimedSet = new Set(arr.map(Number));
    log(`claims geladen: ${arr.length} IDs`);
  } catch (e) {
    claimedSet = new Set();
    log(`claims nicht erreichbar → ignoriere. Grund: ${e?.message || e}`);
  }
  recomputeAvailable();
}
function recomputeAvailable() {
  availableIds = [];
  for (let i = 0; i <= CFG.MAX_INDEX; i++) if (!claimedSet.has(i)) availableIds.push(i);
  const el = $("freeCounter");
  if (el) el.textContent = `${availableIds.length} / ${CFG.MAX_INDEX + 1}`;
}
async function isIdAvailable(id) {
  if (claimedSet.has(id)) return false;
  for (let i = 0; i < CFG.GATEWAYS.length; i++) {
    try {
      const response = await fetch(httpForId(id, i), { method: 'HEAD', cache: 'no-store' });
      if (response.ok) return true;
    } catch {}
  }
  return false;
}
async function pickRandomFreeId() {
  if (availableIds.length === 0) return 0;
  const shuffled = [...availableIds].sort(() => 0.5 - Math.random());
  for (const id of shuffled) {
    if (await isIdAvailable(id)) return id;
  }
  return 0;
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
async function updatePreview() {
  const id = Number($("tokenId").value || 0);
  $("previewUri").textContent = uriForId(id);
  $("uriStatus").textContent = "prüfe URI …";

  const media = $("mediaBox");
  const metaBox = $("metaBox");
  media.innerHTML = '<span class="muted">Lade Vorschau…</span>';
  metaBox.innerHTML = "";

  try {
    let ok = false;
    for (let i = 0; i < CFG.GATEWAYS.length; i++) {
      try {
        const res = await fetch(httpForId(id, i), { cache: "no-store" });
        if (!res.ok) continue;

        $("uriStatus").textContent = `✅ JSON gefunden (via ${new URL(CFG.GATEWAYS[i]).hostname})`;
        const meta = await res.json();

        const errors = [];
        if (!meta.name) errors.push("Name fehlt");
        if (!meta.image && !meta.animation_url) errors.push("Medien fehlen");
        if (!meta.attributes) errors.push("Attributes fehlen");
        if (meta.seller_fee_basis_points !== CFG.ROYALTY_BPS) {
          errors.push(`Royalties nicht ${CFG.ROYALTY_BPS / 100}%`);
        }
        if (errors.length) $("uriStatus").textContent += ` ⚠️ ${errors.join(", ")}`;

        const mediaUrl = meta.animation_url || meta.image;
        if (meta.animation_url) {
          media.innerHTML = `<video src="${mediaUrl}" controls autoplay loop muted playsinline style="max-width:100%"></video>`;
        } else {
          media.innerHTML = `<img src="${mediaUrl}" alt="preview" style="max-width:100%"/>`;
        }

        const dl = document.createElement("dl");
        const add = (k, v) => { const dt=document.createElement("dt"); dt.textContent=k; const dd=document.createElement("dd"); dd.textContent=v; dl.append(dt,dd); };
        add("Name", meta.name || `Pi Pyramid #${id}`);
        if (meta.description) add("Beschreibung", meta.description);
        if (Array.isArray(meta.attributes)) add("Attribute", meta.attributes.map(a => `${a.trait_type}: ${a.value}`).join(" · "));
        metaBox.appendChild(dl);

        ok = true; break;
      } catch {}
    }
    if (!ok) {
      $("uriStatus").textContent = "⚠️ Konnte Metadaten nicht laden";
      media.textContent = "—";
    }
  } catch (e) {
    $("uriStatus").textContent = "⚠️ Netzwerk-Problem";
    media.textContent = "—";
    log(`preview error: ${e?.message || e}`);
  }
}

/* ========= MINT ========= */
async function doMint() {
  try {
    $("mintBtn").disabled = true;
    originalText = $("mintBtn").querySelector(".btn-label").textContent;
    $("mintBtn").querySelector(".btn-label").textContent = "Verarbeite...";

    if (!umi) throw new Error("Bitte Wallet verbinden");
    const id = Number($("tokenId").value || 0);
    if (!Number.isInteger(id) || id < 0 || id > CFG.MAX_INDEX) throw new Error(`Ungültige Token-Nummer: 0-${CFG.MAX_INDEX}`);

    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);

    const balance = await umi.rpc.getBalance(umi.identity.publicKey);
    const solBalance = Number(balance.basisPoints) / 1e9;
    const totalCost = CFG.BASE_ESTIMATED_COST + donation;
    if (solBalance < totalCost) throw new Error(`Unzureichendes Guthaben. Benötigt: ${totalCost.toFixed(3)} SOL`);

    setStatus(`Baue Transaktion...`);
    log("build tx", { id, donation });

    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri = uriForId(id);

    const collectionMint = umiPk(CFG.COLLECTION_MINT);
    const collectionMetadata = findMetadataPda(umi, { mint: collectionMint });
    const collectionEdition = findMasterEditionPda(umi, { mint: collectionMint });

    const metadata = findMetadataPda(umi, { mint: mint.publicKey });
    const tokenAccount = findAssociatedTokenPda(umi, { mint: mint.publicKey, owner: umi.identity.publicKey });

    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 600_000 }));

    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    builder = builder.add(createV3(umi, {
      mint,
      name: nftName,
      uri: nftUri,
      sellerFeeBasisPoints: CFG.ROYALTY_BPS,
      creators: some([{ address: umiPk(CFG.CREATOR), verified: true, share: 100 }]),
      collection: some({ key: collectionMint, verified: false }),
      tokenStandard: CFG.TOKEN_STANDARD,
      isMutable: true,
    }));

    builder = builder.add(mintV1(umi, {
      mint: mint.publicKey,
      authority: umi.identity,
      token: tokenAccount,
      amount: 1,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: CFG.TOKEN_STANDARD,
    }));

    setSpin(true);
    setStatus("Bitte Transaktion im Wallet signieren…", "");
    log("sende Transaktion…");

    const result = await builder.sendAndConfirm(umi);
    const txSig = base58.encode(result.signature);
    log("Mint erfolgreich", { signature: txSig, rpc: CFG.RPCs[CFG.currentRPC] });
    const explorerLink = `https://solscan.io/tx/${txSig}?cluster=mainnet`;
    setStatus(`✅ Mint erfolgreich! <a href="${explorerLink}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");

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

/* ========= ERRORS ========= */
function handleError(context, e) {
  console.error(context, e);
  let msg = e?.message || String(e);
  let userMsg = msg;
  if (/user rejected/i.test(msg)) userMsg = "Du hast die Transaktion abgelehnt";
  else if (/insufficient funds/i.test(msg)) userMsg = "Unzureichendes SOL-Guthaben";
  else if (/already in use/i.test(msg)) { userMsg = "Diese ID wurde bereits gemintet"; setRandomFreeId(); }

  setStatus(`❌ ${userMsg}`, "err");
  log(`error: ${msg}`);
}

/* ========= UI ========= */
function wireUI() {
  $("connectBtn")?.addEventListener("click", () => $("walletMenu").classList.toggle("active"));
  document.querySelectorAll(".wallet-option").forEach(btn => btn.addEventListener("click", () => connectWallet(btn.dataset.wallet)));

  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  $("toggleLogs")?.addEventListener("click", () => {
    const logEl = $("log");
    logEl.classList.toggle("hidden");
    $("toggleLogs").textContent = logEl.classList.contains("hidden") ? "Anzeigen" : "Ausblenden";
  });

  document.querySelectorAll('#donationOptions input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.value === 'custom') $("customDonationContainer").classList.add("visible");
      else $("customDonationContainer").classList.remove("visible");
      updateEstimatedCost();
    });
  });

  $("customDonationInput")?.addEventListener("input", updateEstimatedCost);
  updateEstimatedCost();
}

async function updateBalance() {
  try {
    const balance = await umi.rpc.getBalance(umi.identity.publicKey);
    const solBalance = Number(balance.basisPoints) / 1e9;
    $("balanceLabel").textContent = `${solBalance.toFixed(4)} SOL`;

    const donation = getSelectedDonation();
    const totalCost = CFG.BASE_ESTIMATED_COST + donation;

    if (solBalance < totalCost * 1.5) {
      $("balanceLabel").classList.add("low-balance");
      setStatus(`⚠️ Niedriges Guthaben (${solBalance.toFixed(4)} SOL)`, "warn");
    } else {
      $("balanceLabel").classList.remove("low-balance");
    }
  } catch (e) {
    log("balance error", e);
  }
}

/* ========= START ========= */
document.addEventListener("DOMContentLoaded", async () => {
  wireUI();
  await loadClaims();
  log("Anwendung gestartet");
  await updatePreview();
});
