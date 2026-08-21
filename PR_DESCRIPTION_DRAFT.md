# feat(auth): unified multiplatform authentication & identity mapping (#124)

## Summary
Resolves #124 by implementing `packages/unified-auth`, establishing identity mapping between GitHub accounts, Google Drive, and Telegram via Supabase Auth schema and `UnifiedAuthManager`.

### Deliverables
- `packages/unified-auth/src/schema.sql`: Supabase PostgreSQL table and indexing definitions for identity mapping.
- `packages/unified-auth/src/manager.ts`: Identity linking and multiplatform event resolution.
- `packages/unified-auth/tests/unified_auth.test.ts`: Test suite verifying cross-provider user resolution.

Closes #124
