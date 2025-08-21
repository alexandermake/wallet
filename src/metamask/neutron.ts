import * as bech32 from "bech32";
import { sha256 as shaNoble } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { TxBody, AuthInfo, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { PubKey as PubKeyProto } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { Fee } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { toBase64, toHex, fromHex } from "@cosmjs/encoding";
import { StargateClient } from "@cosmjs/stargate";
import { SignerInfo, ModeInfo } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { hashMessage, hexlify, SigningKey, toUtf8Bytes, getBytes } from "ethers";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";

const CONFIG = {
  rpc: "https://pion-rpc.nolus.network",
  chainId: "pion-1",
  addressPrefix: "neutron",
  denom: "untrn",
  faucetUrl: "https://faucet.pulsar.scrttestnet.com/"
};

async function getAddress() {
  await window.ethereum.request({ method: "eth_requestAccounts" });
  const ethAddress = (await window.ethereum.request({ method: "eth_accounts" }))[0];

  console.log("Connected Ethereum address:", ethAddress);

  // Generate public key exactly like neutron does
  const message = "Generate Cosmos pubkey";
  const sig: string = await window.ethereum.request({
    method: "personal_sign",
    params: [hexlify(toUtf8Bytes(message)), ethAddress]
  });

  const digest = hashMessage(message);
  const fullPubkey = SigningKey.recoverPublicKey(digest, sig);

  // Compress secp256k1 key
  const uncompressed = getBytes(fullPubkey);
  const x = uncompressed.slice(1, 33);
  const y = uncompressed.slice(33);
  const compressed = new Uint8Array(33);
  compressed[0] = y[y.length - 1] % 2 ? 0x03 : 0x02;
  compressed.set(x, 1);

  console.log(
    "Compressed pubkey:",
    Array.from(compressed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );

  const pubkeyProtoBytes = PubKeyProto.encode({ key: compressed }).finish();
  const pubkeyAny = {
    typeUrl: "/cosmos.crypto.secp256k1.PubKey",
    value: pubkeyProtoBytes
  };

  // Derive neutron address
  const sha = shaNoble(compressed);
  const rip = ripemd160(sha);
  const bech32Addr = bech32.encode(CONFIG.addressPrefix, bech32.toWords(rip));

  console.log("Nuetron testnet address:", bech32Addr);

  return { ethAddress, pubkeyAny, bech32Addr };
}

async function fetchAccountInfo(address: string) {
  try {
    const client = await StargateClient.connect(CONFIG.rpc);
    const account = await client.getAccount(address);

    if (!account) {
      console.log("Neutron account not found, may need funding");
      return { accountNumber: 0, sequence: 0 };
    }

    return {
      accountNumber: account.accountNumber,
      sequence: account.sequence
    };
  } catch (error) {
    console.error("Error fetching Neutron account info:", error);
    throw error;
  }
}

async function broadcastTransaction(txBytes: Uint8Array) {
  try {
    const response = await fetch(CONFIG.rpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "broadcast_tx_sync",
        params: {
          tx: toBase64(txBytes)
        }
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error("Neutron RPC Error:", result.error);
      throw new Error(`Neutron RPC Error: ${result.error.message}`);
    }

    return result.result;
  } catch (error) {
    console.error("Error broadcasting Neutron transaction:", error);
    throw error;
  }
}

// 🎯 THE WORKING SOLUTION: Correct JSON key ordering (amount before denom)
export async function sendTransaction(toAddress?: string, amount?: string, memo?: string) {
  try {
    console.log("🚀 Sending Neutron Network transaction with MetaMask...");

    const { ethAddress, pubkeyAny, bech32Addr } = await getAddress();
    const { accountNumber, sequence } = await fetchAccountInfo(bech32Addr);

    console.log("Account:", accountNumber, "Sequence:", sequence);

    // 💡 KEY INSIGHT: JSON key ordering matters!
    // "amount" must come BEFORE "denom" in the JSON structure
    const exactSignDoc = {
      account_number: accountNumber.toString(),
      chain_id: CONFIG.chainId,
      fee: {
        amount: [
          {
            amount: "5000", // ✅ amount BEFORE denom (this was the fix!)
            denom: CONFIG.denom
          }
        ],
        gas: "200000"
      },
      memo: memo || "Neutron Network transaction",
      msgs: [
        {
          type: "cosmos-sdk/MsgSend",
          value: {
            amount: [
              {
                amount: amount || "1000000", // ✅ amount BEFORE denom
                denom: CONFIG.denom
              }
            ],
            from_address: bech32Addr,
            to_address: toAddress || bech32Addr
          }
        }
      ],
      sequence: sequence.toString()
    };

    // Create the exact JSON with 4-space indentation
    const messageBytes = toUtf8Bytes(JSON.stringify(exactSignDoc, null, 4));
    console.log("JSON to sign:", new TextDecoder().decode(messageBytes));

    // Sign using personal_sign (adds EIP-191 prefix automatically)
    const msgToSign = `0x${toHex(messageBytes)}`;
    const sigResult: string = await window.ethereum.request({
      method: "personal_sign",
      params: [msgToSign, ethAddress]
    });

    console.log("Signature result:", sigResult);

    // Process signature: remove 0x and recovery ID (last 2 chars)
    const sig = fromHex(sigResult.slice(2, -2));

    // Build protobuf transaction
    const msgSend = MsgSend.fromPartial({
      fromAddress: bech32Addr,
      toAddress: toAddress || bech32Addr,
      amount: [{ denom: CONFIG.denom, amount: amount || "1000000" }]
    });

    const txBodyBytes = TxBody.encode(
      TxBody.fromPartial({
        messages: [
          {
            typeUrl: "/cosmos.bank.v1beta1.MsgSend",
            value: MsgSend.encode(msgSend).finish()
          }
        ],
        memo: memo || "Neutron Network transaction"
      })
    ).finish();

    const authInfoBytes = AuthInfo.encode(
      AuthInfo.fromPartial({
        signerInfos: [
          SignerInfo.fromPartial({
            publicKey: pubkeyAny,
            modeInfo: ModeInfo.fromPartial({
              single: { mode: SignMode.SIGN_MODE_EIP_191 }
            }),
            sequence: BigInt(sequence)
          })
        ],
        fee: Fee.fromPartial({
          amount: [{ denom: CONFIG.denom, amount: "5000" }],
          gasLimit: BigInt(200000)
        })
      })
    ).finish();

    const txRaw = TxRaw.fromPartial({
      bodyBytes: txBodyBytes,
      authInfoBytes: authInfoBytes,
      signatures: [sig]
    });

    const txBytes = TxRaw.encode(txRaw).finish();
    console.log("Broadcasting transaction...");

    const result = await broadcastTransaction(txBytes);

    if (result.code === 0) {
      console.log("✅ Transaction successful!");
      console.log("Transaction hash:", result.hash);
      return {
        success: true,
        hash: result.hash,
        result: result
      };
    } else {
      console.error("❌ Transaction failed:", result.log);
      return {
        success: false,
        error: result.log,
        result: result
      };
    }
  } catch (error) {
    console.error("Transaction error:", error);
    throw error;
  }
}

// Helper function to check network status
export async function checkTestnet() {
  try {
    console.log("🔍 Checking Neutron Network testnet...");

    const response = await fetch(CONFIG.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "abci_info",
        params: {}
      })
    });

    const result = await response.json();
    console.log("Neutron testnet info:", result);
    return result;
  } catch (error) {
    console.error("Error checking Neutron testnet:", error);
    throw error;
  }
}

// Helper function to get account info
export async function getAccountInfo() {
  try {
    const { bech32Addr } = await getAddress();
    const accountInfo = await fetchAccountInfo(bech32Addr);

    return {
      address: bech32Addr,
      accountNumber: accountInfo.accountNumber,
      sequence: accountInfo.sequence
    };
  } catch (error) {
    console.error("Error getting account info:", error);
    throw error;
  }
}
