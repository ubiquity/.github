import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../utils/constants";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSupabaseData(): Promise<{ walletToIdMap: Map<string, number>; idToWalletMap: Map<number, string>; users: User[] }> {
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
