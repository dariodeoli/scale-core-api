#!/usr/bin/env bash
# Activa los hooks del repo en este checkout/worktree.
# Se corre UNA vez por checkout nuevo (o después de clonar).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chmod +x "$ROOT/.githooks/pre-push"
git config core.hooksPath .githooks
echo "Hooks instalados: core.hooksPath = .githooks"
echo "Pre-push activo: los pushes a main requieren MOBOS_INTEGRATOR=1."
