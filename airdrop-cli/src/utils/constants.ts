export const NetworkIds = {
  Mainnet: 1,
  Goerli: 5,
  Gnosis: 100,
} as const;

export const Tokens = {
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  WXDAI: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
} as const;

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
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const SUPABASE_URL = "https://wfzpewmlyiozupulbuur.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndmenBld21seWlvenVwdWxidXVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTU2NzQzMzksImV4cCI6MjAxMTI1MDMzOX0.SKIL3Q0NOBaMehH0ekFspwgcu3afp3Dl9EDzPqs1nKs";
