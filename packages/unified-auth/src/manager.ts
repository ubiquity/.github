import { UserIdentityMapping, SupabaseIdentityEvent } from './types';

export class UnifiedAuthManager {
  private identities = new Map<string, UserIdentityMapping>();

  public registerOrUpdateGitHubIdentity(githubUserId: string, githubUsername: string): UserIdentityMapping {
    const existing = this.findIdentityByGitHub(githubUserId);
    const now = new Date().toISOString();

    if (existing) {
      existing.githubUsername = githubUsername;
      existing.updatedAt = now;
      return existing;
    }

    const newIdentity: UserIdentityMapping = {
      id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      githubUserId,
      githubUsername,
      createdAt: now,
      updatedAt: now,
    };

    this.identities.set(newIdentity.id, newIdentity);
    return newIdentity;
  }

  public linkGoogleDrive(identityId: string, googleEmail: string): boolean {
    const user = this.identities.get(identityId);
    if (!user) return false;

    user.googleEmail = googleEmail;
    user.googleDriveLinked = true;
    user.updatedAt = new Date().toISOString();
    return true;
  }

  public linkTelegram(identityId: string, telegramUserId: string, telegramUsername?: string): boolean {
    const user = this.identities.get(identityId);
    if (!user) return false;

    user.telegramUserId = telegramUserId;
    user.telegramUsername = telegramUsername;
    user.updatedAt = new Date().toISOString();
    return true;
  }

  public resolveUserFromEvent(event: SupabaseIdentityEvent): UserIdentityMapping | null {
    for (const user of this.identities.values()) {
      if (event.provider === 'github' && user.githubUserId === event.providerId) return user;
      if (event.provider === 'google' && user.googleEmail === event.providerId) return user;
      if (event.provider === 'telegram' && user.telegramUserId === event.providerId) return user;
    }
    return null;
  }

  public findIdentityByGitHub(githubUserId: string): UserIdentityMapping | undefined {
    for (const user of this.identities.values()) {
      if (user.githubUserId === githubUserId) return user;
    }
    return undefined;
  }
}
