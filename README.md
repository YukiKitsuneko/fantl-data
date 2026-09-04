# fantl-data

## Synchronizing novels

Preview novel pages that are present in Blogger but missing from `novels.js`:

```sh
node sync-novels.mjs --dry-run
```

Validate, normalize, and append the missing records:

```sh
node sync-novels.mjs --write
```

The command reads Blogger's public page sitemap and JSON page feed. It excludes
the About, DMCA, and series-list utility pages and identifies novels by their
canonical page URL.
