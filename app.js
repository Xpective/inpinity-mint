/* ==================== BUILD-ID (Cache/Debug) ==================== */
const BUILD_TAG = "mint-v16-phantom";

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
  COLLECTION_MINT: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",

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
// Web3.js + SPL + Metaplex (ohne Umi)
import {
  Connection, PublicKey, Transaction, SystemProgram,
  Keypair, ComputeBudgetProgram
} from "https://esm.sh/@solana/web3.js@1.95.3";

import {
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "https://esm.sh/@solana/spl-token@0.4.9";

// Namespace-Import der Token-Metadata-Instruction-Fabrikfunktionen
// ✅ neu – ganz oben bei den Imports einfügen
import {
  createCreateMetadataAccountV3Instruction,
  createCreateMasterEditionV3Instruction,
  createSetAndVerifySizedCollectionItemInstruction,
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?exports=createCreateMetadataAccountV3Instruction,createCreateMasterEditionV3Instruction,createSetAndVerifySizedCollectionItemInstruction";
/* ==================== SEEDS (Browser-kompatibel, kein Buffer) ==================== */
const te = new TextEncoder();
const METADATA_SEED = te.encode("metadata");
const EDITION_SEED  = te.encode("edition");

/* ==================== FETCH-REWRITE (Safety) ==================== */
(function installFetchRewrite(){
  const MAINNET = /https:\/\/api\.mainnet-beta\.solana\.com\/?$/i;
  const TARGET  = CFG.RPCS[0]; // bevorzugter Worker
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

// Metaplex Token Metadata Program ID (fest)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// PDA: Metadata(mint)
function findMetadataPda(mint) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

// PDA: MasterEdition(mint)
function findMasterEditionPda(mint) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

// PDA: EditionMark(mint, edition)
function findEditionMarkPda(mint, edition) {
  const editionNumber = Math.floor(edition / 248);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
      Buffer.from(editionNumber.toString()),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

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
const eqPk = (a, b) => {
  try { return (typeof a === 'string' ? a : a?.toString?.()) === (typeof b === 'string' ? b : b?.toString?.()); }
  catch { return false; }
};

/* ==================== STATE ==================== */
let connection = null;
let phantom = null;
let rpcConn = null;
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

    phantom.on("disconnect", () => {
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

    const connection = await ensureConnection();
    const wallet = phantom;
    const payer = wallet.publicKey;
    
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;
    const nftName = `Pi Pyramid #${id}`;
    const nftUri  = uriForId(id);

    const collectionMint = new PublicKey(CFG.COLLECTION_MINT);
    const creatorPk = new PublicKey(CFG.CREATOR);
    const isSelf = payer.equals(creatorPk);

    // Get associated token account
    const associatedTokenAccount = await getAssociatedTokenAddress(
      mint,
      payer,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const transaction = new Transaction();

    // Add compute unit instructions
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })
    );
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 })
    );

    // Transfer SOL fee if not self
    if (!isSelf) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: creatorPk,
          lamports: Math.round(CFG.MINT_FEE_SOL * 1e9)
        })
      );
      
      if (donationLamports > 0) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: creatorPk,
            lamports: donationLamports
          })
        );
      }
    }

    // Calculate rent for mint account
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    
    // Create mint account
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      })
    );

    // Initialize mint
    transaction.add(
      createInitializeMint2Instruction(
        mint,
        0, // decimals
        payer, // mint authority
        payer // freeze authority
      )
    );

    // Create associated token account
    transaction.add(
      createAssociatedTokenAccountInstruction(
        payer,
        associatedTokenAccount,
        payer,
        mint
      )
    );

    // Mint token to account
    transaction.add(
      createMintToInstruction(
        mint,
        associatedTokenAccount,
        payer,
        1 // amount
      )
    );

    // Create metadata
    ixs.push(createCreateMetadataAccountV3Instruction(
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
        // ► Name pro Token: "Pi Pyramid #<id>"
        name: nftName,                       // z.B. "Pi Pyramid #8492"
        // ► Dein gewünschtes Symbol:
        symbol: "InPi",
        // ► Dein IPFS-Metadaten-URI:
        uri: nftUri,                         // ipfs://.../<id>.json
        // ► 7% Royalties:
        sellerFeeBasisPoints: CFG.ROYALTY_BPS, // 700
        // ► Ein Creator, 100% Share:
        creators: [
          { address: creatorPk, verified: payer.equals(creatorPk), share: 100 }
        ],
        // ► Verknüpfe mit deiner bestehenden Collection (wird gleich danach verifiziert):
        collection: { key: collectionMint, verified: false },
        // ► Keine Uses-Mechanik:
        uses: null
      },
      // ► Token bleibt veränderbar (z.B. für spätere Fixes):
      isMutable: true,
      // ► Für ITEMS immer null lassen (nur die Collection selbst ist „sized/unsized“):
      collectionDetails: null
    }
  }
));

    // Create master edition
    const masterEditionPda = findMasterEditionPda(mint);
    transaction.add(
      createCreateMasterEditionV3Instruction(
        {
          edition: masterEditionPda,
          mint: mint,
          updateAuthority: payer,
          mintAuthority: payer,
          payer: payer,
          metadata: metadataPda,
        },
        {
          createMasterEditionArgs: {
            maxSupply: 0
          }
        }
      )
    );

    // Verify collection if self
    if (isSelf) {
      transaction.add(
        createVerifySizedCollectionItemInstruction({
          collection: collectionMint,
          collectionAuthority: payer,
          collectionMasterEditionAccount: findMasterEditionPda(collectionMint),
          collectionMetadataAccount: findMetadataPda(collectionMint),
          collectionMint: collectionMint,
          metadata: metadataPda,
          payer: payer,
        })
      );
    }

    // Get latest blockhash and set fee payer
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payer;

    // Sign and send transaction
    setStatus("Bitte im Wallet signieren…", "info");
    
    // Sign transaction with wallet
    const signed = await wallet.signTransaction(transaction);
    
    // Sign with mint keypair
    signed.partialSign(mintKeypair);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(signed.serialize());
    
    // Confirm transaction
    await connection.confirmTransaction(signature, 'confirmed');
    
    log("sent", { signature });
    const link = `https://solscan.io/tx/${signature}`;
    setStatus(`✅ Mint erfolgreich! <a class="link" href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>`, "ok");

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