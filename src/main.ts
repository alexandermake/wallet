import { sendTransaction, checkTestnet, getAccountInfo } from "./metamask/nolus";

// 🎉 WORKING NETWORK INTEGRATION
// Key insight: JSON key ordering matters! "amount" must come before "denom"

export async function connect() {
  try {
    console.log("🚀 NETWORK - METAMASK INTEGRATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Check network status
    console.log("🔍 Checking Network testnet status...");
    await checkTestnet();

    // Get account info
    console.log("📋 Getting account information...");
    const accountInfo = await getAccountInfo();
    console.log("Account details:", accountInfo);

    // Check if account needs funding
    if (accountInfo.sequence === 0) {
      console.log("💰 Account may need funding from faucet:");
      console.log("   🔗 https://faucet.pulsar.scrttestnet.com/");
      console.log("   📍 Your address:", accountInfo.address);
    }

    await sendTransaction("nolus1nlfjlsfrvlruxylh22teyp80mtc72wgx2c3u9r", "1", "test");

    return {
      success: true,
      address: accountInfo.address,
      accountNumber: accountInfo.accountNumber,
      sequence: accountInfo.sequence
    };
  } catch (error) {
    console.error("❌ Connection error:", error);
    throw error;
  }
}

export async function sendTransactionFn(toAddress?: string, amount?: string, memo?: string) {
  try {
    console.log("🔄 Initiating Network transaction...");

    const result = await sendTransaction(toAddress, amount, memo);

    if (result.success) {
      console.log("✅ Transaction successful!");
      console.log("🔗 Transaction hash:", result.hash);

      return {
        success: true,
        hash: result.hash,
        explorerUrl: result.hash
      };
    } else {
      console.error("❌ Transaction failed:", result.error);
      return {
        success: false,
        error: result.error
      };
    }
  } catch (error) {
    console.error("💥 Transaction error:", error);
    throw error;
  }
}

// Test function for quick testing
export async function testTransaction() {
  try {
    console.log("🧪 Running test transaction (self-send)...");

    const result = await sendTransaction(
      undefined, // self-send
      "1000000", // 1
      "Test transaction from MetaMask"
    );

    if (result.success) {
      console.log("🎉 Test successful! Integration is working!");
      return result;
    } else {
      console.log("❌ Test failed:", result.error);
      return result;
    }
  } catch (error) {
    console.error("🔥 Test error:", error);
    throw error;
  }
}

// Helper function to get faucet tokens
export async function requestFaucetTokens() {
  try {
    const accountInfo = await getAccountInfo();

    console.log("💰 Requesting faucet tokens...");
    console.log("📍 Your address:", accountInfo.address);
    console.log("💡 Copy your address and visit the faucet to get test tokens");

    // Open faucet in new tab (if in browser)
    if (typeof window !== "undefined") {
      window.open("https://faucet.pulsar.scrttestnet.com/", "_blank");
    }

    return {
      address: accountInfo.address,
      faucetUrl: "https://faucet.pulsar.scrttestnet.com/"
    };
  } catch (error) {
    console.error("❌ Error getting faucet info:", error);
    throw error;
  }
}

// Advanced: Send to specific address with custom amount
export async function sendToAddress(recipientAddress: string, amount: string, memo?: string) {
  try {
    console.log(`💸 Sending ${amount} to ${recipientAddress}`);

    const result = await sendTransaction(recipientAddress, amount, memo);
    return result;
  } catch (error) {
    console.error("❌ Send error:", error);
    throw error;
  }
}

export function scrtToUscrt(scrtAmount: number): string {
  return (scrtAmount * 1_000_000).toString();
}

export function uscrtToScrt(uscrtAmount: string): number {
  return parseInt(uscrtAmount) / 1_000_000;
}

// Make functions available globally for testing in console
declare global {
  interface Window {
    // Main functions
    connect: () => Promise<any>;
    sendTransaction: (toAddress?: string, amount?: string, memo?: string) => Promise<any>;
    testTransaction: () => Promise<any>;

    // Helper functions
    requestFaucetTokens: () => Promise<any>;
    sendToAddress: (address: string, amount: string, memo?: string) => Promise<any>;
    getAccountInfo: () => Promise<any>;

    // Utilities
    scrtToUscrt: (amount: number) => string;
    uscrtToScrt: (amount: string) => number;
  }
}

// Expose functions to window object for console testing
if (typeof window !== "undefined") {
  window.connect = connect;
  window.sendTransaction = sendTransactionFn;
  window.testTransaction = testTransaction;
  window.requestFaucetTokens = requestFaucetTokens;
  window.sendToAddress = sendToAddress;
  window.getAccountInfo = getAccountInfo;
  window.scrtToUscrt = scrtToUscrt;
  window.uscrtToScrt = uscrtToScrt;
}

// Usage examples for console:
console.log(`
🎯 NETWORK INTEGRATION READY!

📝 Available console commands:
   await connect()                              // Connect and check account
   await testTransaction()                      // Test with self-send
   await sendTransaction()                      // Send to yourself
   await sendTransaction("addr1abc...", "1000000", "Hello!")  // Send to address
   await requestFaucetTokens()                  // Get faucet info
   await getAccountInfo()                       // Check account status
`);
