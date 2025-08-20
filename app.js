/* ==================== BUILD-ID ==================== */
const BUILD_TAG = "mint-v18-esm";

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

/* ==================== EVM NO-OP SHIM ==================== */
(function(){
  try {
    const w = window;
    if (!w.ethereum) w.ethereum = {};
    if (typeof w.ethereum.setExternalProvider !== "function") {
      w.ethereum.setExternalProvider = function(){};
    }
  } catch {}
})();

/* ==================== IMPORTS (ESM) ==================== */
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

import * as tm from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?target=es2020&bundle";

/* ==================== TM PROGRAM/PDAs ==================== */
const te = new TextEncoder();
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
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

/* ==================== FETCH-REWRITE ==================== */
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
async function isIdAvailable(id){
  if (claimedSet.has(id)) return false;
  const checks = CFG.GATEWAYS.map(gw =>
    fetch(`${gw}/${CFG.JSON_BASE_CID}/${id}.json`, { method:"HEAD", cache:"no-store" })
      .then(r=>r.ok).catch(()=>false)
  );
  return (await Promise.all(checks)).some(Boolean);
}
async function pickRandomFreeId(){
  if (availableIds.length===0) return 0;
  const shuffled=[...availableIds].sort(()=>Math.random()-0.5);
  for (const id of shuffled.slice(0,80)) if (await isIdAvailable(id)) return id;
  return shuffled[0]||0;
}
async function setRandomFreeId(){
  const inp=$("tokenId"); if (!inp) return;
  setStatus("Suche freie ID...","info");
  const id=await pickRandomFreeId();
  inp.value=String(id);
  await updatePreview();
}
async function safeMarkClaimed(i){
  const ok=await isIdAvailable(i);
  if (!ok) throw new Error("ID wurde soeben belegt. Bitte neu würfeln.");
  await markClaimed(i);
}

/* ==================== IPFS Helpers ==================== */
const fetchWithTimeout = (u, ms=6000)=>Promise.race([
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
  add("Name", meta.name||`Pi Pyramid #${id}`);
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
    const signed=await wallet.signTransaction(tx); // <- Phantom Popup

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

/* ==================== MINT ==================== */
async function doMint(){
  if (inFlight) return; inFlight=true;
  try{
    const btn=$("mintBtn"); btn.disabled=true;
    const lblEl=btn?.querySelector(".btn-label"); if (lblEl){ originalBtnText=lblEl.textContent; lblEl.textContent="Verarbeite..."; }
    setSpin(true);

    // tm kommt direkt aus dem ESM-Import oben

    if (!phantom?.publicKey) throw new Error("Wallet nicht verbunden");
    const idRaw=Number($("tokenId").value||0);
    const id=Math.max(0, Math.min(CFG.MAX_INDEX, Number.isFinite(idRaw)?Math.floor(idRaw):0));
    if (!Number.isInteger(id) || id<0 || id>CFG.MAX_INDEX) throw new Error(`Ungültige ID (0–${CFG.MAX_INDEX})`);
    if (!previewReady) throw new Error("Metadaten nicht geladen. Bitte kurz warten oder ID prüfen.");

    const donation=getSelectedDonation();
    const donationLamports=Math.round(donation*1e9);

    setStatus("Baue Transaktion...","info");
    log("Start mint",{id,donation});

    const conn=await ensureConnection();
    const wallet=phantom; const payer=wallet.publicKey;
    const mintKeypair=Keypair.generate(); const mint=mintKeypair.publicKey;
    const nftName=`Pi Pyramid #${id}`; const nftUri=uriForId(id);

    const collectionMint=new PublicKey(CFG.COLLECTION_MINT);
    const creatorPk=new PublicKey(CFG.CREATOR);
    const isSelf=payer.equals(creatorPk);

    await softAssertCollection(conn, collectionMint);

    const tx=new Transaction();
    await setSmartPriority(tx, conn);

    const feeLamports=isSelf?0:Math.round(CFG.MINT_FEE_SOL*1e9);
    if (feeLamports>0) tx.add(SystemProgram.transfer({fromPubkey:payer,toPubkey:creatorPk,lamports:feeLamports}));
    if (donationLamports>=1000) tx.add(SystemProgram.transfer({fromPubkey:payer,toPubkey:creatorPk,lamports:donationLamports}));

    const rentLamports=await getMinimumBalanceForRentExemptMint(conn);
    tx.add(SystemProgram.createAccount({fromPubkey:payer,newAccountPubkey:mint,space:MINT_SIZE,lamports:rentLamports,programId:TOKEN_PROGRAM_ID}));
    tx.add(createInitializeMint2Instruction(mint,0,payer,payer));

    const ata=await getAssociatedTokenAddress(mint,payer,false,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);
    const ataInfo=await conn.getAccountInfo(ata);
    if (!ataInfo) tx.add(createAssociatedTokenAccountInstruction(payer,ata,payer,mint));

    tx.add(createMintToInstruction(mint,ata,payer,1));

    const metadataPda=findMetadataPda(mint);
    const masterEditionPda=findMasterEditionPda(mint);

    tx.add(tm.createCreateMetadataAccountV3Instruction(
      { metadata:metadataPda, mint, mintAuthority:payer, payer, updateAuthority:payer },
      { createMetadataAccountArgsV3:{
          data:{
            name:nftName, symbol:"InPi", uri:nftUri, sellerFeeBasisPoints:CFG.ROYALTY_BPS,
            creators:[{address:creatorPk,verified:isSelf,share:100}],
            collection:{key:collectionMint,verified:false}, uses:null
          },
          isMutable:true, collectionDetails:null
        }
      }
    ));

    tx.add(tm.createCreateMasterEditionV3Instruction(
      { edition:masterEditionPda, mint, updateAuthority:payer, mintAuthority:payer, payer, metadata:metadataPda },
      { createMasterEditionArgs:{ maxSupply:0 } }
    ));

    if (isSelf){
      const collMdPda=findMetadataPda(collectionMint);
      const collEdPda=findMasterEditionPda(collectionMint);
      const hasSizedVerify=typeof tm.createVerifySizedCollectionItemInstruction==="function";
      const hasSetAndSized=typeof tm.createSetAndVerifySizedCollectionItemInstruction==="function";
      const hasLegacyVerify=typeof tm.createVerifyCollectionInstruction==="function";
      const hasLegacySet=typeof tm.createSetAndVerifyCollectionInstruction==="function";

      if (hasSizedVerify || hasSetAndSized){
        const sizedIx = hasSizedVerify ? tm.createVerifySizedCollectionItemInstruction
                                       : tm.createSetAndVerifySizedCollectionItemInstruction;
        tx.add(sizedIx({ metadata:metadataPda, collectionAuthority:payer, payer,
                         collectionMint, collection:collMdPda, collectionMasterEditionAccount:collEdPda }));
      } else if (hasLegacyVerify || hasLegacySet){
        const legacyIx = hasLegacyVerify ? tm.createVerifyCollectionInstruction
                                         : tm.createSetAndVerifyCollectionInstruction;
        tx.add(legacyIx({ metadata:metadataPda, collectionAuthority:payer, payer, collectionMint, collection:collMdPda }));
      } else {
        console.warn("[TM] Keine passende Verify-Instruction im Modul gefunden.");
      }
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

    await safeMarkClaimed(id); claimedSet.add(id); recomputeAvailable();
    await setRandomFreeId(); await updateBalance();

  }catch(e){ handleError("Mint fehlgeschlagen:", e);
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

/* ==================== UX Helpers ==================== */
function applyMintButtonState(){
  const btn=$("mintBtn"); if (!btn) return;
  const ok=!!phantom?.publicKey && previewReady;
  btn.disabled=!ok;
}

/* ==================== UI WIRING ==================== */
function wireUI(){
  $("connectBtn")?.addEventListener("click", connectPhantom);
  $("mintBtn")?.addEventListener("click", doMint);
  $("randBtn")?.addEventListener("click", setRandomFreeId);
  $("tokenId")?.addEventListener("input", updatePreview);

  // Donation-Pills
  const pills=Array.from(document.querySelectorAll('#donationOptions .pill'));
  const customContainer=$("customDonationContainer");
  const customInput=$("customDonationInput");
  const applyDonationSelection=()=>{
    pills.forEach(p=>p.classList.remove("active"));
    const checked=document.querySelector('#donationOptions input[name="donation"]:checked');
    if (!checked) return;
    const pill=checked.closest(".pill"); if (pill) pill.classList.add("active");
    if (customContainer) customContainer.style.display=(checked.value==="custom")?"inline-flex":"none";
    updateEstimatedCost();
  };
  pills.forEach(pill=>pill.addEventListener("click",()=>{
    const radio=pill.querySelector('input[name="donation"]'); if (!radio) return; radio.checked=true; applyDonationSelection();
  }));
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
  log("System boot",{build:BUILD_TAG,rpcs:CFG.RPCS});
  wireUI();
  await bootstrapClaims();
  const inp=$("tokenId"); if (inp) inp.value="0";
  await setRandomFreeId();
  applyMintButtonState();
});