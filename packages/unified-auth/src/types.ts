export interface UserIdentityMapping {
  id: string;
  githubUserId: string;
  githubUsername: string;
  googleEmail?: string;
  googleDriveLinked?: boolean;
  telegramUserId?: string;
  telegramUsername?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupabaseIdentityEvent {
  provider: 'github' | 'google' | 'telegram';
  providerId: string;
  metadata: Record<string, unknown>;
}
