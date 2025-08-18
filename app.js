/* ==================== KONFIG ==================== */
const CFG = {
  // Offizielles Solana RPC – nur für BALANCE (Mint/Broadcast laufen über Phantom)
  SOLANA_MAINNET_RPC: "https://api.mainnet-beta.solana.com",

  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  COLLECTION_MINT: "DmKi8MtrpfQXVQvNjUfxWgBC3xFL2Qn5mvLDMgMZrNmS",

  ROYALTY_BPS: 700,
  MAX_INDEX: 9999,
  BASE_ESTIMATED_COST: 0.003,
  TOKEN_STANDARD: 4, // NFT

  // Deine IPFS CIDs
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  MP4_BASE_CID:  "bafybeic6dwzp2lk3xf7wylsxo5kqqmvcgqlf6pp4v4ov3e2x6evrjipbam",
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",

  // Dein Gateway zuerst
  GATEWAYS: [
    "https://ipfs.inpinity.online/ipfs",
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs"
  ],
};

/* ==================== IMPORTS ==================== */
// UMI-Kern + Wallet-Adapter-Bridge
import { createUmi, generateSigner, publicKey as umiPk, base58, transactionBuilder, some, lamports } from "https://esm.sh/@metaplex-foundation/umi@1.2.0?bundle";
import { createUmi as createUmiDefaults } from "https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.2.0?bundle";
import { walletAdapterIdentity } from "https://esm.sh/@metaplex-foundation/umi-signer-wallet-adapters@1.2.0?bundle";

// Token Metadata Instruktionen
import {
  mplTokenMetadata,
  createV1,
  mintV1,
  findMasterEditionPda
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";

// Toolbox (Compute Units + SOL-Transfer + ATA PDA)
import {
  setComputeUnitLimit,
  setComputeUnitPrice,
  transferSol,
  findAssociatedTokenPda
} from "https://esm.sh/@metaplex-foundation/mpl-toolbox@0.10.0?bundle";

// Web3.js NUR für (de)serialisieren & Phantom signAndSend
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  Keypair
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
const setSpin = (on) => { const sp = document.querySelector(".spinner"); const lbl = document.querySelector(".btn-label"); if (!sp || !lbl) return; sp.hidden = !on; lbl.style.opacity = on ? 0.75 : 1; };

const uriForId  = (id) => `ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const httpForId = (id, gw=0) => `${CFG.GATEWAYS[gw]}/${CFG.JSON_BASE_CID}/${id}.json`;
const toHttp = (u) => {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.replace("ipfs://","").replace(/^ipfs\//,"")}`;
  if (u.startsWith("/ipfs/"))  return `${CFG.GATEWAYS[0]}${u}`;
  return u;
};

/* ==================== STATE ==================== */
let umi = null;
let phantom = null;
let originalBtnText = "";

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
  const total = CFG.BASE_ESTIMATED_COST + getSelectedDonation();
  const lbl = $("costLabel"); if (lbl) lbl.textContent = `≈ ${total.toFixed(3)} SOL`;
}

/* ==================== WALLET (nur Phantom) ==================== */
async function connectPhantom() {
  try {
    phantom = window.solana?.isPhantom ? window.solana : null;
    if (!phantom) throw new Error("Phantom nicht gefunden. Bitte die Phantom Browser-Extension installieren.");

    const resp = await phantom.connect(); // öffnet Phantom-Popup
    const pk58 = resp.publicKey.toString();

    // UMI initialisieren (ohne HTTP-RPC zum Senden – nur für Instruktionsbau)
    umi = createUmiDefaults(CFG.SOLANA_MAINNET_RPC) // default setup – nutzen wir NICHT zum Broadcast
      .use(walletAdapterIdentity(phantom))
      .use(mplTokenMetadata());

    $("walletLabel").textContent = `${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent  = "Phantom verbunden";
    $("mintBtn").disabled = false;
    setStatus("Wallet verbunden. Bereit zum Minten.", "ok");
    log("Wallet verbunden", { address: pk58 });

    // Balance anzeigen (best effort über offizielles RPC)
    await updateBalance();

    phantom.on?.("disconnect", () => {
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

/* ==================== BALANCE (nur offizielles RPC, graceful) ==================== */
async function updateBalance() {
  if (!phantom?.publicKey) return;
  try {
    const conn = new Connection(CFG.SOLANA_MAINNET_RPC, { commitment: "confirmed" });
    const lam = await conn.getBalance(new PublicKey(phantom.publicKey.toString())); // kann 403/429 werfen
    const sol = lam / 1e9;
    $("balanceLabel").textContent = `${sol.toFixed(4)} SOL`;
    const warn = sol < (CFG.BASE_ESTIMATED_COST + getSelectedDonation()) * 1.2;
    if (warn) setStatus(`⚠️ Niedriges Guthaben (${sol.toFixed(4)} SOL)`, "warn");
  } catch (e) {
    // Nur Anzeige – Mint funktioniert trotzdem via Phantom
    $("balanceLabel").textContent = "—";
    log("Balance nicht abrufbar (offizielles RPC hat blockiert).", String(e?.message||e));
  }
}

/* ==================== CLAIMS (optional leer) ==================== */
let claimedSet = new Set();
let availableIds = [];
function recomputeAvailable() {
  availableIds = [];
  for (let i = 0; i <= CFG.MAX_INDEX; i++) if (!claimedSet.has(i)) availableIds.push(i);
  const el = $("freeCounter"); if (el) el.textContent = `${availableIds.length} / ${CFG.MAX_INDEX + 1}`;
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

    // (Optional) Balance anzeigen – fehltschlag ist ok
    await updateBalance();

    setStatus("Baue Transaktion...", "info");
    log("Starte Mint", { id, donation });

    // ========== UMI: Instruktionen bauen ==========
    const mint = generateSigner(umi);
    const nftName = `Pi Pyramid #${id}`;
    const nftUri  = uriForId(id);

    const collectionMint    = umiPk(CFG.COLLECTION_MINT);
    const collectionEdition = findMasterEditionPda(umi, { mint: collectionMint });
    const tokenAccount      = findAssociatedTokenPda(umi, { mint: mint.publicKey, owner: umi.identity.publicKey });

    let builder = transactionBuilder()
      .add(setComputeUnitLimit(umi, { units: 300_000 }))
      .add(setComputeUnitPrice(umi, { microLamports: 5_000 })); // kleine Priority Fee

    if (donationLamports > 0) {
      builder = builder.add(transferSol(umi, {
        from: umi.identity,
        to: umiPk(CFG.CREATOR),
        amount: lamports(donationLamports)
      }));
    }

    builder = builder.add(createV1(umi, {
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

    // ========== Transaktion vorbereiten (ohne RPC-Broadcast) ==========
    // 1) Aktuellen blockhash holen – via Phantom Connection-Relay umgehen wir hier Connection:
    // Wir nehmen den Blockhash via offizieller Connection. Falls 403: informiere, und Phantom sendet trotzdem.
    let recentBlockhash = undefined;
    try {
      const conn = new Connection(CFG.SOLANA_MAINNET_RPC, { commitment: "confirmed" });
      const { blockhash } = await conn.getLatestBlockhash("finalized");
      recentBlockhash = blockhash;
    } catch (e) {
      log("Blockhash vom offiziellen RPC nicht verfügbar (fahre fort, Phantom sendet).", String(e?.message||e));
    }

    // 2) UMI-Builder -> web3.js VersionedTransaction
    const built = await builder.build(umi); // UmiTransaction
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: new PublicKey(umi.identity.publicKey.toString()),
      recentBlockhash: recentBlockhash ?? base58.encode(built.getTransaction().message.recentBlockhash ?? new Uint8Array()),
      instructions: built.getTransaction().message.compiledInstructions.map(ix => ({
        programId: new PublicKey(base58.encode(built.getTransaction().message.staticAccountKeys[ix.programIdIndex])),
        keys: ix.accountKeyIndexes.map(idx => ({
          pubkey: new PublicKey(base58.encode(built.getTransaction().message.staticAccountKeys[idx])),
          isSigner: false,
          isWritable: true
        })),
        data: built.getTransaction().message.compiledInstructionsData ? built.getTransaction().message.compiledInstructionsData : new Uint8Array()
      }))
    }).compileToV0Message());

    // 3) Phantom sign+send (nutzt Phantom Relay; kein eigener RPC nötig)
    setStatus("Bitte im Wallet signieren…", "info");
    const { signature } = await phantom.signAndSendTransaction(vtx);
    log("gesendet", { signature });

    setStatus(`⏳ Bestätige Transaktion…`, "info");
    // Bestätigung (best effort) über offizielles RPC
    try {
      const conn = new Connection(CFG.SOLANA_MAINNET_RPC, { commitment: "confirmed" });
      await conn.confirmTransaction(signature, "confirmed");
    } catch (e) {
      log("Bestätigung via offizielles RPC fehlgeschlagen (Phantom hat trotzdem gesendet).", String(e?.message||e));
    }

    const link = `https://solscan.io/tx/${signature}?cluster=mainnet`;
    setStatus(`✅ Mint erfolgreich! <a href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");

    // Markiere ID lokal & wähle neue
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

  // Spenden-Pills
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

/* ==================== START ==================== */
document.addEventListener("DOMContentLoaded", async () => {
  wireUI();
  recomputeAvailable();
  await updatePreview();
});
