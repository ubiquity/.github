# Ubiquity XP

A toolset to calculate GitHub user XP using Supabase and GitHub API data.

## xp-cli

### Setup

1. **Install Dependencies**:

   ```bash
   bun install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your Supabase URL, Anon Key, and GitHub Token.

3. **Link the CLI**:
   ```bash
   bun link
   ```

## Usage

Calculate XP for a GitHub user:

```bash
xp-cli calculate --user=zugdev
```

### Options

- `--user <username>`: GitHub username (required).
- `--org <org>`: Filter by organization (optional).
- `--repo <repo>`: Filter by repository (requires `--org`, optional).

### Examples

- Global XP:
  ```bash
  xp-cli calculate --user=zugdev
  ```
- Organization XP:
  ```bash
  xp-cli calculate --user=zugdev --org=ubiquity
  ```
- Repository XP:
  ```bash
  xp-cli calculate --user=zugdev --org=ubiquity --repo=work.ubq.fi
  ```
