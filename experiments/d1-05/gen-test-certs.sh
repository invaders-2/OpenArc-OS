#!/bin/bash
# D1-05 §7/§8：生成本轮 TLS 验证所需的**测试 PKI**。
#
# 全部产物只落在 artifacts/d1-05/tls/（gitignored），使用测试私钥与测试 CA，
# 不触碰用户任何真实证书或密钥。
#
# 生成清单：
#   ca.crt / ca.key                    测试根 CA
#   wrongca.crt / wrongca.key          第二个独立 CA（用于"错 CA"场景）
#   server.crt / server.key            CN=localhost, SAN DNS:localhost,IP:127.0.0.1
#   wronghost.crt / wronghost.key      SAN 只写 wrong.example.invalid（用于主机名不匹配）
#   expired-server.crt / .key          已过期（notAfter 在 2020 年）
#   clientA.crt / clientA.key          设备 A 客户端证书
#   clientB.crt / clientB.key          设备 B 客户端证书
#   expired-client.crt / .key          已过期的客户端证书
#   wrongca-client.crt / .key          由错误 CA 签发的客户端证书
#   clientA.srl / clientB.srl ...      序列号文件（撤销场景用）

set -euo pipefail
cd "$(dirname "$0")/../.."

TLS="artifacts/d1-05/tls"
EXT="$TLS/ext"
rm -rf "$TLS"
mkdir -p "$EXT"

OPENSSL=${OPENSSL:-openssl}
DAYS_Y="+3.5.0"

note() { printf '  %s\n' "$*"; }

# ── 扩展文件 ────────────────────────────────────────────────
cat > "$EXT/ca.ext" <<'EOF'
basicConstraints=critical,CA:TRUE,pathlen:1
keyUsage=critical,keyCertSign,cRLSign
EOF

cat > "$EXT/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EOF

cat > "$EXT/wronghost.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:definitely-not-localhost.example.invalid
EOF

cat > "$EXT/client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF

openssl_version=$($OPENSSL version)
note "$openssl_version"

# ── 根 CA ───────────────────────────────────────────────────
$OPENSSL req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout "$TLS/ca.key" -out "$TLS/ca.crt" \
  -subj "/C=CN/O=OpenArc D1-05 Test/CN=OpenArc D1-05 Test Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
note "ca.crt"

# ── 第二个 CA（错误 CA）────────────────────────────────────
$OPENSSL req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout "$TLS/wrongca.key" -out "$TLS/wrongca.crt" \
  -subj "/C=CN/O=OpenArc D1-05 Wrong/CN=OpenArc D1-05 Wrong CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
note "wrongca.crt"

sign() { # sign <name> <subject> <extfile> <ca_crt> <ca_key> [notbefore notafter]
  local name=$1 subj=$2 ext=$3 cacrt=$4 cakey=$5 nb=${6:-} na=${7:-}
  $OPENSSL req -newkey rsa:2048 -nodes -sha256 \
    -keyout "$TLS/$name.key" -out "$TLS/$name.csr" -subj "$subj" 2>/dev/null
  local extra=()
  [ -n "$nb" ] && extra+=(-not_before "$nb")
  [ -n "$na" ] && extra+=(-not_after "$na")
  # macOS 自带 bash 3.2：set -u 下展开空数组会报 unbound variable，必须用 ${arr[@]+...}
  $OPENSSL x509 -req -in "$TLS/$name.csr" -CA "$cacrt" -CAkey "$cakey" \
    -CAcreateserial -out "$TLS/$name.crt" -days 365 -sha256 \
    -extfile "$ext" ${extra[@]+"${extra[@]}"} 2>/dev/null
  rm -f "$TLS/$name.csr"
  note "$name.crt"
}

# ── 服务端证书 ──────────────────────────────────────────────
sign server    "/C=CN/O=OpenArc D1-05 Test/CN=localhost" "$EXT/server.ext" "$TLS/ca.crt" "$TLS/ca.key"
sign wronghost "/C=CN/O=OpenArc D1-05 Test/CN=wrong.example.invalid" "$EXT/wronghost.ext" "$TLS/ca.crt" "$TLS/ca.key"
# 已过期的服务端证书：notAfter = 2020-01-02
sign expired-server "/C=CN/O=OpenArc D1-05 Test/CN=localhost" "$EXT/server.ext" \
  "$TLS/ca.crt" "$TLS/ca.key" "20200101000000Z" "20200102000000Z"

# ── 客户端证书 ──────────────────────────────────────────────
sign clientA "/C=CN/O=OpenArc D1-05 Test/CN=device-A" "$EXT/client.ext" "$TLS/ca.crt" "$TLS/ca.key"
sign clientB "/C=CN/O=OpenArc D1-05 Test/CN=device-B" "$EXT/client.ext" "$TLS/ca.crt" "$TLS/ca.key"
sign expired-client "/C=CN/O=OpenArc D1-05 Test/CN=device-expired" "$EXT/client.ext" \
  "$TLS/ca.crt" "$TLS/ca.key" "20200101000000Z" "20200102000000Z"
sign wrongca-client "/C=CN/O=OpenArc D1-05 Wrong/CN=device-forged" "$EXT/client.ext" \
  "$TLS/wrongca.crt" "$TLS/wrongca.key"

# ── 证书指纹与有效期（供 ADR 引用）──────────────────────────
{
  echo "# D1-05 测试 PKI —— 证书摘要（仅测试用，可随时重建）"
  echo
  echo "生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "openssl：$openssl_version"
  echo
  printf '%-18s %-12s %-46s %-24s %-24s\n' NAME SERIAL SHA256_FP NOT_BEFORE NOT_AFTER
  for f in ca.crt wrongca.crt server.crt wronghost.crt expired-server.crt \
           clientA.crt clientB.crt expired-client.crt wrongca-client.crt; do
    base=${f%.crt}
    fp=$($OPENSSL x509 -in "$TLS/$f" -noout -fingerprint -sha256 | cut -d= -f2)
    ser=$($OPENSSL x509 -in "$TLS/$f" -noout -serial | cut -d= -f2)
    nb=$($OPENSSL x509 -in "$TLS/$f" -noout -startdate | sed 's/notBefore=//')
    na=$($OPENSSL x509 -in "$TLS/$f" -noout -enddate | sed 's/notAfter=//')
    printf '%-18s %-12s %-46s %-24s %-24s\n' "$base" "$ser" "$fp" "$nb" "$na"
  done
} > "$TLS/CERTS.txt"

chmod 600 "$TLS"/*.key
cat "$TLS/CERTS.txt"
echo
echo "PKI 目录：$TLS"
