export interface PaymentInfo {
  issueNumber: number;
  repoName: string;
  paymentAmount: number;
  currency: string;
  payee?: string;
  type?: string;
  url: string;
}

export interface Repositories {
  name: string;
  isArchived: boolean;
  lastCommitDate: string;
}

export interface Contributor {
  [username: string]: number;
}

export interface NoPayments {
  repoName: string;
  archived: boolean;
  lastCommitDate: string;
  message: string;
  url: string;
}

export interface CSVData {
  contributors: Contributor;
  allPayments: PaymentInfo[];
  allNoAssigneePayments: PaymentInfo[];
  noPayments: NoPayments[];
}
