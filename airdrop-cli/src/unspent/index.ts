import { ethers, BigNumberish, BigNumber } from "ethers";
import { permit2Abi } from "../abis/permit2Abi";
import { JsonRpcProvider } from "@ethersproject/providers";
import { formatUnits } from "viem";

export enum NetworkIds {
  Mainnet = 1,
  Goerli = 5,
  Gnosis = 100,
}

export enum Tokens {
  DAI = "0x6b175474e89094c44da98b954eedeac495271d0f",
  WXDAI = "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
}

export type Erc20Permit = {
  type: string;
  permit: {
    permitted: {
      token: string;
      amount: string;
    };
    nonce: string;
    deadline: string;
  };
  transferDetails: {
    to: string;
    requestedAmount: string;
  };
  owner: string;
  signature: string;
  networkId: number;
};

export const networkNames = {
  [NetworkIds.Mainnet]: "Ethereum Mainnet",
  [NetworkIds.Goerli]: "Goerli Testnet",
  [NetworkIds.Gnosis]: "Gnosis Chain",
};

export const permit2Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export async function processAllUnclaimedPermits(permits: Erc20Permit[]) {
  const unspentPermits = [];
  const gnosisProvider = new ethers.providers.JsonRpcProvider("https://rpc.gnosischain.com", {
    name: "Gnosis Chain",
    chainId: 100,
    ensAddress: "",
  });

  const ethProvider = new ethers.providers.JsonRpcProvider("https://mainnet.gateway.tenderly.co", {
    name: "Ethereum Mainnet",
    chainId: 1,
    ensAddress: "",
  });

  for (const permit of permits) {
    if (Array.isArray(permit)) {
      try {
        for (const p of permit) {
          const permits = await processUnclaimedPermit(p, gnosisProvider, ethProvider);
          unspentPermits.push(...permits);
        }
      } catch (err) {
        console.log(permit);
      }
    } else {
      const permits = await processUnclaimedPermit(permit, gnosisProvider, ethProvider);
      unspentPermits.push(...permits);
    }
  }
  return unspentPermits;
}

export async function processUnclaimedPermit(permit: Erc20Permit, gnosisProvider: JsonRpcProvider, ethProvider: JsonRpcProvider) {
  const unspentPermits = [];

  try {
    const {
      permit: {
        permitted: { token, amount },
      },
      transferDetails: { to },
    } = permit;

    let isClaimed = false;
    const t = token.toLowerCase().trim();

    if (t === Tokens.WXDAI) {
      isClaimed = await isNonceClaimed(permit, gnosisProvider);
    } else if (t === Tokens.DAI) {
      isClaimed = await isNonceClaimed(permit, ethProvider);
    } else {
      console.log(`Token ${token} not supported`);
      throw new Error(`Token ${token} not supported`);
    }

    const processed = await processNotClaimedPermit(permit, t, amount, to, isClaimed);

    unspentPermits.push(...processed);
  } catch (err) {
    console.log("Error processing permit", err);
  }
  return unspentPermits;
}

async function processNotClaimedPermit(permit: Erc20Permit, t: string, amount: string, to: string, isClaimed: boolean) {
  const unspentPermits = [];
  if (!isClaimed) {
    // some are missing type
    if (!permit.type) {
      // recreating the signed data exactly
      permit = {
        type: "erc20-permit",
        permit: permit.permit,
        transferDetails: permit.transferDetails,
        owner: permit.owner,
        signature: permit.signature,
        networkId: t === Tokens.WXDAI ? 100 : 1,
      };
    }

    // some are missing networkId
    if (!permit.networkId) {
      permit = {
        type: "erc20-permit",
        permit: permit.permit,
        transferDetails: permit.transferDetails,
        owner: permit.owner,
        signature: permit.signature,
        networkId: t === Tokens.WXDAI ? 100 : 1,
      };
    }

    const txData = [permit];
    const base64encodedTxData = Buffer.from(JSON.stringify(txData)).toString("base64");
    const url = `https://pay.ubq.fi?claim=${base64encodedTxData}`;

    unspentPermits.push({
      token: t === Tokens.WXDAI ? "WXDAI" : "DAI",
      amount: formatUnits(BigInt(amount), 18).toString(),
      to,
      network: t === Tokens.WXDAI ? networkNames[NetworkIds.Gnosis] : networkNames[NetworkIds.Mainnet],
      url,
    });
  }
  return unspentPermits;
}

export function nonceBitmap(nonce: BigNumberish): { wordPos: BigNumber; bitPos: number } {
  // wordPos is the first 248 bits of the nonce
  const wordPos = BigNumber.from(nonce).shr(8);
  // bitPos is the last 8 bits of the nonce
  const bitPos = BigNumber.from(nonce).and(255).toNumber();
  return { wordPos, bitPos };
}

export async function isNonceClaimed(permit: Erc20Permit, provider: JsonRpcProvider): Promise<boolean> {
  const permit2Contract = new ethers.Contract(permit2Address, permit2Abi, provider);

  const { wordPos, bitPos } = nonceBitmap(BigNumber.from(permit.permit.nonce));
  const bitmap = await permit2Contract.nonceBitmap(permit.owner, wordPos);

  const bit = BigNumber.from(1).shl(bitPos);
  const flipped = BigNumber.from(bitmap).xor(bit);

  return bit.and(flipped).eq(0);
}
