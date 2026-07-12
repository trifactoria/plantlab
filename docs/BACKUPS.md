# Backups

PlantLab stores backups as local archives with sidecar metadata.

## Commands

```bash
plantlab backup list
plantlab backup create
plantlab backup verify <archive>
plantlab backup restore <archive> --to <staging-directory>
```

Restore never overwrites live data automatically. It extracts into a staging
directory for inspection.

## What Is Included

- SQLite database
- project photo data
- capture-source image data
- backup manifest and checksums

## More Detail

See the backup sections in [DEPLOYMENT.md](../DEPLOYMENT.md) for archive
format and restore precautions.
