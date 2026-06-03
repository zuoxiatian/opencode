# LongwiseTechAgent Official Site

LongwiseTechAgent desktop client official website. It includes product copy, usage steps, version history, and automatic download recommendation based on the visitor platform.

## Development

```bash
bun run dev
```

## Build

```bash
bun run typecheck
bun run build
```

## Download Hosting

By default, download buttons point to `/downloads/<filename>`.

When release artifacts are hosted elsewhere, build with:

```bash
VITE_DOWNLOAD_BASE_URL=https://example.com/downloads bun run build
```
