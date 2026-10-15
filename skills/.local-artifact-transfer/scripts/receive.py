#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path


STATE_ROOT = Path(tempfile.gettempdir()) / "chatgpt-local-artifact-transfer"
ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


def transfer_dir(transfer_id: str) -> Path:
    if not ID_PATTERN.fullmatch(transfer_id):
        raise SystemExit("Invalid transfer id")
    return STATE_ROOT / transfer_id


def load_manifest(root: Path) -> dict:
    path = root / "manifest.json"
    if not path.exists():
        raise SystemExit("Transfer is not initialized")
    return json.loads(path.read_text())


def cmd_init(args: argparse.Namespace) -> None:
    root = transfer_dir(args.id)
    if root.exists():
        raise SystemExit("Transfer id already exists")

    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.sha256):
        raise SystemExit("Invalid SHA-256")
    if args.size < 0:
        raise SystemExit("Invalid size")

    destination = Path(args.dest).expanduser().resolve()
    root.mkdir(parents=True)
    (root / "chunks").mkdir()
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "dest": str(destination),
                "sha256": args.sha256.lower(),
                "size": args.size,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"initialized {args.id}")


def cmd_append(args: argparse.Namespace) -> None:
    if args.index < 0:
        raise SystemExit("Invalid chunk index")

    root = transfer_dir(args.id)
    load_manifest(root)
    chunk = "".join(os.sys.stdin.read().split())
    if not chunk:
        raise SystemExit("Empty chunk")
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", chunk):
        raise SystemExit("Chunk is not valid base64 text")

    path = root / "chunks" / f"{args.index:08d}.b64"
    if path.exists():
        existing = path.read_text()
        if existing != chunk:
            raise SystemExit(f"Chunk {args.index} already exists with different data")
        print(f"chunk {args.index} already present")
        return

    path.write_text(chunk)
    print(f"stored chunk {args.index}")


def cmd_finalize(args: argparse.Namespace) -> None:
    root = transfer_dir(args.id)
    manifest = load_manifest(root)
    chunk_paths = sorted((root / "chunks").glob("*.b64"))
    if not chunk_paths:
        raise SystemExit("No chunks received")

    indexes = [int(path.stem) for path in chunk_paths]
    expected_indexes = list(range(len(indexes)))
    if indexes != expected_indexes:
        raise SystemExit(f"Missing or non-contiguous chunks: got {indexes}")

    encoded = "".join(path.read_text() for path in chunk_paths)
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise SystemExit(f"Base64 decode failed: {exc}") from exc

    actual_size = len(data)
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_size != manifest["size"]:
        raise SystemExit(
            f"Size mismatch: expected {manifest['size']}, got {actual_size}"
        )
    if actual_sha != manifest["sha256"]:
        raise SystemExit(
            f"SHA-256 mismatch: expected {manifest['sha256']}, got {actual_sha}"
        )

    destination = Path(manifest["dest"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, destination)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise

    shutil.rmtree(root)
    print(f"wrote {destination}")
    print(f"bytes {actual_size}")
    print(f"sha256 {actual_sha}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Receive a chunked binary artifact")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--id", required=True)
    init_parser.add_argument("--dest", required=True)
    init_parser.add_argument("--sha256", required=True)
    init_parser.add_argument("--size", required=True, type=int)
    init_parser.set_defaults(func=cmd_init)

    append_parser = subparsers.add_parser("append")
    append_parser.add_argument("--id", required=True)
    append_parser.add_argument("--index", required=True, type=int)
    append_parser.set_defaults(func=cmd_append)

    finalize_parser = subparsers.add_parser("finalize")
    finalize_parser.add_argument("--id", required=True)
    finalize_parser.set_defaults(func=cmd_finalize)

    return parser


def main() -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
