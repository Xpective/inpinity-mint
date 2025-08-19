/* ==================== BUILD-ID (Cache/Debug) ==================== */
const BUILD_TAG = "mint-v15";

/* ==================== KONFIG ==================== */
const CFG = {
  RPCS: [
    "https://api.inpinity.online/rpc",
    "https://inpinity-rpc-proxy.s-plat.workers.dev/rpc",
  ],
  CLAIMS: [
    "https://api.inpinity.online/claims",
    "https://inpinity-rpc-proxy.s-plat.workers.dev/claims",
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
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs",
    "https://ipfs.inpinity.online/ipfs"
  ],
};

/* ==================== IMPORTS ==================== */
import {
  Connection, PublicKey, Transaction, SystemProgram, Keypair
} from "https://esm.sh/@solana/web3.js@1.95.3";

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction
} from "https://esm.sh/@solana/spl-token@0.4.9";

import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
  createCreateMasterEditionV3Instruction
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle";

/* ==================== FETCH-REWRITE (Safety) ==================== */
(function installFetchRewrite(){
  const MAINNET = /https:\/\/api\.mainnet-beta\.solana\.com\/?$/i;
  const TARGET  = CFG.RPCS[0];
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : (input?.url || "");
      if (MAINNET.test(url)) {
        console.warn("[rewrite] redirect mainnet-beta → worker", { from: url, to: TARGET });
        return _fetch(TARGET, init);
      }
    } catch {}
    return _fetch(input, init);
  };
})();

/* ==================== HELPERS ==================== */
const $ = (id) => document.getElementById(id);
const setStatus = (t, cls = "") => { const el = $("status"); if (!el) return; el.className = `status ${cls}`; el.innerHTML = t; };
const log = (msg, obj) => { const el = $("log"); if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}${obj ? " " + JSON.stringify(obj,null,2) : ""}\n`;
  el.scrollTop = el.scrollHeight;
};
const setSpin = (on) => { const sp = document.querySelector(".spinner"); const lbl = document.querySelector(".btn-label"); if (!sp || !lbl) return; sp.hidden = !on; lbl.style.opacity = on ? 0.75 : 1; };
const toHttp = (u) => { if (!u) return u; if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.replace("ipfs://","").replace(/^ipfs\//,"")}`; if (u.startsWith("/ipfs/")) return `${CFG.GATEWAYS[0]}${u}`; return u; };
const uriForId  = (id) => `ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const httpForId = (id, gw=0) => `${CFG.GATEWAYS[gw]}/${CFG.JSON_BASE_CID}/${id}.json`;
const eqPk = (a, b) => { try { return (typeof a === 'string' ? a : a?.toString?.()) === (typeof b === 'string' ? b : b?.toString?.()); } catch { return false; } };

/* ==================== STATE ==================== */
let connection = null;
let phantom = null;
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
  return "https://api.mainnet-beta.solana.com";
}
async function ensureConnection() {
  if (connection) return connection;
  const chosen = await pickRpcEndpoint();
  connection = new Connection(chosen, "confirmed");
  log("RPC ready", { rpc: chosen, build: BUILD_TAG });
  return connection;
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
    if (!w?.isPhantom) throw new Error("Phantom nicht gefunden. Bitte Phantom installieren.");
    const resp = await w.connect(); // Popup
    phantom = w;

    await ensureConnection();

    const pk58 = resp.publicKey.toString();
    $("walletLabel").textContent = `${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent  = "Phantom verbunden";
    $("mintBtn").disabled = false;
    setStatus(`Wallet verbunden (${BUILD_TAG}). Bereit zum Minten.`, "ok");
    log("Wallet connected", { address: pk58 });

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
    const conn = await ensureConnection();
    const lam = await conn.getBalance(new PublicKey(phantom.publicKey.toString()));
    const sol = lam / 1e9;
    $("balanceLabel").textContent = `${sol.toFixed(4)} SOL`;
  } catch (e) {
    $("balanceLabel").textContent = "—";
    log("Balance nicht abrufbar (RPC).", String(e?.message||e));
  }
}

/* ==================== CLAIMS (Worker) ==================== */
async function fetchClaims() {
  for (const url of CFG.CLAIMS) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      if (!j) continue;
      if (Array.isArray(j)) return j;
      if (Array.isArray(j.claimed)) return j.claimed;
    } catch {}
  }
  return [];
}
async function markClaimed(i) {
  for (const url of CFG.CLAIMS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index: i })
      });
      if (r.status === 200) { log("claim stored", { index: i }); return; }
      if (r.status === 409) { log("claim already existed", { index: i }); return; }
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

/* ==================== PDAs ==================== */
const TM_PID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
async function findMetadataPda(mint) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("metadata"), TM_PID.toBuffer(), mint.toBuffer()],
    TM_PID
  );
  return pda;
}
async function findMasterEditionPda(mint) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("metadata"), TM_PID.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    TM_PID
  );
  return pda;
}

/* ==================== MINT ==================== */
async function doMint() {
  try {
    const btn = $("mintBtn");
    btn.disabled = true;
    originalBtnText = btn.querySelector(".btn-label").textContent;
    btn.querySelector(".btn-label").textContent = "Verarbeite...";
    setSpin(true);

    if (!phantom?.publicKey) throw new Error("Wallet nicht verbunden");
    const id = Number($("tokenId").value || 0);
    if (!Number.isInteger(id) || id < 0 || id > CFG.MAX_INDEX) throw new Error(`Ungültige ID (0–${CFG.MAX_INDEX})`);

    const donation = getSelectedDonation();
    const donationLamports = Math.round(donation * 1e9);

    await updateBalance().catch(()=>{});
    setStatus("Baue Transaktion...", "info");
    log("Start mint", { id, donation });

    const conn = await ensureConnection();
    const wallet = phantom;
    const payer = wallet.publicKey;

    // --- Keys & derived accounts
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;
    const ata = await getAssociatedTokenAddress(mint, payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const metadataPda = await findMetadataPda(mint);
    const masterEditionPda = await findMasterEditionPda(mint);
    const creatorPk = new PublicKey(CFG.CREATOR);
    const collectionMint = new PublicKey(CFG.COLLECTION_MINT);
    const isSelf = payer.equals(creatorPk);

    // --- Rent for mint account
    const rentLamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);

    const tx = new Transaction();

    // Optional: fixed fee + donation
    if (!isSelf) {
      tx.add(
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: creatorPk, lamports: Math.round(CFG.MINT_FEE_SOL * 1e9) })
      );
      if (donationLamports > 0) {
        tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: creatorPk, lamports: donationLamports }));
      }
    }

    // 1) Create Mint account
    tx.add(SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports: rentLamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID
    }));

    // 2) Initialize Mint (decimals 0, mintAuthority = payer, freezeAuthority = payer)
    tx.add(createInitializeMintInstruction(mint, 0, payer, payer, TOKEN_PROGRAM_ID));

    // 3) Create ATA
    tx.add(createAssociatedTokenAccountInstruction(payer, ata, payer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

    // 4) Mint 1 token to ATA
    tx.add(createMintToInstruction(mint, ata, payer, 1, [], TOKEN_PROGRAM_ID));

    // 5) Metadata
    tx.add(createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPda,
        mint,
        mintAuthority: payer,
        payer,
        updateAuthority: payer,
      },
      {
        createMetadataAccountArgsV3: {
          data: {
            name: `Pi Pyramid #${id}`,
            symbol: "PP",
            uri: uriForId(id),
            sellerFeeBasisPoints: CFG.ROYALTY_BPS,
            creators: [{ address: creatorPk, verified: false, share: 100 }],
            collection: { key: collectionMint, verified: false },  // unverified; Verifikation kann nur Collection-Authority
            uses: null
          },
          isMutable: true,
          collectionDetails: null
        }
      }
    ));

    // 6) Master Edition (supply 0 = non-printable)
    tx.add(createCreateMasterEditionV3Instruction(
      {
        edition: masterEditionPda,
        mint,
        updateAuthority: payer,
        mintAuthority: payer,
        payer,
        metadata: metadataPda
      },
      { createMasterEditionArgs: { maxSupply: 0 } }
    ));

    // --- Finalize & sign
    tx.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
    tx.recentBlockhash = blockhash;

    // The new mint account needs its own signature
    tx.partialSign(mintKeypair);

    // Phantom signs as payer
    const signed = await phantom.signTransaction(tx);

    // Send raw (skip preflight to avoid simulate errors)
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 });
    log("sent", { signature: sig });

    // Confirm
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    const link = `https://solscan.io/tx/${sig}`;
    setStatus(`✅ Mint erfolgreich! <a class="link" href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");

    await markClaimed(id);
    claimedSet.add(id); recomputeAvailable(); await setRandomFreeId();

  } catch (e) {
    const msg = e?.message || String(e);
    if (/Transaction simulation failed|simulation/i.test(msg)) {
      // wir senden ohnehin mit skipPreflight – also nur loggen
      log("simulate hint", msg);
    }
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

/* ==================== START ==================== */
document.addEventListener("DOMContentLoaded", async () => {
  log("System boot", { build: BUILD_TAG, rpcs: CFG.RPCS });
  wireUI();
  await bootstrapClaims();
  const inp = $("tokenId");
  if (inp) { inp.value = "0"; }
  await setRandomFreeId();
});