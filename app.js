/* ===========================================
   InPi Mint UI – app.js (ES Module)
   =========================================== */

/* ==================== BUILD-ID ==================== */
const BUILD_TAG = "mint-v28";

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

  // >>> Schlüssel & Collection <<<
  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  COLLECTION_MINT: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
  MINT_FEE_SOL: 0.02,

  ROYALTY_BPS: 700,
  MAX_INDEX: 9999,

  // IPFS-CIDs
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",
  MP4_BASE_CID:  "",

  // Collection.json (Fallback-CID)
  COLLECTION_JSON_CID: "bafkreigbjzbd4nba6yzkdvwhmkj4g3poglujachjxqznbyqfn55anlbcua",

  GATEWAYS: [
    "https://ipfs.io/ipfs",
    "https://ipfs.inpinity.online/ipfs",
    "https://cloudflare-ipfs.com/ipfs"
  ],

  // für /vendor und /mints
  API_BASES: [
    "https://api.inpinity.online",
    "https://inpi-proxy-nft.s-plat.workers.dev"
  ]
};

/* === Mini-Config-Check === */
(function assertConfig(){
  const b58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!b58.test(CFG.CREATOR)) throw new Error("CFG.CREATOR ist keine Base58-Adresse.");
  if (!b58.test(CFG.COLLECTION_MINT)) throw new Error("CFG.COLLECTION_MINT ist keine Base58 Mint-Adresse.");
})();

/* ==================== SOLANA IMPORTS (ESM) ==================== */
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
  createSetAuthorityInstruction,
  AuthorityType,
} from "https://esm.sh/@solana/spl-token@0.4.9";

/* ==================== METAPLEX TOKEN METADATA (ESM v2.x) ==================== */
let TM = null;
let TOKEN_METADATA_PROGRAM_ID = null;
const FALLBACK_TM_PID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/* ---- helpers ---- */
function getPath(obj, path) { return path.split(".").reduce((o,k)=>o?.[k], obj); }
function pickFrom(mod, paths, kind="function") {
  for (const p of paths) {
    const v = getPath(mod, p);
    if ((kind==="function" && typeof v==="function") || (kind==="object" && v && typeof v==="object")) return v;
  }
  return null;
}

async function loadTM() {
  // Nur klassische Web3-API (v2.x) – keine UMI 3.x laden!
  const sources = [
    "https://esm.sh/@metaplex-foundation/mpl-token-metadata@2.10.6?target=es2020&bundle",
    "https://esm.sh/@metaplex-foundation/mpl-token-metadata@2.9.1?target=es2020&bundle",
    "https://esm.sh/@metaplex-foundation/mpl-token-metadata@2.7.0?target=es2020&bundle",
  ];
  let lastErr = null;
  for (const url of sources) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      TM = (mod && typeof mod.default === "object") ? mod.default : mod;

      const pidRaw =
         TM?.PROGRAM_ID
      || TM?.constants?.PROGRAM_ID
      || TM?.programId
      || TM?.TOKEN_METADATA_PROGRAM_ID
      || FALLBACK_TM_PID;

      TOKEN_METADATA_PROGRAM_ID = new PublicKey(
        typeof pidRaw?.toString === "function" ? pidRaw.toString() : String(pidRaw)
      );

      console.log("[vendor] mpl-token-metadata ready (ESM v2.x)", {
        programId: TOKEN_METADATA_PROGRAM_ID.toString(),
        src: url
      });
      return TM;
    } catch (e) {
      lastErr = e;
      console.warn("[vendor] ESM load failed:", url, String(e?.message || e));
    }
  }
  throw lastErr || new Error("mpl-token-metadata konnte nicht geladen werden (ESM v2.x)");
}
async function ensureTM() {
  if (!TM || !TOKEN_METADATA_PROGRAM_ID) await loadTM();
  return TM;
}
function getTokenMetadataProgramId() {
  if (!TOKEN_METADATA_PROGRAM_ID) {
    throw new Error("Metaplex Program-ID noch nicht initialisiert – ensureTM() zuerst aufrufen");
  }
  return TOKEN_METADATA_PROGRAM_ID;
}

/* ---- Thin wrappers (v2-API) ---- */
function tmCreateMetadataInstr(accounts, dataV2Like) {
  const v3 = TM.createCreateMetadataAccountV3Instruction
          || TM.instructions?.createCreateMetadataAccountV3Instruction;
  const v2 = TM.createCreateMetadataAccountV2Instruction
          || TM.instructions?.createCreateMetadataAccountV2Instruction;

  if (v3) {
    const args = { createMetadataAccountArgsV3: { data: dataV2Like, isMutable: true, collectionDetails: null } };
    return v3(accounts, args);
  }
  if (v2) {
    const args = { createMetadataAccountArgsV2: { data: dataV2Like, isMutable: true } };
    return v2(accounts, args);
  }
  throw new Error("mpl-token-metadata: CreateMetadata (v2/v3) nicht verfügbar");
}

function tmMasterEditionV3Instr(accounts, args) {
  const fn = TM.createCreateMasterEditionV3Instruction
          || TM.instructions?.createCreateMasterEditionV3Instruction;
  if (!fn) throw new Error("mpl-token-metadata: CreateMasterEditionV3 nicht verfügbar");
  return fn(accounts, args);
}

function tmVerifyCollectionInstr(obj) {
  const fn = TM.createSetAndVerifyCollectionInstruction
          || TM.instructions?.createSetAndVerifyCollectionInstruction
          || TM.createVerifyCollectionInstruction
          || TM.instructions?.createVerifyCollectionInstruction;
  return fn ? fn(obj) : null;
}

function tmUpdateMetadataV2Instr(accounts, args) {
  const fn = TM.createUpdateMetadataAccountV2Instruction
          || TM.instructions?.createUpdateMetadataAccountV2Instruction;
  if (!fn) throw new Error("mpl-token-metadata: UpdateMetadataAccountV2 nicht verfügbar");
  return fn(accounts, { updateMetadataAccountArgsV2: args });
}

function tmDeserializeMetadata(data) {
  const Meta = TM.Metadata || TM.accounts?.Metadata;
  if (Meta?.deserialize)   return Meta.deserialize(data)[0];
  if (Meta?.fromAccountInfo) return Meta.fromAccountInfo({ data })[0];
  throw new Error("mpl-token-metadata: Metadata.deserialize nicht verfügbar");
}

/* ========== PDAs (mit Guard) ========== */
const te = new TextEncoder();
const findMetadataPda = (mint) => {
  const PID = getTokenMetadataProgramId();
  return PublicKey.findProgramAddressSync(
    [te.encode("metadata"), PID.toBuffer(), mint.toBuffer()],
    PID
  )[0];
};
const findMasterEditionPda = (mint) => {
  const PID = getTokenMetadataProgramId();
  return PublicKey.findProgramAddressSync(
    [te.encode("metadata"), PID.toBuffer(), mint.toBuffer(), te.encode("edition")],
    PID
  )[0];
};

/* ==================== FETCH-REWRITE (mainnet-beta → eigener RPC) ==================== */
(function(){
  const MAINNET = /https:\/\/api\.mainnet-beta\.solana\.com\/?$/i;
  const TARGET  = CFG.RPCS[0];
  const _fetch  = window.fetch.bind(window);
  window.fetch = (input, init)=>{
    try {
      const url = typeof input==="string" ? input : (input?.url||"");
      if (MAINNET.test(url)) {
        console.warn("[rewrite] mainnet-beta →", TARGET);
        return _fetch(TARGET, init);
      }
    } catch {}
    return _fetch(input, init);
  };
})();

/* ==================== HELPERS ==================== */
const $ = (id)=>document.getElementById(id);
const setStatus = (t, cls="")=>{
  const el = $("status"); if (!el) return;
  el.className = `status ${cls}`; el.innerHTML = t;
};
const logUI = (msg,obj)=>{
  const el=$("log"); if (!el) return;
  const time=new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}${obj?" "+(typeof obj==="string"?obj:JSON.stringify(obj,null,2)):""}\n`;
  el.scrollTop = el.scrollHeight;
};
const log = (msg,obj)=>logUI(msg,obj);
const setSpin = (on)=>{
  const sp=document.querySelector(".spinner");
  const lbl=document.querySelector(".btn-label");
  if (!sp||!lbl) return; sp.hidden=!on; lbl.style.opacity=on?0.75:1;
};
const toHttp = (u)=>{
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.replace("ipfs://","").replace(/^ipfs\//,"")}`;
  if (u.startsWith("/ipfs/"))  return `${CFG.GATEWAYS[0]}${u}`;
  return u;
};
const uriForId = (id)=>`ipfs://${CFG.JSON_BASE_CID}/${id}.json`;
const desiredName = (id) => `Pi Pyramid #${id}`;

/* ---- IPFS helpers for collection.json fallback ---- */
function ipfsToHttp(u) {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return `${CFG.GATEWAYS[0]}/${u.slice("ipfs://".length).replace(/^ipfs\//,"")}`;
  if (u.startsWith("/ipfs/"))   return `${CFG.GATEWAYS[0]}${u}`;
  return u;
}
function collectionCidHttpCandidates() {
  const path = `${CFG.COLLECTION_JSON_CID}`;
  return [
    ...CFG.GATEWAYS.map(g => `${g}/${path}`),
    ...CFG.GATEWAYS.map(g => `${g}/${path}/collection.json`)
  ];
}
async function fetchJsonMaybe(uri) {
  try {
    if (!uri) return null;
    const u = (uri.startsWith("ipfs://") || uri.startsWith("/ipfs/")) ? ipfsToHttp(uri) : uri;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json().catch(()=>null);
  } catch { return null; }
}

/* ==================== STATE ==================== */
let connection=null, phantom=null, originalBtnText="";
let claimedSet=new Set(), availableIds=[];
let inFlight=false, previewReady=false;

/* ==================== UX Helpers ==================== */
function applyMintButtonState(){
  const btn=$("mintBtn"); if (!btn) return;
  const ok=!!phantom?.publicKey && previewReady;
  btn.disabled=!ok;
}

/* ==================== REGISTRY ==================== */
async function recordMint(id, mint58, wallet58, signature) {
  const payload = JSON.stringify({
    id,
    mint: mint58,
    wallet: wallet58,
    sig: signature,
    collection: CFG.COLLECTION_MINT,
    name: desiredName(id),
    uri: uriForId(id)
  });
  const heads = { "content-type": "application/json" };
  for (const base of CFG.API_BASES) {
    try {
      const r = await fetch(`${base}/mints`, { method: "POST", headers: heads, body: payload });
      if (r.ok) { log("mint recorded", { base, id, mint58, wallet58 }); return true; }
      log("mint record failed", { base, status: r.status });
    } catch (e) { log("mint record error", { base, err: String(e?.message||e) }); }
  }
  return false;
}
async function fetchMyMints(wallet58, limit=10) {
  for (const base of CFG.API_BASES) {
    try {
      const url = new URL(`${base}/mints/by-wallet`);
      url.searchParams.set("wallet", wallet58);
      url.searchParams.set("limit", String(limit));
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
  }
  return { items: [] };
}

/* ==================== RPC via Worker ==================== */
async function pickRpcEndpoint(){
  for (const url of CFG.RPCS){
    try{
      const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getLatestBlockhash",params:[{commitment:"processed"}]})});
      if (r.ok) return url;
    }catch{}
  }
  return "https://api.mainnet-beta.solana.com";
}
async function ensureConnection(){
  if (connection) return connection;
  const chosen=await pickRpcEndpoint();
  connection=new Connection(chosen,"confirmed");
  log("RPC ready",{rpc:chosen,build:BUILD_TAG});
  return connection;
}

/* ==================== Donation UI ==================== */
function getSelectedDonation(){
  const sel=document.querySelector('#donationOptions input[name="donation"]:checked');
  if (!sel) return 0;
  let v = sel.value==='custom' ? parseFloat($("customDonationInput").value) : parseFloat(sel.value);
  v = isNaN(v)?0:v; return Math.max(0,v);
}
function updateEstimatedCost(){
  const total = CFG.MINT_FEE_SOL + getSelectedDonation();
  const lbl=$("costLabel"); if (lbl) lbl.textContent=`≈ ${total.toFixed(3)} SOL`;
}

/* ==================== WALLET (Phantom) ==================== */
function getPhantom() {
  return (window.phantom && window.phantom.solana) ? window.phantom.solana : window.solana;
}
async function connectPhantom(){
  try{
    const w=getPhantom();
    if (!w?.isPhantom) throw new Error("Phantom nicht gefunden. Bitte Phantom installieren.");
    const resp=await w.connect(); // Popup
    phantom=w;

    await ensureConnection();

    const pk58=resp.publicKey.toString();
    $("walletLabel").textContent=`${pk58.slice(0,4)}…${pk58.slice(-4)}`;
    $("connectBtn").textContent="Phantom verbunden";
    applyMintButtonState();
    setStatus(`Wallet verbunden (${BUILD_TAG}). Bereit zum Minten.`,"ok");
    log("Wallet connected",{address:pk58});

    await updateBalance();

    phantom.on?.("disconnect", ()=>{
      $("walletLabel").textContent="nicht verbunden";
      $("connectBtn").textContent="Mit Phantom verbinden";
      $("mintBtn").disabled=true;
      setStatus("Wallet getrennt. Bitte erneut verbinden.","warn");
    });
    phantom.on?.("accountChanged", updateBalance);
  }catch(e){ handleError("Wallet-Verbindung fehlgeschlagen:", e); }
}
async function updateBalance(){
  if (!phantom?.publicKey) return;
  try{
    const conn=await ensureConnection();
    const lam=await conn.getBalance(new PublicKey(phantom.publicKey.toString()));
    const sol=lam/1e9; $("balanceLabel").textContent=`${sol.toFixed(4)} SOL`;
  }catch(e){
    $("balanceLabel").textContent="—";
    log("Balance nicht abrufbar (RPC).", String(e?.message||e));
  }
}

/* ==================== CLAIMS ==================== */
async function fetchClaims(){
  for (const url of CFG.CLAIMS){
    try{
      const r=await fetch(url,{cache:"no-store"});
      if (!r.ok) continue;
      const j=await r.json().catch(()=>null);
      if (!j) continue;
      if (Array.isArray(j)) return j;
      if (Array.isArray(j.claimed)) return j.claimed;
    }catch{}
  }
  return [];
}
async function markClaimed(i){
  for (const url of CFG.CLAIMS){
    try{
      const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({index:i})});
      if (r.status===200){ log("claim stored",{index:i}); return; }
      if (r.status===409){ log("claim already existed",{index:i}); return; }
    }catch{}
  }
}
function recomputeAvailable(){
  availableIds=[];
  for (let i=0;i<=CFG.MAX_INDEX;i++) if (!claimedSet.has(i)) availableIds.push(i);
  const el=$("freeCounter"); if (el) el.textContent=`${availableIds.length} / ${CFG.MAX_INDEX+1}`;
}
async function bootstrapClaims(){
  const arr=await fetchClaims(); claimedSet=new Set(arr); recomputeAvailable();
}

/* === SEQUENZ: nächste freie ID === */
function pickNextSequentialFreeId(){ return availableIds.length ? availableIds[0] : 0; }
async function setNextFreeId(){
  const inp=$("tokenId"); if (!inp) return;
  setStatus("Suche nächste freie ID...","info");
  const id=pickNextSequentialFreeId();
  inp.value=String(id);
  await updatePreview();
}

/* ==================== IPFS Helpers ==================== */
const fetchWithTimeout = (u, ms = 6000) => Promise.race([
  fetch(u, { cache: "no-store" }),
  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
]);
async function fetchFirst(metaUrls) {
  for (const u of metaUrls) {
    try {
      const r = await fetchWithTimeout(u);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) {
          log("meta ok", { url: u });
          return j;
        }
      }
      log("meta miss", { url: u, status: (r && r.status) || "n/a" });
    } catch (e) {
      log("meta err", { url: u, err: String(e?.message || e) });
    }
  }
  throw new Error("Alle Gateways fehlgeschlagen");
}

/* ==================== PREVIEW ==================== */
const previewCache = {};
let _prevTimer = null, _prevTs = 0;

async function updatePreview() {
  const clampId = (v) => { v = Number(v) || 0; return Math.max(0, Math.min(CFG.MAX_INDEX, v)); };
  const id = clampId($("tokenId").value || 0);
  $("tokenId").value = String(id);

  $("previewUri").textContent = uriForId(id);
  $("uriStatus").textContent = "prüfe URI …";
  previewReady = false; applyMintButtonState();

  const media = $("mediaBox"); const metaBox = $("metaBox");
  media.innerHTML = '<span class="muted">Lade Vorschau…</span>'; metaBox.innerHTML = "";

  if (previewCache[id]) {
    renderPreview(id, previewCache[id]);
    previewReady = true; applyMintButtonState();
    return;
  }

  const urls = CFG.GATEWAYS.map(g => `${g}/${CFG.JSON_BASE_CID}/${id}.json`);
  log("meta try", { urls });

  let meta = null;
  try { meta = await fetchFirst(urls); } catch (e) { log("Alle Gateways fehlgeschlagen für ID " + id, e); }

  if (meta && !meta.image && CFG.PNG_BASE_CID)         meta.image = `ipfs://${CFG.PNG_BASE_CID}/${id}.png`;
  if (meta && !meta.animation_url && CFG.MP4_BASE_CID) meta.animation_url = `ipfs://${CFG.MP4_BASE_CID}/${id}.mp4`;

  if (!meta) {
    $("uriStatus").textContent = "⚠️ Metadaten nicht gefunden";
    media.textContent = "—"; previewReady = false; applyMintButtonState(); return;
  }

  previewCache[id] = meta;
  renderPreview(id, meta);
  previewReady = true; applyMintButtonState();
}
function renderPreview(id, meta){
  $("uriStatus").textContent="✅ Metadaten geladen";
  const errs=[];
  if (!meta.name) errs.push("Name fehlt");
  if (!meta.image && !meta.animation_url) errs.push("Medien fehlen");
  if (meta.seller_fee_basis_points!==undefined && meta.seller_fee_basis_points!==CFG.ROYALTY_BPS) {
    errs.push(`Royalties nicht ${CFG.ROYALTY_BPS/100}%`);
  }
  if (errs.length) $("uriStatus").textContent += ` ⚠️ ${errs.join(", ")}`;

  const media=$("mediaBox"); const metaUrl=toHttp(meta.animation_url||meta.image);
  if (meta.animation_url) media.innerHTML=`<video src="${metaUrl}" controls autoplay loop muted playsinline></video>`;
  else                    media.innerHTML=`<img src="${metaUrl}" alt="Preview ${id}" />`;

  const metaBox=$("metaBox");
  const dl=document.createElement("dl");
  const add=(k,v)=>{const dt=document.createElement("dt");dt.textContent=k; const dd=document.createElement("dd");dd.textContent=v; dl.append(dt,dd);};
  add("Name", meta.name||desiredName(id));
  if (meta.description) add("Beschreibung", meta.description);
  if (Array.isArray(meta.attributes)) add("Attribute", meta.attributes.map(a=>`${a.trait_type||"Trait"}: ${a.value}`).join(" · "));
  metaBox.innerHTML=""; metaBox.appendChild(dl);
}

/* ==================== Collection-Preflight (Logs) ==================== */
async function fetchAccountInfo(conn, pubkey){
  try{ return await conn.getAccountInfo(pubkey,"confirmed"); }catch{ return null; }
}
async function collectionPreflight(conn, payerPk, collectionMintPk){
  await ensureTM();

  const mdPda = findMetadataPda(collectionMintPk);
  const edPda = findMasterEditionPda(collectionMintPk);

  log("collection: start", {
    collectionMint: collectionMintPk.toBase58(),
    metadataPda: mdPda.toBase58(),
    masterEditionPda: edPda.toBase58()
  });

  const [mdAcc, edAcc] = await Promise.all([
    fetchAccountInfo(conn, mdPda),
    fetchAccountInfo(conn, edPda),
  ]);

  if (!mdAcc) throw new Error("Collection-Preflight: Metadata PDA nicht gefunden");
  if (!edAcc) throw new Error("Collection-Preflight: MasterEdition PDA nicht gefunden");

  let md;
  try { md = tmDeserializeMetadata(mdAcc.data); } catch {}
  const name  = md?.data?.name?.trim?.() || "(unbekannt)";
  const sym   = md?.data?.symbol?.trim?.() || "";
  const uri   = md?.data?.uri?.trim?.() || "";

  log("collection: ok", { name, symbol: sym, uri });

  // ---- zusätzliche Einsicht: collection.json laden (on-chain oder Fallback-CID) ----
  let cj = await fetchJsonMaybe(uri);
  if (!cj && CFG.COLLECTION_JSON_CID) {
    for (const cand of collectionCidHttpCandidates()) {
      try {
        const r = await fetch(cand, { cache: "no-store" });
        if (r.ok) cj = await r.json().catch(()=>null);
      } catch {}
      if (cj) { console.log("[collection json fallback]", { url: cand, name: cj.name||"", symbol: cj.symbol||"" }); break; }
    }
  }
  if (cj) console.log("[collection json]", { name: cj.name||"", symbol: cj.symbol||"", uri: uri || `(cid:${CFG.COLLECTION_JSON_CID})` });
  else     console.warn("[collection json] nicht ladbar – weder on-chain URI noch CID-Fallback ergab verwertbare JSON.");

  return { mdPda, edPda, name, symbol: sym, uri };
}
async function softAssertCollection(conn, collectionMintPk){
  try {
    const payerPk = phantom?.publicKey || null;
    await collectionPreflight(conn, payerPk, collectionMintPk);
    return true;
  } catch (e) {
    log("collection: warn", String(e?.message||e));
    return false;
  }
}

/* ==================== Priority Fee ==================== */
async function setSmartPriority(tx, conn){
  try{
    const res=await conn.getRecentPrioritizationFees?.({percentiles:[50,75,90]});
    const fallback=1000;
    const fee=(Array.isArray(res)&&res.length)?(res[0]?.prioritizationFee??fallback):(res?.prioritizationFee??fallback);
    const microLamports=Math.max(500, Math.min(5000, Math.round(fee*1.1)));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:220000}));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports}));
  }catch{
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:200000}));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1500}));
  }
}

/* ==================== Sign & Send ==================== */
async function signSendWithRetry(conn, tx, wallet, extraSigner){
  if (extraSigner) tx.partialSign(extraSigner);
  for (let attempt=0; attempt<3; attempt++){
    const {blockhash,lastValidBlockHeight}=await conn.getLatestBlockhash();
    tx.recentBlockhash=blockhash; tx.feePayer=wallet.publicKey;
    const signed=await wallet.signTransaction(tx);

    const sim=await conn.simulateTransaction(signed,{sigVerify:false,commitment:"processed"});
    if (sim?.value?.logs) log("simulate logs", sim.value.logs);
    if (sim?.value?.err) throw new Error("Simulation fehlgeschlagen. Prüfe Collection-Authority/PDAs/URI.");

    try{
      const sig=await conn.sendRawTransaction(signed.serialize(),{skipPreflight:false});
      await conn.confirmTransaction({signature:sig,blockhash,lastValidBlockHeight},"confirmed");
      return sig;
    }catch(e){
      const msg=e?.message||"";
      if (/BlockhashNotFound|expired/i.test(msg)){ log("Blockhash abgelaufen – retry",{attempt:attempt+1}); continue; }
      throw e;
    }
  }
  throw new Error("Blockhash wiederholt abgelaufen. Bitte erneut versuchen.");
}

/* ==================== REPAIR / helpers ==================== */
async function findExistingMintByIdForCreator(conn, id){
  await ensureTM();
  const owner = new PublicKey(CFG.CREATOR);
  const parsed = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
  const candidates = parsed.value
    .map(v => v.account.data.parsed.info)
    .filter(info => info?.tokenAmount?.decimals===0 && info.tokenAmount.amount==='1')
    .map(info => info.mint);

  const wantName = desiredName(id);
  const wantUri  = uriForId(id);

  for (const mintStr of candidates){
    try{
      const mint = new PublicKey(mintStr);
      const metaPda = findMetadataPda(mint);
      const acc = await conn.getAccountInfo(metaPda, "confirmed");
      if (!acc) continue;
      const md = tmDeserializeMetadata(acc.data);

      const gotName = (md.data?.name || "").trim();
      const gotUri  = (md.data?.uri  || "").trim();

      if (gotUri===wantUri || gotName===wantName) return mint;
    }catch{}
  }
  return null;
}
function buildDesiredDataV2(id){
  return {
    name:  desiredName(id),
    symbol:"inpi",
    uri:   uriForId(id),
    sellerFeeBasisPoints: CFG.ROYALTY_BPS,
    creators:[{ address:new PublicKey(CFG.CREATOR), verified:true, share:100 }],
    collection:{ key:new PublicKey(CFG.COLLECTION_MINT), verified:false },
    uses:null
  };
}
async function ensureMetadataAndCollection(conn, payer, mint, id){
  await ensureTM();
  const tx = new Transaction();
  await setSmartPriority(tx, conn);

  const metadataPda=findMetadataPda(mint);
  const collMdPda  =findMetadataPda(new PublicKey(CFG.COLLECTION_MINT));
  const collEdPda  =findMasterEditionPda(new PublicKey(CFG.COLLECTION_MINT));

  const acc = await conn.getAccountInfo(metadataPda, "confirmed");
  if (!acc) throw new Error("Metadata PDA nicht gefunden");

  const md = tmDeserializeMetadata(acc.data);

  const want = buildDesiredDataV2(id);
  const needUpdate =
      (md.data?.name||"").trim()  !== want.name
   || (md.data?.symbol||"").trim()!== want.symbol
   || (md.data?.uri||"").trim()   !== want.uri
   || (md.data?.sellerFeeBasisPoints??0)!== want.sellerFeeBasisPoints
   || !md.data?.creators?.[0]?.address?.equals?.(new PublicKey(CFG.CREATOR))
   || (md.data?.creators?.[0]?.share ?? 0)!==100;

  if (needUpdate){
    const instr = tmUpdateMetadataV2Instr(
      { metadata: metadataPda, updateAuthority: payer },
      {
        data: want,
        updateAuthority: payer,
        primarySaleHappened: md.primarySaleHappened ?? null,
        isMutable: md.isMutable ?? true
      }
    );
    tx.add(instr);
  }

  const verifyInstr = tmVerifyCollectionInstr({
    metadata: metadataPda,
    collectionAuthority: payer,
    payer,
    updateAuthority: payer,
    collectionMint: new PublicKey(CFG.COLLECTION_MINT),
    collection: collMdPda,
    collectionMasterEditionAccount: collEdPda
  });
  if (verifyInstr) tx.add(verifyInstr);

  const sig=await signSendWithRetry(conn, tx, phantom);
  log("repair ok",{signature:sig, mint: mint.toBase58()});
  setStatus(
    `🔧 Repair/Verify erfolgreich. <a class="link" href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">Transaktion ansehen</a>`,
    "ok"
  );
}

/* ==================== MINT ==================== */
async function doMint(){
  if (inFlight) return; inFlight=true;
  try{
    const btn=$("mintBtn"); btn.disabled=true;
    const lblEl=btn?.querySelector(".btn-label"); if (lblEl){ originalBtnText=lblEl.textContent; lblEl.textContent="Verarbeite..."; }
    setSpin(true);

    if (!phantom?.publicKey) throw new Error("Wallet nicht verbunden");
    const idRaw=Number($("tokenId").value||0);
    const id=Math.max(0, Math.min(CFG.MAX_INDEX, Number.isFinite(idRaw)?Math.floor(idRaw):0));
    if (!Number.isInteger(id) || id<0 || id>CFG.MAX_INDEX) throw new Error(`Ungültige ID (0–${CFG.MAX_INDEX})`);
    if (!previewReady) throw new Error("Metadaten nicht geladen. Bitte kurz warten oder ID prüfen.");

    const donation=getSelectedDonation();
    const donationLamports=Math.round(donation*1e9);

    const conn=await ensureConnection();
    await ensureTM();
    const wallet=phantom; const payer=wallet.publicKey;
    const collectionMint=new PublicKey(CFG.COLLECTION_MINT);
    const creatorPk=new PublicKey(CFG.CREATOR);
    const isSelf=payer.equals(creatorPk);

    /* === FALL A: bereits gemintet → Auto-Repair für Creator === */
    if (claimedSet.has(id)){
      if (!isSelf) throw new Error(`ID #${id} ist bereits gemintet.`);
      setStatus(`ID #${id} existiert bereits – prüfe & repariere (Verify/Metadata)…`,"info");
      log("repair-start",{id});

      const existingMint = await findExistingMintByIdForCreator(conn, id);
      if (!existingMint) throw new Error("Bestehenden Mint nicht gefunden. Liegt das NFT noch in der Creator-Wallet?");
      await ensureMetadataAndCollection(conn, payer, existingMint, id);

      await setNextFreeId(); await updateBalance();
      return;
    }

    /* === FALL B: Normaler Mint === */
    await softAssertCollection(conn, collectionMint);

    const nftName=desiredName(id); const nftUri=uriForId(id);

    const tx=new Transaction();
    await setSmartPriority(tx, conn);

    // Creator-Fee + optionale Donation (nur wenn nicht Creator selbst)
    const feeLamports=isSelf?0:Math.round(CFG.MINT_FEE_SOL*1e9);
    if (feeLamports>0) tx.add(SystemProgram.transfer({fromPubkey:payer,toPubkey:creatorPk,lamports:feeLamports}));
    if (donationLamports>=1000) tx.add(SystemProgram.transfer({fromPubkey:payer,toPubkey:creatorPk,lamports:donationLamports}));

    // 1) Mint Account + InitializeMint (Authority = payer, temporär)
    const mintKeypair=Keypair.generate(); const mint=mintKeypair.publicKey;

    const rentLamports=await getMinimumBalanceForRentExemptMint(conn);
    tx.add(SystemProgram.createAccount({fromPubkey:payer,newAccountPubkey:mint,space:MINT_SIZE,lamports:rentLamports,programId:TOKEN_PROGRAM_ID}));
    tx.add(createInitializeMint2Instruction(mint,0,payer,payer));

    // PDAs
    const metadataPda=findMetadataPda(mint);
    const masterEditionPda=findMasterEditionPda(mint);

    // 2) Create Metadata
    const cmInstr = tmCreateMetadataInstr(
      { metadata:metadataPda, mint, mintAuthority:payer, payer, updateAuthority:payer },
      {
        name:nftName, symbol:"inpi", uri:nftUri, sellerFeeBasisPoints:CFG.ROYALTY_BPS,
        creators:[{ address:creatorPk, verified:isSelf, share:100 }],
        collection:{ key:collectionMint, verified:false },
        uses:null
      }
    );
    tx.add(cmInstr);

    // 3) Create Master Edition V3
    const meInstr = tmMasterEditionV3Instr(
      { edition:masterEditionPda, mint, updateAuthority:payer, mintAuthority:payer, payer, metadata:metadataPda },
      { createMasterEditionArgs:{ maxSupply:0 } }
    );
    tx.add(meInstr);

    // 4) ATA anlegen + 1 Token minten
    const ata=await getAssociatedTokenAddress(mint,payer,false,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);
    const ataInfo=await conn.getAccountInfo(ata);
    if (!ataInfo) tx.add(createAssociatedTokenAccountInstruction(payer,ata,payer,mint));
    tx.add(createMintToInstruction(mint,ata,payer,1));

    // 5) SetAuthority → MasterEdition (mintTokens + freezeAccount)
    tx.add(createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens,    masterEditionPda, []));
    tx.add(createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, masterEditionPda, []));

    // 6) Verify Collection
    const collMdPda  = findMetadataPda(collectionMint);
    const collEdPda  = findMasterEditionPda(collectionMint);
    const verifyInstr = tmVerifyCollectionInstr({
      metadata: metadataPda,
      collectionAuthority: payer,
      payer,
      updateAuthority: payer,
      collectionMint: collectionMint,
      collection: collMdPda,
      collectionMasterEditionAccount: collEdPda
    });
    if (verifyInstr) tx.add(verifyInstr);

    // 7) Bei Fremd-Mint: Update-Authority → CREATOR
    if (!isSelf){
      const updInstr = tmUpdateMetadataV2Instr(
        { metadata: metadataPda, updateAuthority: payer },
        { data: null, updateAuthority: creatorPk, primarySaleHappened: null, isMutable: true }
      );
      tx.add(updInstr);
    }

    setStatus("Bitte im Wallet signieren…","info");
    const signature=await signSendWithRetry(conn, tx, wallet, mintKeypair);

    log("sent",{signature});
    const link=`https://solscan.io/tx/${signature}`;
    setStatus(
      `✅ Mint erfolgreich! <a class="link" href="${link}" target="_blank" rel="noopener">Transaktion ansehen</a>
       <button id="copyTx" class="btn-mini">Copy Tx</button>`,
      "ok"
    );
    setTimeout(()=>{ const c=document.getElementById("copyTx"); if (c) c.onclick=()=>navigator.clipboard.writeText(signature); },0);

    // Registry
    try { await recordMint(id, mint.toBase58(), payer.toBase58(), signature); } catch {}

    await markClaimed(id); claimedSet.add(id); recomputeAvailable();
    await setNextFreeId(); await updateBalance();

  }catch(e){ handleError("Mint/Repair fehlgeschlagen:", e);
  }finally{
    setSpin(false);
    const btn=$("mintBtn");
    if (btn){ btn.disabled=false; const lbl=btn.querySelector(".btn-label"); if (lbl&&originalBtnText) lbl.textContent=originalBtnText; }
    inFlight=false;
  }
}

/* ==================== ERROR HANDLING ==================== */
function userFriendly(msg){
  if (/user rejected|reject|denied|Abgelehnt/i.test(msg)) return "Signierung abgebrochen";
  if (/insufficient funds|insufficient|0x7d0/i.test(msg)) return "Unzureichendes SOL-Guthaben.";
  if (/BlockhashNotFound|expired/i.test(msg)) return "Netzwerk langsam. Bitte erneut versuchen.";
  if (/custom program error: 0x1/i.test(msg)) return "PDAs/Metaplex-Accounts fehlen oder falsche Authority.";
  if (/invalid owner|0x1771/i.test(msg)) return "Token-Program/Owner-Mismatch. Bitte Seite neu laden.";
  return msg;
}
function handleError(context,e){
  console.error(context,e);
  const msg=e?.message||String(e);
  const user=userFriendly(msg);
  setStatus(`❌ ${user}`,"err");
  log(`${context} ${msg}`);
}

/* ==================== OPTIONAL: "Meine Mints" UI ==================== */
async function onShowMyMints() {
  try{
    if (!phantom?.publicKey) return setStatus("Bitte zuerst Wallet verbinden.","warn");
    const wallet58 = phantom.publicKey.toBase58();
    const res = await fetchMyMints(wallet58, 10);
    const list = Array.isArray(res?.items) ? res.items : [];
    const box = $("myMintsBox");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="muted">Keine Einträge gefunden.</div>`;
      return;
    }
    box.innerHTML = "";
    list.forEach(row => {
      const el = document.createElement("div");
      el.className = "mint-row";
      const link = `https://solscan.io/tx/${row.sig || row.signature || ""}`;
      const mint = row.mint || "";
      const id = row.id ?? "—";
      el.innerHTML = `
        <div><strong>#${id}</strong> – ${mint.slice(0,4)}…${mint.slice(-4)}</div>
        <div><a class="link" href="${link}" target="_blank" rel="noopener">Tx ansehen</a></div>
      `;
      box.appendChild(el);
    });
  }catch(e){ log("myMints error", String(e?.message||e)); }
}

/* ==================== UI WIRING ==================== */
function wireUI(){
  $("connectBtn")?.addEventListener("click", connectPhantom);
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setNextFreeId);

  // Debounce Preview
  $("tokenId")?.addEventListener("input", ()=>{
    const now = Date.now();
    if (_prevTimer) clearTimeout(_prevTimer);
    _prevTimer = setTimeout(()=>updatePreview(), (now - _prevTs) < 250 ? 250 : 0);
    _prevTs = now;
  });

  $("myMintsBtn")?.addEventListener("click", onShowMyMints);

  // Donation-Pills
  const pills = Array.from(document.querySelectorAll('#donationOptions .pill'));
  const customContainer = $("customDonationContainer");
  const customInput = $("customDonationInput");
  const applyDonationSelection = () => {
    pills.forEach(pill => pill.classList.remove("active"));
    const checked = document.querySelector('#donationOptions input[name="donation"]:checked');
    if (!checked) return;
    const pill = checked.closest(".pill"); if (pill) pill.classList.add("active");
    if (customContainer) customContainer.style.display = (checked.value === "custom") ? "inline-flex" : "none";
    updateEstimatedCost();
  };
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      const radio = pill.querySelector('input[name="donation"]'); if (!radio) return;
      radio.checked = true;
      applyDonationSelection();
    });
  });
  document.querySelectorAll('#donationOptions input[name="donation"]').forEach(radio=>{
    radio.addEventListener("change", applyDonationSelection);
  });
  customInput?.addEventListener("input", updateEstimatedCost);

  applyDonationSelection(); updateEstimatedCost();

  try{
    const ua=navigator.userAgent||"";
    if (/Instagram|FBAN|FBAV|Line\/|TikTok/i.test(ua)) setStatus("⚠️ Öffne diese Seite in einem externen Browser (Safari/Chrome) für Wallet-Popups.","warn");
  }catch{}
}

/* ==================== START ==================== */
document.addEventListener("DOMContentLoaded", async ()=>{
  log("System boot",{build:BUILD_TAG,rpcs:CFG.RPCS, roles:{
    creator: CFG.CREATOR,
    collectionMint: CFG.COLLECTION_MINT,
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  }});
  wireUI();
  await bootstrapClaims();
  const inp=$("tokenId"); if (inp) inp.value="0";
  await setNextFreeId();
  await updatePreview();
  applyMintButtonState();

  try {
    const conn = await ensureConnection();
    await ensureTM();
    await softAssertCollection(conn, new PublicKey(CFG.COLLECTION_MINT));
  } catch (e) {
    log("collection preflight at boot failed", String(e?.message||e));
  }
});