#!/usr/bin/env bash
# Reviewed official upstream release archives; never pipe installers from the network.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP must point to the ephemeral runner directory}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"
work="$(mktemp -d "$RUNNER_TEMP/backup-tools.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 \
  https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz -o age.tar.gz
echo '7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50  age.tar.gz' | sha256sum --check --status
tar -xzf age.tar.gz
mkdir -p "$RUNNER_TEMP/backup-bin"
install -m 0755 age/age age/age-keygen "$RUNNER_TEMP/backup-bin/"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 \
  https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.37.8.zip -o awscli.zip
echo '6a2f98fee0901ff623ff9abb5c80f4d67c40e5c0ac5e2ad7afa2ba756a7d5088  awscli.zip' | sha256sum --check --status
unzip -q awscli.zip
./aws/install --install-dir "$RUNNER_TEMP/backup-aws" --bin-dir "$RUNNER_TEMP/backup-bin" >/dev/null
echo "$RUNNER_TEMP/backup-bin" >> "$GITHUB_PATH"
