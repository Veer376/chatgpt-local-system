---
name: local-artifact-transfer
description: Transfer a generated file from an isolated agent/session filesystem into an authorized Local System path. Use when the artifact already exists outside the user's computer and the generator cannot write directly to Local System. Uses chunked base64 plus SHA-256 verification so binary files arrive intact.
---

# Local Artifact Transfer

Use this only when a generated artifact already exists in a sandbox/session filesystem that Local System cannot read directly. If the generator can write straight to an authorized local path, do that instead.

## Contract

1. Choose an authorized destination on the user's computer: the active project for project assets, otherwise the `localScratchDir` returned by `bridge_context`.
2. On the source side, read the artifact bytes and compute:
   - byte size
   - SHA-256
   - base64 split into chunks no larger than **60,000 characters**
3. On Local System, initialize the receiver:

```sh
python3 skills/local-artifact-transfer/scripts/receive.py init \
  --id <transfer-id> \
  --dest <absolute-destination> \
  --sha256 <sha256> \
  --size <byte-size>
```

4. Send every base64 chunk in order. Each call must stay comfortably below the Local System command-size limit:

```sh
printf '%s' '<base64-chunk>' | \
  python3 skills/local-artifact-transfer/scripts/receive.py append \
  --id <transfer-id> --index <0-based-index>
```

5. Finalize:

```sh
python3 skills/local-artifact-transfer/scripts/receive.py finalize --id <transfer-id>
```

`finalize` decodes the combined chunks, verifies the expected byte size and SHA-256, and only then atomically writes the destination file. A mismatch is a failed transfer; do not use the artifact.

6. Verify the local result before claiming success:
   - images: inspect with Local System `view_image`
   - other binaries: use `file`, size, and/or checksum as appropriate

## Source-side chunking

Use any source-side execution tool that can read the generated file. Equivalent Python logic is:

```python
data = Path(source).read_bytes()
sha256 = hashlib.sha256(data).hexdigest()
encoded = base64.b64encode(data).decode("ascii")
chunks = [encoded[i:i + 60000] for i in range(0, len(encoded), 60000)]
```

Never recompress, resize, or change formats merely to make the transfer easier unless the user asked for that transformation.
