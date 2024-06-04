import { PERMIT2_ADDRESS } from "../utils/constants";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { SupabaseClient } from "@supabase/supabase-js";

function nonceBitmap(nonce: BigNumberish): { wordPos: BigNumberish; bitPos: number } {
  // wordPos is the first 248 bits of the nonce
  const wordPos = BigNumber.from(nonce).shr(8);
  // bitPos is the last 8 bits of the nonce
  const bitPos = BigNumber.from(nonce).and(255).toNumber();
  return { wordPos, bitPos };
}

async function invalidateNonce(nonce: string, owner: string, provider: ethers.providers.WebSocketProvider): Promise<boolean> {
  const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, permit2Abi, provider);

  const { wordPos, bitPos } = nonceBitmap(BigNumber.from(nonce));
  const bitmap = await permit2Contract.nonceBitmap(owner, wordPos);

  const bit = BigNumber.from(1).shl(bitPos);
  const flipped = BigNumber.from(bitmap).xor(bit);

  return bit.and(flipped).eq(0);
}

export async function getSupabaseData(sb: SupabaseClient): Promise<{ walletToIdMap: Map<string, number>; idToWalletMap: Map<number, string>; users: User[] }> {
  const walletToIdMap = new Map<string, number>();
  const idToWalletMap = new Map<number, string>();

  const { data, error } = await sb.from("wallets").select("address, id");

  if (error || !data?.length) {
    console.error(error);
    return { walletToIdMap, idToWalletMap, users: [] };
  }

  for (const wallet of data) {
    const addr = wallet.address.toLowerCase();
    walletToIdMap.set(addr, wallet.id);
    idToWalletMap.set(wallet.id, addr);
  }

  const { data: users, error: rr } = await sb.from("users").select("*").in("wallet_id", Array.from(idToWalletMap.keys()));

  if (rr || !users?.length) {
    console.error(rr);
    return { walletToIdMap, idToWalletMap, users: [] };
  }

  return { walletToIdMap, idToWalletMap, users };
}

export function loader() {
  const steps = ["|", "/", "-", "\\"];
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${steps[i++]}`);
    i = i % steps.length;
  }, 100);
}
