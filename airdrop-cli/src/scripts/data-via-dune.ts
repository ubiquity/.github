import { ethers } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { createClient } from "@supabase/supabase-js";
import { TX_HASHES } from "./tx-hashes";
import { writeFile } from "fs/promises";

const permit2Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SUPABASE_URL = "https://wfzpewmlyiozupulbuur.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndmenBld21seWlvenVwdWxidXVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTU2NzQzMzksImV4cCI6MjAxMTI1MDMzOX0.SKIL3Q0NOBaMehH0ekFspwgcu3afp3Dl9EDzPqs1nKs";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
(async () => {
  await dataViaDune().catch(console.error);
})().catch(console.error);

function loader() {
  const steps = ["|", "/", "-", "\\"];
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${steps[i++]}`);
    i = i % steps.length;
  }, 100);
}

export async function dataViaDune() {
  const TOKENS = {
    WXDAI: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  };

  const gnosisProvider = new ethers.providers.WebSocketProvider("wss://gnosis-rpc.publicnode.com", {
    name: "Gnosis Chain",
    chainId: 100,
    ensAddress: "",
  });

  const ethProvider = new ethers.providers.WebSocketProvider("wss://ethereum-rpc.publicnode.com", {
    name: "Ethereum Mainnet",
    chainId: 1,
    ensAddress: "",
  });

  const permit2ContractGno = new ethers.Contract(permit2Address, permit2Abi, gnosisProvider);

  const { idToWalletMap, users } = await getSupabaseData();

  const earnings: Record<string, number> = {};
  const permits: Record<string, (ethers.utils.Result | null)[]> = {};

  const loading = loader();
  for (const user of users) {
    const wallet = idToWalletMap.get(user.wallet_id);
    if (!wallet) continue;

    console.info(`Processing wallet: ${wallet}`);
    const userTxHashes = TX_HASHES[wallet.toLowerCase()];
    let count = userTxHashes?.length;
    const txs = [];

    while (count > 0) {
      const txHash = userTxHashes[count - 1];
      count--;
      let tx;
      tx = await gnosisProvider.getTransaction(txHash.hash);
      if (!tx) tx = await ethProvider.getTransaction(txHash.hash);
      if (!tx) continue;
      txs.push(tx);
    }

    const txData = txs.map((tx) => {
      if (!tx || !tx.data) return null;
      try {
        const { data } = tx;
        const decodedData = permit2ContractGno.interface.decodeFunctionData("permitTransferFrom", data);
        return decodedData;
      } catch (err) {
        console.error(err);
        return null;
      }
    });

    permits[wallet] = txData;

    let totalEarned = ethers.BigNumber.from(0);

    if (!txData.length) {
      console.log("No txData found");
      continue;
    }

    txData.reduce((acc, tx) => {
      if (!tx) return acc;

      const { permit } = tx;
      const { token, amount } = permit.permitted;

      if (token.toLowerCase() === TOKENS.WXDAI.toLowerCase()) {
        const earned = ethers.BigNumber.from(amount);
        totalEarned = totalEarned.add(earned);
      }

      return acc;
    });

    if (!totalEarned) return console.log("No earnings found");

    earnings[wallet] = parseInt(ethers.utils.formatUnits(totalEarned, 18));
  }

  clearInterval(loading);

  await writeFile("debug/dune-earnings.json", JSON.stringify(earnings, null, 2), "utf-8");
  await writeFile("debug/dune-permits.json", JSON.stringify(permits, null, 2), "utf-8");

  console.log(earnings);
}

// const ubqAddresses = [
//     "0xf87ca4583C792212e52720d127E7E0A38B818aD1",
//     "0x44Ca15Db101fD1c194467Db6AF0c67C6BbF4AB51",
//     "0x816863778F0Ea481E00195606B50d91F7C64637c",
//     "0x70fbcF82ffa891C4267B77847c21243c566f7617",
//   ];

async function getSupabaseData(): Promise<{ walletToIdMap: Map<string, number>; idToWalletMap: Map<number, string>; users: any[] }> {
  const { data, error } = await sb.from("wallets").select("address, id");

  if (error || !data?.length) {
    console.error(error);
  }

  const walletToIdMap = new Map<string, number>();
  const idToWalletMap = new Map<number, string>();

  for (const wallet of data) {
    walletToIdMap.set(wallet.address, wallet.id);
    idToWalletMap.set(wallet.id, wallet.address);
  }

  const { data: users, error: rr } = await sb.from("users").select("*").in("wallet_id", Array.from(idToWalletMap.keys()));

  if (rr || !users?.length) {
    console.error(rr);
  }

  return { walletToIdMap, idToWalletMap, users };
}
