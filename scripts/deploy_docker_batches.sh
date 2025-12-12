#!/bin/bash
set -euo pipefail

# --- Konfigurasi umum --- #
# Banyaknya container per wallet
CONTAINERS_PER_WALLET=5

# Rate limit: berapa container per batch dan jeda antar batch (detik)
BATCH_SIZE=100
PAUSE_SECONDS=60

# Nama file wallets (harus ada di direktori yang sama dengan script ini)
WALLETS_FILE="wallets.json"

# --- Informasi image & environment sesuai kebutuhan Anda --- #
IMAGE_NAME="firstbatch/dkn-compute-node:latest"
DKN_MODELS="llama3.3:70b-instruct-q4_K_M"
OLLAMA_HOST="http://host.docker.internal"
OLLAMA_PORT="14441"
OLLAMA_AUTO_PULL="false"
RUST_LOG="none,dkn_compute=info"
NETWORK_NAME="dria-nodes"

# Gunakan sudo untuk docker (ikuti kebiasaan Anda sebelumnya)
DOCKER="sudo docker"

# --- Helper: cek dependency --- #
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Perintah '$1' tidak ditemukan. Mohon install terlebih dahulu."
    exit 1
  }
}

# --- Cek dependency --- #
need_cmd jq
need_cmd docker

# --- Cek & baca wallets.json --- #
if [[ ! -f "$WALLETS_FILE" ]]; then
  echo "File '$WALLETS_FILE' tidak ditemukan. Letakkan file tersebut di direktori yang sama dengan script ini."
  exit 1
fi

# Ambil data wallet
mapfile -t WALLET_ADDRS < <(jq -r '.[].address' "$WALLETS_FILE")
mapfile -t WALLET_KEYS  < <(jq -r '.[].private_key' "$WALLETS_FILE")

WALLETS_COUNT=${#WALLET_ADDRS[@]}
if (( WALLETS_COUNT == 0 )); then
  echo "Tidak ada wallet di '$WALLETS_FILE'."
  exit 1
fi

TOTAL_CONTAINERS=$(( WALLETS_COUNT * CONTAINERS_PER_WALLET ))
echo "Ditemukan $WALLETS_COUNT wallet."
echo "Akan men-deploy $CONTAINERS_PER_WALLET container per wallet = $TOTAL_CONTAINERS container total."
echo "Rate limit: $BATCH_SIZE container per $PAUSE_SECONDS detik."

# --- Pastikan network ada --- #
echo "Memastikan jaringan Docker '$NETWORK_NAME' ada..."
$DOCKER network create "$NETWORK_NAME" >/dev/null 2>&1 || true

# --- Fungsi utilitas container --- #
container_status() {
  local name="$1"
  $DOCKER inspect -f '{{.State.Status}}' "$name" 2>/dev/null || true
}

remove_container_if_exists() {
  local name="$1"
  if $DOCKER inspect "$name" >/dev/null 2>&1; then
    local status
    status="$(container_status "$name")"
    if [[ "$status" == "running" ]]; then
      # Biarkan berjalan, kita skip agar idempotent
      echo "  - Container $name sudah berjalan (status: $status). Melewati."
      return 1
    else
      echo "  - Container $name ada (status: $status). Menghapus lalu membuat ulang..."
      $DOCKER rm -f "$name" >/dev/null
      return 0
    fi
  fi
  return 0
}

# --- Deployment --- #
echo "Memulai deployment..."
STARTED=0

for (( w=0; w<WALLETS_COUNT; w++ )); do
  WALLET_INDEX=$((w + 1))
  ADDRESS="${WALLET_ADDRS[$w]}"
  PRIVKEY_RAW="${WALLET_KEYS[$w]}"

  # Hilangkan prefix '0x' pada private key
  DKN_WALLET_SECRET_KEY="${PRIVKEY_RAW#0x}"

  # Buat prefix nama dari address (tanpa 0x), ambil 6 char pertama agar mudah dibaca
  ADDRESS_NO0X="${ADDRESS#0x}"
  ADDR_SHORT="${ADDRESS_NO0X:0:6}"

  echo ""
  echo "=== Wallet #$WALLET_INDEX ($ADDRESS) ==="
  for (( i=1; i<=CONTAINERS_PER_WALLET; i++ )); do
    CONTAINER_NAME="compute_node_w${WALLET_INDEX}_${ADDR_SHORT}_$(printf '%02d' "$i")"

    # Hapus jika ada container exited/created; skip jika running
    if ! remove_container_if_exists "$CONTAINER_NAME"; then
      # skip jika sudah running
      continue
    fi

    echo "  Meluncurkan container: $CONTAINER_NAME"
    $DOCKER run -d \
      --name "$CONTAINER_NAME" \
      --network "$NETWORK_NAME" \
      --restart "on-failure" \
      -e RUST_LOG="$RUST_LOG" \
      -e DKN_WALLET_SECRET_KEY="$DKN_WALLET_SECRET_KEY" \
      -e DKN_MODELS="$DKN_MODELS" \
      -e OLLAMA_HOST="$OLLAMA_HOST" \
      -e OLLAMA_PORT="$OLLAMA_PORT" \
      -e OLLAMA_AUTO_PULL="$OLLAMA_AUTO_PULL" \
      --label "wallet_index=$WALLET_INDEX" \
      --label "wallet_address=$ADDRESS" \
      --add-host host.docker.internal:host-gateway \
      "$IMAGE_NAME" >/dev/null

    STARTED=$((STARTED + 1))
    # Rate limit: tidur setiap BATCH_SIZE container
    if (( STARTED % BATCH_SIZE == 0 )); then
      echo "  -> Sudah meluncurkan $STARTED/$TOTAL_CONTAINERS container. Menunggu $PAUSE_SECONDS detik..."
      sleep "$PAUSE_SECONDS"
    fi
  done
done

echo ""
echo "=================================================="
echo "Deployment selesai. Total container diluncurkan (atau sudah running): $STARTED"
echo "Periksa dengan: sudo docker ps"
echo "Pantau resource: sudo docker stats"
echo "Filter per wallet (contoh): sudo docker ps --filter 'label=wallet_index=1'"
echo "=================================================="
