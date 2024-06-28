export interface PermitDetails {
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
}

export type Decoded = {
  reward: PermitDetails;
  txHash: string;
  blockTimestamp: Date | string;
};

export type IssueOut = {
  issueCreator: string;
  issueAssignee: string;
  issueNumber: number;
  repoName: string;
  timestamp: string;
  claimUrl: string;
  reward: PermitDetails;
};

export type FinalData = Decoded & IssueOut;

export interface Repositories {
  name: string;
  isArchived: boolean;
  lastCommitDate: string;
}

export type User = {
  id: number;
  wallet_id: number;
};

export type ScanResponse = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  nonce: string;
  blockHash: string;
  transactionIndex: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  isError: string;
  txreceipt_status: string;
  input: string;
  contractAddress: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  confirmations: string;
  methodId: string;
  functionName: string;
};

export type PermitEntry = {
  amount: string;
  nonce: string;
  deadline: string;
  signature: string;
  token_id: number;
  beneficiary_id: number;
  transaction: string;
};
