/* ==================== KONFIG ==================== */
const CFG = {
  // RPC über deinen Worker (primär Domain-Route, fallback workers.dev):
  RPCS: [
    "https://api.inpinity.online/rpc",
    "https://inpinity-rpc-proxy.s-plat.workers.dev/rpc"
  ],
  CLAIMS: [
    "https://api.inpinity.online/claims",
    "https://inpinity-rpc-proxy.s-plat.workers.dev/claims"
  ],

  // Treasury/Creator (fixe Mint-Fee + optionale Donations)
  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  MINT_FEE_SOL: 0.02,

  // Optional: Collection (kannst du später on-chain verifizieren)
  COLLECTION_MINT: "DmKi8MtrpfQXVQvNjUfxWgBC3xFL2Qn5mvLDMgMZrNmS",

  ROYALTY_BPS: 700, // 7 %
  TOKEN_STANDARD: 4, // Metaplex V1
  MAX_INDEX: 9999,

  // IPFS
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  // Falls im JSON kein image/animation_url ist, fallback:
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",
  MP4_BASE_CID:  "",

  // Gateways (dein Gateway zuerst)
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
  mplTokenMetadata, createV1, mintV1, findMasterEditionPda
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";

import {
  setComputeUnitLimit, setComputeUnitPrice, transferSol, findAssociatedTokenPda
} from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0?bundle";

import {
  Connection, PublicKey, VersionedTransaction, TransactionMessage
} from "https://esm.sh/@solana/web3.js@1.95.3";

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

function firstOkUrl(urls) {
  let i = 0;
  return async function doFetch(input, init) {
    while (i < urls.length) {
      const base = urls[i];
      try {
        const res = await fetch(base, init);
        if (res.status !== 403 && res.status !== 429 && res.status < 500) return res;
      } catch {}
      i++;
    }
    // letzter Versuch mit erster URL — für debugging
    return fetch(urls[0], init);
  };
}

/* ==================== STATE ==================== */
let umi = null;
let phantom = null;
let rpcConn = null; // über Worker
let originalBtnText = "";
let claimedSet = new Set();
let availableIds = [];

/* ==================== RPC via Worker ==================== */
function buildConnection() {
  // web3.js Connection auf deinen Worker (erste erreichbare)
  for (const e of CFG.RPCS) {
    // kein Ping hier – wir probieren beim ersten call
    return new Connection(e, { commitment: "confirmed" });
  }
  return new Connection(CFG.RPCS[0], { commitment: "confirmed" });
}

/* ==================== UI: Spenden ==================== */
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
  const total = 0.02 + getSelectedDonation(); // fixe 0.02 SOL + Donation
  const lbl = $("costLabel"); if (lbl) lbl.textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ==================== WALLET (Phantom only) ==================== */
async function connectPhantom() {
  try {
    const w = window.solana;
    if (!w?.isPhantom) throw new Error("Phantom nicht gefunden. Bitte Phantom installieren.");

    const resp = await w.connect(); // Popup
    phantom = w;

    // UMI (kein Broadcast nötig, wir bauen nur Instruktionen)
    // Ein RPC wird von UMI nicht zwingend benötigt – setzen wir aber auf deinen Worker für evtl. lookups:
    umi = createUmiDefaults(CFG.RPCS[0]).use(walletAdapterIdentity(phantom)).use(mplTokenMetadata());

    rpcConn = buildConnection();

    const pk58 = resp.publicKey.toString();
    $("walletLabel").textContent = `${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent  = "Phantom verbunden";
    $("mintBtn").disabled = false;
    setStatus("Wallet verbunden. Bereit zum Minten.", "ok");
    log("Wallet verbunden", { address: pk58 });

    await updateBalance();

    phantom.on?.("disconnect", () => {
      $("walletLabel").textContent = "nicht verbunden";
      $("connectBtn").textContent  = "Mit Phantom verbinden";
      $("mintBtn").disabled = true;
      setStatus("Wallet getrennt. Bitte erneut verbinden.", "warn");
    });
  } catch (e) {
    handleError("Wallet-Verbindung fehlgeschlagen:", e);
  }
}

async function updateBalance() {
  if (!phantom?.publicKey) return;
  try {
    const lam = await rpcConn.getBalance(new PublicKey(phantom.publicKey.toString()));
    const sol = lam / 1e9;
    $("balanceLabel").textContent = `${sol.toFixed(4)} SOL`;
  } catch (e) {
    $("balanceLabel").textContent = "—";
    log("Balance nicht abrufbar (RPC).", String(e?.message||e));
  }
}

/* ==================== CLAIMS (Worker) ==================== */
function claimsUrl() { return CFG.CLAIMS.find(Boolean); }

async function fetchClaims() {
  try {
    const r = await fetch(claimsUrl());
    if (!r.ok) return [];
    const j = await r.json();
    const arr = Array.isArray(j) ? j : Array.isArray(j.claimed) ? j.claimed : j.claimed ?? [];
    return arr;
  } catch { return []; }
}
async function markClaimed(i) {
  try {
    await fetch(claimsUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: i }) });
  } catch {}
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
  setStatus("Suche freie ID...", "info");
  const id = await pickRandomFreeId();
  inp.value = String(id);
  await updatePreview();
}

/* ==================== PREVIEW ==================== */
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

  if (meta && !meta.image && CFG.PNG_BASE_CID)         meta.image = `ipfs://${CFG.PNG_BASE_CID}/${id}.png`;
  if (meta && !meta.animation_url && CFG.MP4_BASE_CID) meta.animation_url = `ipfs://${CFG.MP4_BASE_CID}/${id}.mp4`;

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

/* ==================== MINT ==================== */
async function doMint() {
  try {
    const btn = $("mintBtn");
    btn.disabled = true;
    originalBtnText = btn.querySelector(".btn-label").textContent;
    btn.querySelector(".btn-label").textContent = "Verarbeite...";
    setSpin(true);

    if (!umi || !phantom?.publicKey) throw new Error("Wallet nicht verbunden");
    const id = Number($("tokenId").value || 0);
    if (!Number.isInteger(id) || id < 0 || id > CFG.MAX_INDEX) throw new Error(`Ungültige ID (0–${CFG.MAX_INDEX})`);

    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);

    await updateBalance().catch(()=>{});

    setStatus("Baue Transaktion...", "info");
    log("Starte Mint", { id, donation });

    // ========== UMI: Instruktionen ==========
    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri  = uriForId(id);

    const collectionMint    = umiPk(CFG.COLLECTION_MINT);
    const collectionEdition = findMasterEditionPda(umi, { mint: collectionMint });
    const tokenAccount      = findAssociatedTokenPda(umi, { mint: mint.publicKey, owner: umi.identity.publicKey });

    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 300_000 }))
      .add(setComputeUnitPrice(umi, { microLamports: 5_000 })); // kleine Priority Fee

    // 0) Fixe Creator-Fee 0.02 SOL
    builder = builder.add(transferSol(umi, {
      from: umi.identity,
      to: umiPk(CFG.CREATOR),
      amount: lamports(Math.round(CFG.MINT_FEE_SOL * 1e9))
    }));

    // 0b) Optionale Spende
    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    // 1) NFT anlegen (unverified creator; du verifizierst später on-chain)
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

    // 2) Eine Edition minten an den Minter
    builder = builder.add(mintV1(umi, {
      mint: mint.publicKey,
      authority: umi.identity,
      token: tokenAccount,
      amount: 1,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: CFG.TOKEN_STANDARD,
    }));

    // ========== Transaktion bauen → VersionedTransaction ==========
    // Hole Blockhash über deinen Worker-RPC (kein 403)
    let recentBlockhash = undefined;
    try {
      const { blockhash } = await rpcConn.getLatestBlockhash("finalized");
      recentBlockhash = blockhash;
    } catch (e) {
      log("Blockhash via Worker-RPC nicht verfügbar – Phantom sendet trotzdem.", String(e?.message||e));
    }

    const built = await builder.build(umi);
    // Mapping der UMI-Message → v0 message (vereinfachtes Mapping, ausreichend hier)
    const payer = new PublicKey(umi.identity.publicKey.toString());
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: recentBlockhash ?? base58.encode(built.getTransaction().message.recentBlockhash ?? new Uint8Array()),
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
    setStatus("Bitte im Wallet signieren…", "info");
    const { signature } = await phantom.signAndSendTransaction(vtx);
    log("gesendet", { signature });

    setStatus(`⏳ Bestätige Transaktion…`, "info");
    try {
      await rpcConn.confirmTransaction(signature, "confirmed");
    } catch (e) {
      log("Bestätigung via Worker-RPC fehlgeschlagen (okay).", String(e?.message||e));
    }

    const link = `https://solscan.io/tx/${signature}`;
    setStatus(`✅ Mint erfolgreich! <a class="link" href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");

    // markiere ID in Claims
    await markClaimed(id);
    claimedSet.add(id); recomputeAvailable(); await setRandomFreeId();

  } catch (e) {
    handleError("Mint fehlgeschlagen:", e);
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
  if (/user rejected|reject|denied|Abgelehnt/i.test(msg)) user = "Signierung abgebrochen";
  else if (/insufficient funds|insufficient/i.test(msg)) user = "Unzureichendes SOL-Guthaben";
  setStatus(`❌ ${user}`, "err");
  log(`${context} ${msg}`);
}

/* ==================== UI WIRING ==================== */
function wireUI() {
  $("connectBtn")?.addEventListener("click", connectPhantom);
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  // Donation-Pills
  const pills = Array.from(document.querySelectorAll('#donationOptions .pill'));
  const customContainer = $("customDonationContainer");
  const customInput = $("customDonationInput");

  const applyDonationSelection = () => {
    pills.forEach(p => p.classList.remove("active"));
    const checked = document.querySelector('#donationOptions input[name="donation"]:checked');
    if (!checked) return;
    const pill = checked.closest(".pill");
    if (pill) pill.classList.add("active");
    if (checked.value === "custom") customContainer.style.display = "inline-flex";
    else customContainer.style.display = "none";
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

/* ==================== START ==================== */
document.addEventListener("DOMContentLoaded", async () => {
  wireUI();
  await bootstrapClaims();
  // first preview:
  const inp = $("tokenId");
  inp.value = "0"; // auto
  await setRandomFreeId();
});