"""Generic verification-only prototype. No I/O, networking, credentials or execution.

TrustPins must come from independently reviewed protected authority, never from
these input blobs. Verification is necessary, not sufficient, for authorization.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import io
import gzip
import json
from pathlib import PurePosixPath
import re
import tarfile

MAX_POLICY_BYTES = 64 * 1024
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 1024
HEX_DIGEST = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')

class VerificationError(ValueError):
    """Generic non-reflecting failure safe for status reporting."""

@dataclass(frozen=True)
class TrustPins:
    policy_sha256: str
    bundle_sha256: str
    bootstrap_revision: str

@dataclass(frozen=True)
class VerifiedInputs:
    policy_sha256: str
    bundle_sha256: str
    bootstrap_revision: str
    file_count: int
    expanded_bytes: int
    execution_authorized: bool = False


def _reject():
    raise VerificationError('Input verification failed; execution remains disabled')


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _reject()
        result[key] = value
    return result


def _finite_number(value):
    _reject()


def verify(policy_blob: bytes, bundle_blob: bytes, pins: TrustPins,
           observed_bootstrap_revision: str, now: datetime) -> VerifiedInputs:
    """Verify exact bytes before parsing. Never fetch, extract or execute anything."""
    if type(pins) is not TrustPins or not all(type(s) is str for s in
            (pins.policy_sha256, pins.bundle_sha256, pins.bootstrap_revision)):
        _reject()
    if not HEX_DIGEST.fullmatch(pins.policy_sha256) or not HEX_DIGEST.fullmatch(pins.bundle_sha256):
        _reject()
    if not REVISION.fullmatch(pins.bootstrap_revision) or observed_bootstrap_revision != pins.bootstrap_revision:
        _reject()
    if type(policy_blob) is not bytes or type(bundle_blob) is not bytes:
        _reject()
    if not 0 < len(policy_blob) <= MAX_POLICY_BYTES or not 0 < len(bundle_blob) <= MAX_BUNDLE_BYTES:
        _reject()
    # Both independent protected pins checked before either blob is interpreted.
    if sha256(policy_blob).hexdigest() != pins.policy_sha256 or sha256(bundle_blob).hexdigest() != pins.bundle_sha256:
        _reject()
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        _reject()
    try:
        policy = json.loads(policy_blob.decode('utf-8'), object_pairs_hook=_unique_object,
                            parse_constant=_finite_number)
        if type(policy) is not dict or set(policy) != {
                'schema_version', 'bundle_sha256', 'bootstrap_revision', 'not_before_utc', 'expires_at_utc'}:
            _reject()
        if type(policy['schema_version']) is not int or policy['schema_version'] != 1:
            _reject()
        if policy['bundle_sha256'] != pins.bundle_sha256 or policy['bootstrap_revision'] != pins.bootstrap_revision:
            _reject()
        times = []
        for field in ('not_before_utc', 'expires_at_utc'):
            value = policy[field]
            if type(value) is not str or not value.endswith('Z'):
                _reject()
            stamp = datetime.fromisoformat(value[:-1] + '+00:00')
            if stamp.utcoffset().total_seconds() != 0:
                _reject()
            times.append(stamp)
        start, end = times
        if not start <= now.astimezone(timezone.utc) < end or not 0 < (end-start).total_seconds() <= 7200:
            _reject()
        seen = set()
        expanded = 0
        files = 0
        # Bound decompression INCLUDING metadata before tar parsing. This also
        # bounds hidden extended headers rather than just yielded file sizes.
        with gzip.GzipFile(fileobj=io.BytesIO(bundle_blob), mode='rb') as compressed:
            expanded_archive = compressed.read(MAX_EXPANDED_BYTES + 1)
        if len(expanded_archive) > MAX_EXPANDED_BYTES:
            _reject()
        # Streaming iteration bounds yielded entries, not getmembers().
        with tarfile.open(fileobj=io.BytesIO(expanded_archive), mode='r|') as archive:
            for entry in archive:
                if len(seen) >= MAX_ENTRIES:
                    _reject()
                name = entry.name
                path = PurePosixPath(name)
                if (not name or '\\' in name or '\x00' in name or ':' in name
                        or path.is_absolute() or '..' in path.parts
                        or str(path) != name or name in seen):
                    _reject()
                seen.add(name)
                # Flat or nested regular files only; no symlinks/hardlinks/devices.
                if not entry.isfile() or entry.size < 0 or entry.mode & 0o7000:
                    _reject()
                expanded += entry.size
                if expanded > MAX_EXPANDED_BYTES:
                    _reject()
                # Consume each member with bounded chunks to detect truncation.
                member = archive.extractfile(entry)
                if member is None:
                    _reject()
                remaining = entry.size
                while remaining:
                    chunk = member.read(min(remaining, 65536))
                    if not chunk:
                        _reject()
                    remaining -= len(chunk)
                files += 1
        if files == 0:
            _reject()
    except VerificationError:
        raise
    except Exception:
        _reject()
    return VerifiedInputs(pins.policy_sha256, pins.bundle_sha256,
                          pins.bootstrap_revision, files, expanded)
