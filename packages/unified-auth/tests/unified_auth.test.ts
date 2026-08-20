import { UnifiedAuthManager } from '../src/manager';

describe('Unified Authentication & Identity Linking (#124)', () => {
  let authManager: UnifiedAuthManager;

  beforeEach(() => {
    authManager = new UnifiedAuthManager();
  });

  it('should register and track GitHub identity', () => {
    const user = authManager.registerOrUpdateGitHubIdentity('gh_12345', 'octocat');
    expect(user.githubUsername).toBe('octocat');
    expect(user.githubUserId).toBe('gh_12345');
  });

  it('should associate Google Drive and Telegram accounts to single GitHub identity', () => {
    const user = authManager.registerOrUpdateGitHubIdentity('gh_12345', 'octocat');
    authManager.linkGoogleDrive(user.id, 'octocat@gmail.com');
    authManager.linkTelegram(user.id, 'tg_9999', 'octocat_tg');

    expect(user.googleDriveLinked).toBe(true);
    expect(user.googleEmail).toBe('octocat@gmail.com');
    expect(user.telegramUserId).toBe('tg_9999');
  });

  it('should resolve invoking user from any linked provider event', () => {
    const user = authManager.registerOrUpdateGitHubIdentity('gh_12345', 'octocat');
    authManager.linkGoogleDrive(user.id, 'octocat@gmail.com');
    authManager.linkTelegram(user.id, 'tg_9999', 'octocat_tg');

    const resolvedByTg = authManager.resolveUserFromEvent({
      provider: 'telegram',
      providerId: 'tg_9999',
      metadata: {}
    });

    expect(resolvedByTg).not.toBeNull();
    expect(resolvedByTg?.githubUsername).toBe('octocat');
  });
});
