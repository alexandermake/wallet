import * as bech32 from "bech32";
import { sha256 as shaNoble } from "@noble/hashes/sha256";
import { TxBody, AuthInfo, TxRaw, SignDoc, SignerInfo, ModeInfo, Fee } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { PubKey as Ed25519PubKey } from "cosmjs-types/cosmos/crypto/ed25519/keys";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { toBase64, toHex, fromBase64 } from "@cosmjs/encoding";
import { StargateClient } from "@cosmjs/stargate";

// ---------------- Phantom typings ----------------
type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array; toBase58(): string };
  isConnected?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: any }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array; publicKey: any }>;
};

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
    // Global helpers (same names as your Solflare version)
    connect: () => Promise<any>;
    testTransaction: () => Promise<any>;
    sendTransaction: (toAddress?: string, amountStr?: string, memo?: string) => Promise<any>;
    checkPhantomWallet: () => boolean;
    sign: () => Promise<any>;
  }
}

// ---------------- Config ----------------
const CONFIG = {
  rpc: "https://rpc.nolus.network",
  chainId: "pirin-1",
  addressPrefix: "nolus",
  denom: "unls"
};

// ---------------- Provider helpers ----------------
function getPhantom(): PhantomProvider | undefined {
  return window.phantom?.solana ?? window.solana;
}

export function checkPhantomWallet() {
  const p = getPhantom();
  console.log(p);
  const ok = !!p?.isPhantom;
  console.log(ok ? "✅ Phantom ready" : "❌ Install Phantom: https://phantom.app/");
  return ok;
}

// ---------------- Address / account ----------------
async function getAddress() {
  const phantom = getPhantom();
  if (!phantom?.isPhantom) {
    throw new Error("Phantom wallet not found! Install from https://phantom.app/");
  }

  console.log("Connecting to Phantom...");
  try {
    // Prefer connect() without onlyIfTrusted on first run (will prompt)
    const { publicKey } = await phantom.connect();
    if (!publicKey) throw new Error("Connection failed—user rejected or no publicKey available.");

    const solanaAddress = publicKey.toBase58();
    const ed25519PublicKey = publicKey.toBytes(); // 32 bytes

    console.log("Solana address:", solanaAddress);
    console.log("ED25519 pubkey (hex):", toHex(ed25519PublicKey));

    // Encode pubkey as Cosmos proto Any
    const ed25519PubkeyProtoBytes = Ed25519PubKey.encode({ key: ed25519PublicKey }).finish();
    const pubkeyAny = {
      typeUrl: "/cosmos.crypto.ed25519.PubKey",
      value: toBase64(ed25519PubkeyProtoBytes)
    };

    // Derive Nolus bech32 from SHA256(pubkey)[:20]
    const hashBytes = shaNoble(ed25519PublicKey);
    const addressBytes = hashBytes.slice(0, 20);
    const bech32Addr = bech32.encode(CONFIG.addressPrefix, bech32.toWords(addressBytes));

    console.log("Derived Nolus address:", bech32Addr);

    return { solanaAddress, pubkeyAny, bech32Addr, ed25519PublicKey };
  } catch (e) {
    console.error("Phantom connect error:", e);
    throw new Error(`Failed to connect to Phantom: ${String(e)}`);
  }
}

async function fetchAccountInfo(address: string) {
  const client = await StargateClient.connect(CONFIG.rpc);
  const account = await client.getAccount(address);

  if (!account) {
    console.log("Account not found.");
    return { accountNumber: 0n, sequence: 0n };
  }

  console.log("Account:", { address, accountNumber: account.accountNumber, sequence: account.sequence });
  return {
    accountNumber: BigInt(account.accountNumber || 0),
    sequence: BigInt(account.sequence || 0)
  };
}

// ---------------- Broadcast ----------------
async function broadcastTransaction(txBytes: Uint8Array) {
  const response = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "broadcast_tx_sync",
      params: { tx: toBase64(txBytes) }
    })
  });

  const { result, error } = await response.json();
  if (error) {
    console.error("RPC Error:", error);
    throw new Error(`Broadcast failed: ${error.message}`);
  }

  console.log("Broadcast result:", result);
  return result;
}

// ---------------- Core: ED25519 Tx with Phantom (SIGN_MODE_DIRECT) ----------------
export async function sendTransaction(toAddress?: string, amountStr?: string, memo?: string) {
  console.log("🛠️ Starting sendTransaction...");
  try {
    console.log("🔬 ED25519 Tx Test (Phantom → Nolus)");

    const { pubkeyAny, bech32Addr } = await getAddress();
    console.log("✅ Address fetched:", bech32Addr);
    const { accountNumber, sequence } = await fetchAccountInfo(bech32Addr);
    console.log("✅ Account info fetched:", { accountNumber: accountNumber.toString(), sequence: sequence.toString() });

    const amount = amountStr || "1000000"; // 1 unls
    const toAddr = toAddress || bech32Addr; // Self-send by default
    const feeAmount = "500";
    const gasLimit = 200000n;

    console.log("Tx params:", { from: bech32Addr, to: toAddr, amount, memo: memo || "phantom-ed25519-test" });

    // 1) TxBody with MsgSend
    const msgSend = MsgSend.fromPartial({
      fromAddress: bech32Addr,
      toAddress: toAddr,
      amount: [{ denom: CONFIG.denom, amount }]
    });

    const txBody = TxBody.fromPartial({
      messages: [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: MsgSend.encode(msgSend).finish() as Uint8Array
        }
      ],
      memo: memo || "phantom-ed25519-test"
    });
    const txBodyBytes = TxBody.encode(txBody).finish();
    console.log("✅ TxBody built:", toHex(txBodyBytes.slice(0, 32)) + "...");

    // 2) AuthInfo (SIGN_MODE_DIRECT)
    const authInfo = AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: { typeUrl: pubkeyAny.typeUrl, value: fromBase64(pubkeyAny.value) },
          modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } } as ModeInfo,
          sequence
        })
      ],
      fee: Fee.fromPartial({
        amount: [{ denom: CONFIG.denom, amount: feeAmount }],
        gasLimit
      })
    });
    const authInfoBytes = AuthInfo.encode(authInfo).finish();
    console.log("✅ AuthInfo built:", toHex(authInfoBytes.slice(0, 32)) + "...");

    // 3) SignDoc proto bytes
    const signDoc = SignDoc.fromPartial({
      bodyBytes: txBodyBytes,
      authInfoBytes: authInfoBytes,
      chainId: CONFIG.chainId,
      accountNumber
    });
    const signBytes = SignDoc.encode(signDoc).finish();
    console.log("✅ SignDoc built, length:", signBytes.length);
    console.log("SignDoc preview:", toHex(signBytes.slice(0, 64)) + "...");

    // 4) Sign with Phantom (raw bytes, ed25519)
    console.log("🔑 Prompting Phantom for signature...");
    const phantom = getPhantom()!;

    const message = `To avoid digital dognappers, sign below to authenticate with CryptoCorgis`;
    const encodedMessage = new TextEncoder().encode(Buffer.from(signBytes).toString());
    const { signature } = await phantom.signMessage(encodedMessage);
    // console.log(signedMessage);
    // console.log(signedMessage);
    // return;
    // const { signature } = await phantom.signMessage(signBytes);
    // console.log("✅ Signature obtained:", toHex(signature));

    // 5) Assemble TxRaw + broadcast
    const txRaw = TxRaw.fromPartial({
      bodyBytes: txBodyBytes,
      authInfoBytes: authInfoBytes,
      signatures: [signature]
    });
    const txBytes = TxRaw.encode(txRaw).finish();
    console.log("✅ TxRaw built, bytes length:", txBytes.length);

    console.log("📡 Broadcasting...");
    const result = await broadcastTransaction(txBytes);

    if (result.code === 0) {
      console.log("🎉 Success! Hash:", result.txhash || result.hash);
      return { success: true, hash: result.txhash || result.hash, result };
    } else {
      console.error("❌ Failed:", result.log || result.info);
      if (result.log?.includes("signature verification failed")) {
        console.error("🔍 Check chain’s ED25519 antehandler / Cosmos SDK version supports ed25519 accounts.");
      }
      return { success: false, error: result.log || "Unknown error", code: result.code, result };
    }
  } catch (error) {
    console.error("💥 Error in sendTransaction:", error);
    return { success: false, error: String(error) };
  }
}

// ---------------- Convenience ----------------
export async function connect() {
  console.log("🛠️ Starting connect...");
  try {
    console.log("🚀 Phantom → Nolus Connect");
    if (!checkPhantomWallet()) throw new Error("Phantom required");

    const { bech32Addr } = await getAddress();
    console.log("✅ Address from connect:", bech32Addr);
    const { accountNumber, sequence } = await fetchAccountInfo(bech32Addr);
    console.log("✅ Account from connect:", { accountNumber: accountNumber.toString(), sequence: sequence.toString() });

    testTransaction();
  } catch (error) {
    console.error("Connect failed:", error);
    throw error;
  }
}

export async function testTransaction() {
  console.log("🛠️ Starting testTransaction...");
  console.log("🧪 Phantom Test Tx (self-send 1 unls)");
  const result = await sendTransaction(undefined, "1", "Phantom ED25519 test");
  console.log("✅ testTransaction complete:", result);
  return result;
}

// ---------------- Global exposes ----------------
if (typeof window !== "undefined") {
  window.connect = connect;
  window.testTransaction = testTransaction;
  window.sendTransaction = sendTransaction;
  window.checkPhantomWallet = checkPhantomWallet;
  window.sign = testTransaction;
}

console.log(`
🎯 Phantom ED25519 Ready! (SIGN_MODE_DIRECT)

Commands:
- await connect()                    // Setup
- await testTransaction()            // Self-send
- checkPhantomWallet()               // Detect
`);
