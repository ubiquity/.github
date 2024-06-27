export const TOKENS = {
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  WXDAI: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
} as const;

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const SUPABASE_URL: string = "";
export const SUPABASE_KEY: string = "";

if (SUPABASE_KEY === "" || SUPABASE_URL === "") {
  throw new Error("SUPABASE_URL and SUPABASE_KEY must be set in /src/utils/constants.ts");
}

export const UBQ_OWNERS = [
  "0xf87ca4583C792212e52720d127E7E0A38B818aD1".toLowerCase(),
  "0x44Ca15Db101fD1c194467Db6AF0c67C6BbF4AB51".toLowerCase(),
  "0x816863778F0Ea481E00195606B50d91F7C64637c".toLowerCase(),
  "0x70fbcF82ffa891C4267B77847c21243c566f7617".toLowerCase(),
];
