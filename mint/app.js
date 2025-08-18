// ======== CONFIG ======== //
const CFG = {
  RPC_PROXY: "https://api.inpinity.online/rpc",      // <- Worker-Route
  CLAIMS_URL: "https://api.inpinity.online/claims",  // <- Worker-Route (KV)

  TREASURY: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  CREATOR:  "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",

  JSON_BASE_CID: "bafybeibjqtwncnrsv4vtcnrqcck3bgecu3pfip7mwu4pcdenre5b7am7tu",
  MAX_INDEX: 9999,
  ROYALTY_BPS: 700,   // 7%
  MINT_FEE_SOL: 0.02, // 0.02 SOL an Treasury

  GATEWAY: "https://ipfs.io/ipfs/",
  TOKEN_METADATA_PROGRAM_ID: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
};

// ======== Imports ======== //
import {
  Connection, PublicKey, SystemProgram, Transaction, Keypair
} from "https://esm.sh/@solana/web3.js@1.95.0";

import {
  getAssociatedTokenAddress, createInitializeMintInstruction, MINT_SIZE,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createMintToInstruction,
  createAssociatedTokenAccountInstruction
} from "https://esm.sh/@solana/spl-token@0.4.7";

import {
  createCreateMetadataAccountV3Instruction,
  createCreateMasterEditionV3Instruction
} from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@2.10.6";

// ======== DOM ======== //
const $connect = document.getElementById("btn-connect");
const $wallet = document.getElementById("wallet-display");
const $balance = document.getElementById("balance-display");
const $pick = document.getElementById("btn-pick");
const $index = document.getElementById("mint-index");
const $img = document.getElementById("nft-image");
const $name = document.getElementById("nft-name");
const $desc = document.getElementById("nft-desc");
const $mint = document.getElementById("btn-mint");
const $status = document.getElementById("tx-status");
const $donations = document.querySelectorAll(".donations button");

// ======== Connection via Worker RPC ======== //
const connection = new Connection(CFG.RPC_PROXY, { commitment: "confirmed" });

// ======== Phantom ======== //
const provider = window?.phantom?.solana;
let walletPubkey = null;

function lamports(sol) { return Math.floor(sol * 1_000_000_000); }

async function connectPhantom() {
  if (!provider?.isPhantom) {
    $status.textContent = "Phantom nicht gefunden. Bitte Phantom installieren.";
    window.open("https://phantom.app/", "_blank");
    return;
  }
  const { publicKey } = await provider.connect({ onlyIfTrusted: false });
  walletPubkey = new PublicKey(publicKey.toString());
  $wallet.textContent = walletPubkey.toBase58();
  await updateBalance();
  $status.textContent = "Verbunden.";
}

async function updateBalance() {
  if (!walletPubkey) return;
  const bal = await connection.getBalance(walletPubkey);
  $balance.textContent = `Balance: ${(bal / 1e9).toFixed(4)} SOL`;
}

// ======== Claims ======== //
async function fetchClaims() {
  try {
    const r = await fetch(CFG.CLAIMS_URL);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : Array.isArray(j.claimed) ? j.claimed : j.claimed ?? [];
  } catch { return []; }
}
function findFirstFree(claimed) {
  const set = new Set(claimed);
  for (let i = 0; i <= CFG.MAX_INDEX; i++) if (!set.has(i)) return i;
  return null;
}
async function pickFreeIndex() {
  const claimed = await fetchClaims();
  const i = findFirstFree(claimed);
  if (i == null) { $status.textContent = "Alle Nummern vergeben."; return; }
  $index.value = i;
  await loadPreview(i);
}
async function markClaimed(i) {
  try {
    await fetch(CFG.CLAIMS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: i }),
    });
  } catch {}
}

// ======== Preview ======== //
async function loadPreview(i) {
  if (i == null || isNaN(i)) { $img.src=""; $name.textContent="—"; $desc.textContent="—"; return; }
  const metaUrl = `${CFG.GATEWAY}${CFG.JSON_BASE_CID}/${i}.json`;
  try {
    const r = await fetch(metaUrl);
    const j = await r.json();
    $name.textContent = j.name || `Pi Pyramid #${i}`;
    $desc.textContent = j.description || "";
    const img = (j.image || "").replace("ipfs://", CFG.GATEWAY);
    $img.src = img;
  } catch {
    $name.textContent = `Pi Pyramid #${i}`;
    $desc.textContent = "(Metadaten nicht geladen)";
    $img.src = "";
  }
}

// ======== Metadata PDAs ======== //
function findMetadataPda(mint) {
  const TM = new PublicKey(CFG.TOKEN_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TM.toBuffer(), mint.toBuffer()],
    TM
  )[0];
}
function findMasterEditionPda(mint) {
  const TM = new PublicKey(CFG.TOKEN_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TM.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    TM
  )[0];
}

// ======== Build Mint Tx ======== //
async function buildMintTx(i) {
  if (!walletPubkey) throw new Error("Wallet nicht verbunden");
  if (isNaN(i) || i < 0 || i > CFG.MAX_INDEX) throw new Error("Ungültige Nummer");

  const payer = walletPubkey;
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const rentMint = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const ata = await getAssociatedTokenAddress(mint, payer);
  const mdPda = findMetadataPda(mint);
  const mePda = findMasterEditionPda(mint);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

  const name = `Pi Pyramid #${i}`;
  const symbol = "PIPY";
  const uri = `${CFG.GATEWAY}${CFG.JSON_BASE_CID}/${i}.json`;

  // 0) Fee an Treasury
  const feeIx = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(CFG.TREASURY),
    lamports: lamports(CFG.MINT_FEE_SOL),
  });

  // 1) Mint-Konto anlegen
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: mint,
    space: MINT_SIZE,
    lamports: rentMint,
    programId: TOKEN_PROGRAM_ID,
  });

  // 2) Mint initialisieren (decimals=0, authority=payer)
  const initMintIx = createInitializeMintInstruction(mint, 0, payer, payer);

  // 3) ATA erstellen
  const createAtaIx = createAssociatedTokenAccountInstruction(
    payer, // payer
    ata,   // ATA
    payer, // owner
    mint   // mint
  );

  // 4) 1 Token minten
  const mintToIx = createMintToInstruction(mint, ata, payer, 1);

  // 5) Metadata
  const createMdIx = createCreateMetadataAccountV3Instruction(
    { metadata: mdPda, mint, mintAuthority: payer, payer, updateAuthority: payer },
    {
      createMetadataAccountArgsV3: {
        data: {
          name,
          symbol,
          uri,
          sellerFeeBasisPoints: CFG.ROYALTY_BPS,
          creators: [{ address: new PublicKey(CFG.CREATOR), verified: false, share: 100 }],
          collection: null, uses: null
        },
        isMutable: true,
        collectionDetails: null
      }
    }
  );

  // 6) Master Edition (maxSupply 0 = keine harte Begrenzung)
  const createMeIx = createCreateMasterEditionV3Instruction(
    { edition: mePda, mint, updateAuthority: payer, mintAuthority: payer, payer, metadata: mdPda },
    { createMasterEditionArgs: { maxSupply: 0 } }
  );

  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    .add(feeIx, createMintIx, initMintIx, createAtaIx, mintToIx, createMdIx, createMeIx);

  tx.partialSign(mintKeypair);
  return { tx, mint };
}

async function sendViaPhantom(tx) {
  const { signature } = await provider.signAndSendTransaction(tx);
  return signature;
}

// ======== Events ======== //
document.getElementById("btn-connect").addEventListener("click", connectPhantom);
document.getElementById("btn-pick").addEventListener("click", async () => {
  try { await pickFreeIndex(); } catch(e){ $status.textContent = String(e); }
});
document.getElementById("mint-index").addEventListener("change", async () => {
  const i = parseInt($index.value, 10);
  if (!isNaN(i)) await loadPreview(i);
});
document.getElementById("btn-mint").addEventListener("click", async () => {
  try {
    $status.textContent = "Baue Transaktion…";
    let i = parseInt($index.value || "", 10);
    if (isNaN(i)) {
      const claimed = await fetchClaims();
      const free = findFirstFree(claimed);
      if (free == null) throw new Error("Keine freie Nummer gefunden");
      i = free;
      $index.value = i;
    }
    const { tx } = await buildMintTx(i);
    $status.textContent = "Sende via Phantom…";
    const sig = await sendViaPhantom(tx);
    $status.innerHTML = `✅ Mint gesendet: <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noreferrer">${sig}</a>`;
    await markClaimed(i);
    await updateBalance();
  } catch (e) {
    console.error(e);
    $status.textContent = "❌ Fehler: " + (e?.message || String(e));
  }
});
document.querySelectorAll(".donations button").forEach(btn => {
  btn.addEventListener("click", async () => {
    try {
      const amt = parseFloat(btn.dataset.amt);
      if (!walletPubkey) throw new Error("Wallet nicht verbunden");
      const ix = SystemProgram.transfer({
        fromPubkey: walletPubkey,
        toPubkey: new PublicKey(CFG.TREASURY),
        lamports: lamports(amt),
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ feePayer: walletPubkey, blockhash, lastValidBlockHeight }).add(ix);
      const { signature } = await provider.signAndSendTransaction(tx);
      $status.innerHTML = `🙏 Danke! <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noreferrer">${signature}</a>`;
      await updateBalance();
    } catch (e) { $status.textContent = "❌ Fehler: " + (e?.message || String(e)); }
  });
});

// Default-Preview:
loadPreview(0).catch(()=>{});