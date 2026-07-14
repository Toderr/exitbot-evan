#!/usr/bin/env bash
# Encrypts SOLANA_PRIVATE_KEY into secrets/wallet.key.age using age.
# The plaintext key is read via a hidden prompt — it never touches shell
# history, disk (unencrypted), or any log.
set -euo pipefail

AGE_PUBKEY="age1y3taptfyyd8ck9fafdygsq8rwmqrjaekkxy4vgeqqkgry0prvudsrcpr4u"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/secrets/wallet.key.age"

mkdir -p "$ROOT/secrets"

read -rsp "Paste SOLANA_PRIVATE_KEY (base58, input hidden): " KEY
echo

if [ -z "$KEY" ]; then
  echo "Empty key, aborting." >&2
  exit 1
fi

printf '%s' "$KEY" | age -r "$AGE_PUBKEY" -o "$OUT"
unset KEY

chmod 600 "$OUT"
echo "Encrypted to $OUT"
