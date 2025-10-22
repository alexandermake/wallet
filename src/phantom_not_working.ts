import * as bech32 from "bech32";
import { sha256 as shaNoble } from "@noble/hashes/sha256";
import { TxBody, AuthInfo, TxRaw, SignDoc } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { PubKey as Ed25519PubKey } from "cosmjs-types/cosmos/crypto/ed25519/keys";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { Fee } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { toBase64, toHex, fromHex, fromBase64 } from "@cosmjs/encoding";
import { StargateClient } from "@cosmjs/stargate";
import { SignerInfo, ModeInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";

// Extend Window for Phantom and global functions
declare global {
  interface Window {
    phantom?: {
      solana: {
        isPhantom: boolean;
        connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: any }>;
        disconnect(): Promise<void>;
        signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<{ signature: Uint8Array; publicKey: any }>;
        publicKey?: any; // Populated after connect()
        isConnected?: boolean;
      };
    };
    // Global functions to avoid TS errors
    connect: () => Promise<any>;
    testTransaction: () => Promise<any>;
    sendTransaction: (toAddress?: string, amountStr?: string, memo?: string) => Promise<any>;
    checkPhantomWallet: () => boolean;
    sign: () => Promise<any>; // For quick test
  }
}

const CONFIG = {
  rpc: "https://rpc.nolus.network",
  chainId: "pirin-1",
  addressPrefix: "nolus",
  denom: "unls"
};

async function getAddress() {
  console.log("Connecting to Phantom...");
  try {
    const { publicKey } = (await window.phantom?.solana!.connect()) as { publicKey: any };

    if (!publicKey) {
      throw new Error("Connection failed—user rejected or no publicKey available.");
    }

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

    // Derive Cosmos address: SHA256(pubkey)[:20] → Bech32
    const hashBytes = shaNoble(ed25519PublicKey);
    const addressBytes = hashBytes.slice(0, 20);
    const bech32Addr = bech32.encode(CONFIG.addressPrefix, bech32.toWords(addressBytes));

    console.log("Derived Nolus address:", bech32Addr);

    return { solanaAddress, pubkeyAny, bech32Addr, ed25519PublicKey };
  } catch (connectError) {
    console.error("Phantom connect error:", connectError);
    throw new Error(`Failed to connect to Phantom: ${String(connectError)}`);
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

// Core: ED25519 Tx with Phantom (SIGN_MODE_DIRECT, no prefix needed)
export async function sendTransaction(toAddress?: string, amountStr?: string, memo?: string) {
  console.log("🛠️ Starting sendTransaction...");
  try {
    console.log("🔬 ED25519 Tx Test (Phantom → Nolus)");

    const { pubkeyAny, bech32Addr } = await getAddress();
    console.log("✅ Address fetched:", bech32Addr);
    const { accountNumber, sequence } = await fetchAccountInfo(bech32Addr);
    console.log("✅ Account info fetched:", { accountNumber: accountNumber.toString(), sequence: sequence.toString() });
    const amount = amountStr || "1000000"; // 1 unls
    const toAddr = toAddress || bech32Addr; // Self-send default
    const feeAmount = "500";
    const gasLimit = 200000n;

    console.log("Tx params:", { from: bech32Addr, to: toAddr, amount, memo: memo || "phantom-ed25519-test" });

    // 1. TxBody (MsgSend)
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

    // 2. AuthInfo (SIGN_MODE_DIRECT)
    const authInfo = AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: {
            typeUrl: pubkeyAny.typeUrl,
            value: fromBase64(pubkeyAny.value)
          },
          modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } },
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

    // 3. SignDoc proto bytes
    const signDoc = SignDoc.fromPartial({
      bodyBytes: txBodyBytes,
      authInfoBytes: authInfoBytes,
      chainId: CONFIG.chainId,
      accountNumber
    });
    const signBytes = SignDoc.encode(signDoc).finish();
    console.log("✅ SignDoc built, length:", signBytes.length);

    // console.log("SignDoc preview:", toHex(signBytes.slice(0, 64)) + "...");

    // 4. Sign with Phantom
    console.log("🔑 Prompting Phantom for signature...");

    const { signature } = await window.phantom!.solana.signMessage(signBytes, "utf8");

    console.log(signature);
    console.log("✅ Signature obtained:", toHex(signature));

    // 5. TxRaw + broadcast
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
        console.error("🔍 Check SDK v0.53+ ED25519 ante support.");
      }
      return { success: false, error: result.log || "Unknown error", code: result.code, result };
    }
  } catch (error) {
    console.error("💥 Error in sendTransaction:", error);
    return { success: false, error: String(error) };
  }
}

// Helpers
export function checkPhantomWallet() {
  const hasPhantomWallet = !!window.phantom?.solana?.isPhantom;
  console.log(hasPhantomWallet ? "✅ Phantom ready" : "❌ Install Phantom");
  return hasPhantomWallet;
}

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

// Global exposes (TS-safe now)
if (typeof window !== "undefined") {
  window.connect = connect;
  window.testTransaction = testTransaction;
  window.sendTransaction = sendTransaction;
  window.checkPhantomWallet = checkPhantomWallet;
  window.sign = testTransaction; // For buttons
}

console.log(`
🎯 Phantom ED25519 Ready! (SIGN_MODE_DIRECT)

Commands:
- await connect()                    // Setup
- await testTransaction()             // Self-send
- checkPhantomWallet()               // Detect
`);
