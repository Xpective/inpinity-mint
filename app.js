/* ========= KONFIG ========= */
const CFG = {
  RPCs: [
    // Nur öffentliche, schlüssel-freie Endpoints:
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://solana.public-rpc.com"
  ],
  currentRPC: 0,

  CREATOR:  "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  COLLECTION_MINT: "DmKi8MtrpfQXVQvNjUfxWgBC3xFL2Qn5mvLDMgMZrNmS",

  ROYALTY_BPS: 700,
  MAX_INDEX: 9999,

  // Deine CIDs auf deinem Gateway
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  MP4_BASE_CID:  "bafybeic6dwzp2lk3xf7wylsxo5kqqmvcgqlf6pp4v4ov3e2x6evrjipbam",
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",

  GATEWAYS: [
    "https://ipfs.inpinity.online/ipfs",
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs"
  ],

  BASE_ESTIMATED_COST: 0.003, // grobe Schätzung
  TOKEN_STANDARD: 4
};

/* ========= IMPORTS ========= */
import { createUmi } from "https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.2.0?bundle";
import { publicKey as umiPk, generateSigner, transactionBuilder, lamports, base58, some } from "https://esm.sh/@metaplex-foundation/umi@1.2.0?bundle";
import { walletAdapterIdentity } from "https://esm.sh/@metaplex-foundation/umi-signer-wallet-adapters@1.2.0?bundle";
import {
  mplTokenMetadata,
  createV1,
  mintV1,
  findMasterEditionPda,
  findMetadataPda
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";
import {
  setComputeUnitLimit,
  setComputeUnitPrice,
  transferSol,
  findAssociatedTokenPda   // <— RICHTIG: kommt aus mpl-toolbox
} from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0?bundle";

/* ========= HELPERS ========= */
const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = "") => {
  const el = $("status"); if (!el) return;
  el.className = `status ${cls}`; el.innerHTML = t;
};
const log = (msg, obj) => {
  const el = $("log"); if (!el) return;
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  if (obj) console.debug(line, obj);
  el.textContent += line + (obj ? " " + JSON.stringify(obj, null, 2) : "") + "\n";
  el.scrollTop = el.scrollHeight;
  if (/error|warn|fehler|⚠️/i.test(msg)) {
    el.classList.remove("hidden");
    $("toggleLogs").textContent = "Ausblenden";
  }
};

const setSpin = (on) => {
  const sp = document.querySelector(".spinner");
  const lbl = document.querySelector(".btn-label");
  if (!sp || !lbl) return;
  sp.hidden = !on;
  lbl.style.opacity = on ? 0.75 : 1;
};

const uriForId  = (id) => `ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const httpForId = (id, gw = 0) => `${CFG.GATEWAYS[gw]}/${CFG.JSON_BASE_CID}/${id}.json`;
const toHttp = (u) => {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.replace("ipfs://","").replace(/^ipfs\//,"")}`;
  if (u.startsWith("/ipfs/"))  return `${CFG.GATEWAYS[0]}${u}`;
  return u;
};

/* ========= SPENDE ========= */
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
  const total = CFG.BASE_ESTIMATED_COST + getSelectedDonation();
  const lbl = $("costLabel"); if (lbl) lbl.textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ========= WALLET (PHANTOM ONLY) ========= */
let umi = null;
let originalText = "";

async function connectPhantom() {
  try {
    const adapter = window.solana?.isPhantom ? window.solana : null;
    if (!adapter) throw new Error("Phantom nicht gefunden. Bitte Phantom Wallet installieren.");

    const resp = await adapter.connect();
    const pk58 = resp.publicKey.toString();
    $("walletLabel").textContent = `${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent  = "Phantom verbunden";
    log("Wallet verbunden", { wallet: "phantom", address: pk58 });

    umi = createUmi(CFG.RPCs[CFG.currentRPC])
      .use(walletAdapterIdentity(adapter))
      .use(mplTokenMetadata());

    await updateBalance();
    $("mintBtn").disabled = false;
    setStatus("Wallet verbunden. Bereit zum Minten.", "ok");

    adapter.on?.("disconnect", () => {
      log("Wallet getrennt");
      $("walletLabel").textContent = "nicht verbunden";
      $("connectBtn").textContent  = "Mit Phantom verbinden";
      $("mintBtn").disabled = true;
      setStatus("Wallet getrennt. Bitte erneut verbinden.", "warn");
    });
  } catch (e) {
    handleError("Wallet-Verbindung fehlgeschlagen:", e);
  }
}

/* ========= CLAIMS (optional, aktuell leer) ========= */
let claimedSet = new Set();
let availableIds = [];

function recomputeAvailable() {
  availableIds = [];
  for (let i = 0; i <= CFG.MAX_INDEX; i++) if (!claimedSet.has(i)) availableIds.push(i);
  const el = $("freeCounter"); if (el) el.textContent = `${availableIds.length} / ${CFG.MAX_INDEX + 1}`;
}
async function isIdAvailable(id) {
  if (claimedSet.has(id)) return false;
  const checks = CFG.GATEWAYS.map(gw =>
    fetch(`${gw}/${CFG.JSON_BASE_CID}/${id}.json`, { method: 'HEAD', cache: 'no-store' })
      .then(r=>r.ok).catch(()=>false)
  );
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
  $("uriStatus").textContent  = "prüfe URI …";

  const media = $("mediaBox");
  const metaBox = $("metaBox");
  media.innerHTML = '<span class="muted">Lade Vorschau…</span>';
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

  // Fallbacks (falls dein JSON minimal ist)
  if (meta && !meta.image)         meta.image = `ipfs://${CFG.PNG_BASE_CID}/${id}.png`;
  if (meta && !meta.animation_url) meta.animation_url = `ipfs://${CFG.MP4_BASE_CID}/${id}.mp4`;

  if (!meta) {
    $("uriStatus").textContent = "⚠️ Metadaten nicht gefunden";
    media.textContent = "—";
    return;
  }

  previewCache[id] = meta;
  renderPreview(id, meta);
}

function renderPreview(id, meta) {
  $("uriStatus").textContent = "✅ Metadaten geladen";

  const errs = [];
  if (!meta.name) errs.push("Name fehlt");
  if (!meta.image && !meta.animation_url) errs.push("Medien fehlen");
  if (meta.seller_fee_basis_points !== undefined && meta.seller_fee_basis_points !== CFG.ROYALTY_BPS) {
    errs.push(`Royalties nicht ${CFG.ROYALTY_BPS / 100}%`);
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
  if (meta.description) add("Beschreibung", meta.description);
  if (Array.isArray(meta.attributes)) add("Attribute", meta.attributes.map(a => `${a.trait_type||'Trait'}: ${a.value}`).join(" · "));
  metaBox.innerHTML = ""; metaBox.appendChild(dl);
}

/* ========= MINT (minimal) ========= */
async function doMint() {
  try {
    const mintBtn = $("mintBtn");
    mintBtn.disabled = true;
    originalText = mintBtn.querySelector(".btn-label").textContent;
    mintBtn.querySelector(".btn-label").textContent = "Verarbeite...";
    setSpin(true);

    if (!umi) throw new Error("Wallet nicht verbunden");
    const id = Number($("tokenId").value || 0);
    if (!Number.isInteger(id) || id < 0 || id > CFG.MAX_INDEX) throw new Error(`Ungültige ID (0–${CFG.MAX_INDEX})`);

    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);

    const bal = await umi.rpc.getBalance(umi.identity.publicKey);
    const sol = Number(bal.basisPoints) / 1e9;
    const need = CFG.BASE_ESTIMATED_COST + donation;
    if (sol < need) throw new Error(`Unzureichendes SOL (~${need.toFixed(3)} SOL benötigt)`);

    setStatus("Baue Transaktion...", "info");
    log("Starte Mint", { id, donation });

    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri  = uriForId(id);

    const collectionMint   = umiPk(CFG.COLLECTION_MINT);
    const collectionMeta   = findMetadataPda(umi, { mint: collectionMint });
    const collectionEdition= findMasterEditionPda(umi, { mint: collectionMint });

    // Empfänger-Token-Account (ATA) für den Mintee
    const tokenAccount = findAssociatedTokenPda(umi, {
      mint: mint.publicKey,
      owner: umi.identity.publicKey
    });

    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 350_000 }))
      .add(setComputeUnitPrice(umi, { microLamports: 5_000 }));

    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    // Erstellen (public, Collection NICHT verifiziert) + Mint 1
    builder = builder.add(createV1(umi, {
      mint,
      name: nftName,
      uri: nftUri,
      sellerFeeBasisPoints: CFG.ROYALTY_BPS,
      creators: some([{ address: umiPk(CFG.CREATOR), verified: true, share: 100 }]),
      collection: some({ key: collectionMint, verified: false }),
      tokenStandard: CFG.TOKEN_STANDARD,
      isMutable: true
    }));

    builder = builder.add(mintV1(umi, {
      mint: mint.publicKey,
      authority: umi.identity,
      token: tokenAccount,
      amount: 1,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: CFG.TOKEN_STANDARD
    }));

    setStatus("Bitte im Wallet signieren…", "info");
    log("Sende Transaktion…");

    // RPC-Fallback
    let result;
    for (let i = 0; i < CFG.RPCs.length; i++) {
      try {
        umi.rpc = createUmi(CFG.RPCs[i]).rpc;
        result = await builder.sendAndConfirm(umi);
        break;
      } catch (e) {
        log(`RPC Fehler (${CFG.RPCs[i]}): ${e?.message || e}`);
        if (i === CFG.RPCs.length - 1) throw e;
      }
    }

    const txSig = base58.encode(result.signature);
    const link  = `https://solscan.io/tx/${txSig}?cluster=mainnet`;
    setStatus(`✅ Mint erfolgreich! <a href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");
    log("Mint erfolgreich", { signature: txSig });

    claimedSet.add(id); recomputeAvailable(); await setRandomFreeId();

  } catch (e) {
    handleError("Mint fehlgeschlagen:", e);
  } finally {
    setSpin(false);
    $("mintBtn").disabled = false;
    $("mintBtn").querySelector(".btn-label").textContent = originalText;
  }
}

/* ========= ERRORS ========= */
function handleError(context, e) {
  const msg = e?.message || String(e);
  let user = msg;
  if (/user rejected|reject/i.test(msg)) user = "Signierung abgebrochen";
  else if (/insufficient funds/i.test(msg)) user = "Unzureichendes SOL-Guthaben";
  setStatus(`❌ ${user}`, "err");
  log(`${context} ${msg}`);
}

/* ========= UI ========= */
function wireUI() {
  $("connectBtn")?.addEventListener("click", connectPhantom);
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  $("toggleLogs")?.addEventListener("click", () => {
    const el = $("log");
    el.classList.toggle("hidden");
    $("toggleLogs").textContent = el.classList.contains("hidden") ? "Anzeigen" : "Ausblenden";
  });

  // Spenden UI
  const pills = Array.from(document.querySelectorAll('#donationOptions .pill'));
  const customContainer = $("customDonationContainer");
  const customInput = $("customDonationInput");

  const applyDonationSelection = () => {
    pills.forEach(p => p.classList.remove("active"));
    const checked = document.querySelector('#donationOptions input[name="donation"]:checked');
    if (!checked) return;
    const pill = checked.closest(".pill");
    if (pill) pill.classList.add("active");
    if (checked.value === "custom") customContainer.classList.add("visible");
    else customContainer.classList.remove("visible");
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

async function updateBalance() {
  if (!umi) return;
  try {
    const bal = await umi.rpc.getBalance(umi.identity.publicKey);
    const sol = Number(bal.basisPoints) / 1e9;
    $("balanceLabel").textContent = `${sol.toFixed(4)} SOL`;

    const total = CFG.BASE_ESTIMATED_COST + getSelectedDonation();
    if (sol < total * 1.2) {
      $("balanceLabel").classList.add("low-balance");
      setStatus(`⚠️ Niedriges Guthaben (${sol.toFixed(4)} SOL)`, "warn");
    } else {
      $("balanceLabel").classList.remove("low-balance");
    }
  } catch (e) {
    log("Balance Fehler", e);
  }
}

/* ========= START ========= */
document.addEventListener("DOMContentLoaded", async () => {
  recomputeAvailable();   // (claims aktuell leer)
  wireUI();
  await updatePreview();

  // Hinweis: Andere Browser-Wallets (EVM) können Konsolenwarnungen loggen; die sind hier irrelevant.
});
