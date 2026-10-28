"""Canonical JSON and digests, byte-compatible with the server's `canonicalJson`.

`src/shared/parsing.ts` sorts object keys and writes every value with `JSON.stringify`. The
server recomputes digests (the artifact digest, an upload's `payload_digest`) from what it
receives, so this writer must give the same bytes: no spaces, keys in UTF-16 code-unit order,
strings as `JSON.stringify` escapes them, and numbers as ECMAScript `Number::toString` writes
them (`1` for 1.0, `1e-7` for 1e-07).
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any


def js_number(value: int | float) -> str:
    """ECMAScript Number::toString for a finite number."""
    if isinstance(value, bool):
        raise TypeError("a boolean is not a number")
    if isinstance(value, int):
        value = float(value) if abs(value) >= 2**53 else value
        if isinstance(value, int):
            return str(value)
    if not math.isfinite(value):
        raise ValueError("JSON has no NaN or Infinity")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr gives the shortest digits that round-trip, as ECMAScript requires.
    digits_tuple = Decimal(repr(abs(value))).normalize().as_tuple()
    digits = "".join(str(digit) for digit in digits_tuple.digits)
    k = len(digits)
    n = digits_tuple.exponent + k  # the decimal point sits after n digits
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    exponent = n - 1
    mark = "+" if exponent >= 0 else "-"
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{mark}{abs(exponent)}"


def _utf16_key(key: str) -> list[int]:
    return list(key.encode("utf-16-be"))


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_key)
        return "{" + ",".join(f"{json.dumps(key, ensure_ascii=False)}:{canonical_json(value[key])}" for key in keys) + "}"
    raise TypeError(f"no JSON form for {type(value).__name__}")


def sha256_hex(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def sha256_canonical(value: Any) -> str:
    return sha256_hex(canonical_json(value))


def sha256_digest(data: bytes | str) -> str:
    """`sha256:<64 lowercase hex>`, the protocol's digest form."""
    return f"sha256:{sha256_hex(data)}"


def file_digest(path: str) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return f"sha256:{hasher.hexdigest()}"
