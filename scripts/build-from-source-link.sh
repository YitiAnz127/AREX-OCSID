#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/cli"
COMMAND_NAME="ocsid"

if [[ ! -f "$PACKAGE_DIR/package.json" ]]; then
	echo "error: expected ocsid package at $PACKAGE_DIR" >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
	echo "error: Node.js and npm must be available on PATH" >&2
	exit 1
fi

export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"

echo "==> Installing ocsid source dependencies"
npm --prefix "$PACKAGE_DIR" ci --include=dev --ignore-scripts

echo "==> Building ocsid from cli"
npm --prefix "$PACKAGE_DIR" run build

if [[ ! -x "$PACKAGE_DIR/dist/cli.js" ]]; then
	echo "error: build did not create executable $PACKAGE_DIR/dist/cli.js" >&2
	exit 1
fi

echo "==> Linking ocsid globally"
global_prefix="$(npm prefix --global)"
global_node_modules="$global_prefix/lib/node_modules"
global_package="$global_node_modules/ocsid"
global_bin="$global_prefix/bin/$COMMAND_NAME"
global_bin_target=""

if [[ -L "$global_bin" ]]; then
	global_bin_target="$(readlink -m "$global_bin")"
fi

if [[ -L "$global_package" ]] && [[ "$(readlink -f "$global_package")" == "$PACKAGE_DIR" ]]; then
	echo "==> Removing previous ocsid package link: $global_package"
	rm "$global_package"
fi

if [[ "$global_bin_target" == "$PACKAGE_DIR/dist/cli.js" ]] || [[ "$global_bin_target" == "$global_package/dist/cli.js" ]]; then
	echo "==> Removing previous ocsid command link: $global_bin"
	rm "$global_bin"
elif [[ -e "$global_bin" || -L "$global_bin" ]]; then
	echo "error: $global_bin already exists and does not point to this ocsid checkout" >&2
	echo "error: remove or rename that existing ocsid command, then rerun this script" >&2
	exit 1
fi

(
	cd "$PACKAGE_DIR"
	npm link --ignore-scripts
)

if ! command -v "$COMMAND_NAME" >/dev/null 2>&1; then
	global_prefix="$(npm prefix --global)"
	echo "error: npm linked ocsid, but $COMMAND_NAME is not on PATH" >&2
	echo "error: add $global_prefix/bin to PATH and rerun this script" >&2
	exit 1
fi

echo "==> Verifying linked CLI"
"$COMMAND_NAME" --version
"$COMMAND_NAME" --help >/dev/null

echo "==> Done"
echo "ocsid is built from source and linked globally. Try: ocsid --help"

