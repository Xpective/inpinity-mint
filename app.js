/* ==================== BUILD-ID ==================== */
const BUILD_TAG = "mint-v21";

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

  // >>> Deine Schlüssel & Collection <<<
  CREATOR: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  MINT_FEE_SOL: 0.02,
  COLLECTION_MINT: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",

  ROYALTY_BPS: 700,
  MAX_INDEX: 9999,

  // IPFS-CIDs für Metadaten/Assets
  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  PNG_BASE_CID:  "bafybeicbxxwossaiogadmonclbijyvuhvtybp7lr5ltnotnqqezamubcr4",
  MP4_BASE_CID:  "",

  GATEWAYS: [
    "https://ipfs.io/ipfs",
    "https://cloudflare-ipfs.com/ipfs",
    "https://ipfs.inpinity.online/ipfs"
  ],
};

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
} from "https://esm.sh/@solana/spl-token@0.4.9";

/* ==================== METAPLEX TM v1 (ESM) ==================== */
import * as tm from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@1.13.0?target=es2020&bundle";

const {
  PROGRAM_ID: TM_PROGRAM_ID_V1,
  createCreateMetadataAccountV2Instruction,
  createCreateMasterEditionV3Instruction,
  createVerifyCollectionInstruction,
  createSetAndVerifyCollectionInstruction,
  createUpdateMetadataAccountV2Instruction, // <-- Update/Repair
  Metadata
} = tm;

/* Sanity-Check */
(function(){
  const okCreate = typeof createCreateMetadataAccountV2Instruction === "function"
                && typeof createCreateMasterEditionV3Instruction === "function";
  if (!okCreate) throw new Error("Metaplex TM v1 (ESM): Instruktions-Exporte fehlen.");
})();

/* ==================== TM PROGRAM/PDAs ==================== */
const te = new TextEncoder();
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(TM_PROGRAM_ID_V1.toString());

const findMetadataPda = (mint) =>
  PublicKey.findProgramAddressSync(
    [te.encode("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  )[0];

const findMasterEditionPda = (mint) =>
  PublicKey.findProgramAddressSync(
    [te.encode("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), te.encode("edition")],
    TOKEN_METADATA_PROGRAM_ID
  )[0];

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
const log = (msg,obj)=>{
  const el=$("log"); if (!el) return;
  const time=new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}${obj?" "+(typeof obj==="string"?obj:JSON.stringify(obj,null,2)):""}\n`;
  el.scrollTop = el.scrollHeight;
};
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
const desiredName = (id)=>`Pi Pyramid #${id}`;

/* ==================== STATE ==================== */
let connection=null, phantom=null, originalBtnText="";
let claimedSet=new Set(), availableIds=[];
let inFlight=false, previewReady=false;

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

/* ==================== UI: Donation ==================== */
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
async function connectPhantom(){
  try{
    const w=window.solana;
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

    phantom.on("disconnect", ()=>{
      $("walletLabel").textContent="nicht verbunden";
      $("connectBtn").textContent="Mit Phantom verbinden";
      $("mintBtn").disabled=true;
      setStatus("Wallet getrennt. Bitte erneut verbinden.","warn");
    });
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

/* === SEQUENZ: nächste freie ID statt Zufall === */
function pickNextSequentialFreeId(){ return availableIds.length ? availableIds[0] : 0; }
async function setNextFreeId(){
  const inp=$("tokenId"); if (!inp) return;
  setStatus("Suche nächste freie ID...","info");
  const id=pickNextSequentialFreeId();
  inp.value=String(id);
  await updatePreview();
}

/* ==================== IPFS Helpers ==================== */
const fetchWithTimeout = (u, ms=12000)=>Promise.race([
  fetch(u,{cache:"no-store"}),
  new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),ms))
]);
async function fetchFirst(metaUrls){
  return new Promise((resolve,reject)=>{
    let done=false, errors=0;
    metaUrls.forEach(u=>{
      fetchWithTimeout(u).then(r=>{
        if (done) return;
        if (r.ok){ done=true; r.json().then(resolve).catch(()=>{}); }
        else if (++errors===metaUrls.length) reject(new Error("all failed"));
      }).catch(()=>{ if (!done && ++errors===metaUrls.length) reject(new Error("all failed")); });
    });
  });
}

/* ==================== PREVIEW ==================== */
const previewCache={};
async function updatePreview(){
  const clampId=(v)=>{ v=Number(v)||0; return Math.max(0, Math.min(CFG.MAX_INDEX, v)); };
  const id = clampId($("tokenId").value||0);
  $("tokenId").value=String(id);

  $("previewUri").textContent=uriForId(id);
  $("uriStatus").textContent="prüfe URI …";
  previewReady=false; applyMintButtonState();

  const media=$("mediaBox"); const metaBox=$("metaBox");
  media.innerHTML='<span class="muted">Lade Vorschau…</span>'; metaBox.innerHTML="";

  if (previewCache[id]){ renderPreview(id, previewCache[id]); previewReady=true; applyMintButtonState(); return; }

  let meta=null;
  try{ meta=await fetchFirst(CFG.GATEWAYS.map(g=>`${g}/${CFG.JSON_BASE_CID}/${id}.json`)); }catch{}

  if (meta && !meta.image && CFG.PNG_BASE_CID)         meta.image = `ipfs://${CFG.PNG_BASE_CID}/${id}.png`;
  if (meta && !meta.animation_url && CFG.MP4_BASE_CID) meta.animation_url = `ipfs://${CFG.MP4_BASE_CID}/${id}.mp4`;

  if (!meta){
    $("uriStatus").textContent="⚠️ Metadaten nicht gefunden";
    media.textContent="—"; previewReady=false; applyMintButtonState(); return;
  }

  previewCache[id]=meta; renderPreview(id, meta);
  previewReady=true; applyMintButtonState();
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

/* ==================== Collection-Checks ==================== */
async function fetchAccountInfo(conn, pubkey){
  try{ return await conn.getAccountInfo(pubkey,"confirmed"); }catch{ return null; }
}
async function assertCanVerifyCollection(conn, payer, collectionMint){
  const collMd=findMetadataPda(collectionMint);
  const collEd=findMasterEditionPda(collectionMint);
  const [mdAcc, edAcc]=await Promise.all([ fetchAccountInfo(conn,collMd), fetchAccountInfo(conn,collEd) ]);
  if (!mdAcc || !edAcc) throw new Error("Collection-PDAs nicht gefunden. Stimmt COLLECTION_MINT?");
  if (!payer) throw new Error("Kein Payer");
}
async function softAssertCollection(conn, mint){
  try{ await assertCanVerifyCollection(conn, phantom?.publicKey, mint); }
  catch(e){ log("Warnung: Collection-Preflight skipped", e?.message||String(e)); }
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
    const signed=await wallet.signTransaction(tx); // Phantom Popup

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

/* ==================== REPAIR: bestehendes NFT suchen & fixen ==================== */
// Wir suchen in der CREATOR-Wallet nach einem NFT, dessen name/uri zu der ID passt
async function findExistingMintByIdForCreator(conn, id){
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
      const md = Metadata.deserialize(acc.data)[0];

      const gotName = (md.data?.name || "").trim();
      const gotUri  = (md.data?.uri  || "").trim();

      // Match nach URI oder exaktem Name
      if (gotUri===wantUri || gotName===wantName) return mint;
    }catch{}
  }
  return null;
}

function buildDesiredDataV2(id){
  return {
    name:  desiredName(id),
    symbol:"InPi",
    uri:   uriForId(id),
    sellerFeeBasisPoints: CFG.ROYALTY_BPS,
    creators:[{ address:new PublicKey(CFG.CREATOR), verified:true, share:100 }],
    collection:{ key:new PublicKey(CFG.COLLECTION_MINT), verified:false },
    uses:null
  };
}

async function ensureMetadataAndCollection(conn, payer, mint, id){