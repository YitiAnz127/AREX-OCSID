#!/usr/bin/env sh
set -eu

# DisCo managed installer for macOS, Linux, WSL, and other Unix-like shells.
# It installs the published npm package into a private release tree and never
# replaces an unrelated `disco` command.
#
# NOTE: This installer installs the published upstream package
# `@arex-skill/disco`. It does NOT install the local `ocsid` CLI build from the
# arex-test repo, because `ocsid` is not published to npm yet. To run the local
# build, use `cli/` directly (npm install && npm run build && npm link).

PACKAGE_NAME="@arex-skill/disco"
DEFAULT_NODE_VERSION="22.19.0"
DEFAULT_INSTALLER_URL="https://github.com/VectorSpaceLab/AREX-Skill/releases/latest/download/install-disco.sh"

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
DisCo managed installer

Usage:
  install-disco.sh [--version VERSION] [--install-dir DIR]
  install-disco.sh --update [--version VERSION]
  install-disco.sh --uninstall [--install-dir DIR]

Environment:
  DISCO_CODING_AGENT_DIR      Override ~/.disco/agent
  DISCO_INSTALL_DIR           Override the managed install directory
  DISCO_NPM_REGISTRY          Use an alternate npm registry
  DISCO_MANAGED_NODE_VERSION  Node.js version used when node is absent
  DISCO_INSTALLER_URL         URL used to persist the updater script
EOF
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

absolute_path() {
	case "$1" in
		"~/"*) printf '%s/%s\n' "${HOME:?HOME is not set}" "${1#\~/}" ;;
		/* | [A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$(pwd)" "$1" ;;
	esac
}

# Lexically resolve "." and ".." segments and drop trailing separators, without
# touching the filesystem and without resolving symlinks. Assumes an absolute
# input. A lexical result is sufficient because the install root is rejected
# when it is a symlink, and it keeps this script portable to POSIX sh:
# `realpath -m` is GNU-only and `readlink -f` is absent on older macOS.
normalize_path() {
	_remaining="$1"
	_result=""
	while [ -n "$_remaining" ]; do
		case "$_remaining" in
			/*) _remaining="${_remaining#/}" ;;
		esac
		case "$_remaining" in
			*/*)
				_segment="${_remaining%%/*}"
				_remaining="${_remaining#*/}"
				;;
			*)
				_segment="$_remaining"
				_remaining=""
				;;
		esac
		case "$_segment" in
			"" | ".") : ;;
			"..")
				case "$_result" in
					*/*) _result="${_result%/*}" ;;
					*) _result="" ;;
				esac
				;;
			*) _result="$_result/$_segment" ;;
		esac
	done
	if [ -z "$_result" ]; then
		printf '/\n'
	else
		printf '%s\n' "$_result"
	fi
}

validate_install_dir() {
	# Compare normalized forms so equivalent spellings of the same directory
	# ("$HOME/", "$HOME//", "$HOME/.", "$AGENT_DIR/sub/..") cannot slip past this
	# guard and turn the uninstall `rm -rf` into a home-directory wipe.
	_install_normalized="$(normalize_path "$INSTALL_DIR")"
	_home_normalized="$(normalize_path "$(absolute_path "${HOME:?HOME is not set}")")"
	_tmpdir_normalized="$(normalize_path "$(absolute_path "${TMPDIR:-/tmp}")")"

	case "$_install_normalized" in
		"" | "/" | "$_home_normalized" | "$AGENT_DIR" | "$_tmpdir_normalized")
			die "refusing to use a broad managed install directory: $INSTALL_DIR"
			;;
	esac

	# Refuse an ancestor of HOME or of the agent directory: uninstalling such a
	# root would delete the user's home directory, or credentials and sessions
	# under the agent directory, while reporting that they were preserved.
	case "$_home_normalized/" in
		"$_install_normalized"/*)
			die "refusing a managed install directory that contains HOME: $INSTALL_DIR"
			;;
	esac
	case "$AGENT_DIR/" in
		"$_install_normalized"/*)
			die "refusing a managed install directory that contains the agent directory: $INSTALL_DIR"
			;;
	esac

	# Refuse top-level directories such as /etc, /usr or /var: a managed install
	# root is expected to be a dedicated child directory.
	case "$_install_normalized" in
		/*/*) : ;;
		*) die "refusing a top-level managed install directory: $INSTALL_DIR" ;;
	esac
}

resolve_existing_path() {
	if command_exists realpath; then
		realpath "$1" 2>/dev/null && return
	fi
	if command_exists readlink; then
		readlink -f "$1" 2>/dev/null && return
	fi
	printf '%s\n' "$1"
}

shell_quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

sha256_file() {
	if command_exists sha256sum; then
		sha256sum "$1" | awk '{print $1}'
		return
	fi
	if command_exists shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
		return
	fi
	if command_exists openssl; then
		openssl dgst -sha256 "$1" | awk -F'= ' '{print $2}'
		return
	fi
	die "no SHA-256 implementation found; install sha256sum, shasum, or openssl"
}

download_file() {
	url="$1"
	destination="$2"
	if command_exists curl; then
		curl -fL --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 1 --connect-timeout 15 --silent --show-error "$url" -o "$destination"
		return
	fi
	if command_exists wget; then
		wget --https-only --tries=3 --timeout=15 -O "$destination" "$url"
		return
	fi
	die "curl or wget is required to download DisCo"
}

validate_version() {
	awk -v version="$1" 'BEGIN { exit (version ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) ? 0 : 1 }' || die "invalid DisCo version: $1"
}

node_version_is_sufficient() {
	awk -v version="$1" 'BEGIN {
		if (version !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1;
		split(version, p, "."); major=p[1]+0; minor=p[2]+0; patch=p[3]+0;
		if (major > 22 || (major == 22 && minor > 19) || (major == 22 && minor == 19 && patch >= 0)) exit 0;
		exit 1;
	}'
}

resolve_node_runtime() {
	if command_exists node && command_exists npm; then
		candidate_node="$(command -v node)"
		candidate_version="$($candidate_node --version 2>/dev/null | sed 's/^v//' || true)"
		if [ -n "$candidate_version" ] && node_version_is_sufficient "$candidate_version"; then
			NODE_PATH="$candidate_node"
			NPM_PATH="$(command -v npm)"
			NODE_SOURCE=system
			NODE_VERSION="$candidate_version"
			return
		fi
	fi

	command_exists curl || command_exists wget || die "Node.js >=22.19.0 is unavailable and curl/wget is missing"
	command_exists tar || die "tar is required to install a managed Node.js runtime"
	command_exists awk || die "awk is required to verify the managed Node.js checksum"
	managed_node_version="${DISCO_MANAGED_NODE_VERSION:-$DEFAULT_NODE_VERSION}"
	validate_version "$managed_node_version"
	node_version_is_sufficient "$managed_node_version" || die "managed Node.js version must be >=22.19.0: $managed_node_version"
	case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
		linux) node_os=linux ;;
		darwin) node_os=darwin ;;
		*) die "managed Node.js is not supported on $(uname -s)" ;;
	esac
	case "$(uname -m)" in
		x86_64|amd64) node_arch=x64 ;;
		aarch64|arm64) node_arch=arm64 ;;
		*) die "managed Node.js is not supported on $(uname -m)" ;;
	esac

	node_root="$INSTALL_DIR/node/v$managed_node_version"
	managed_node="$node_root"
	if [ -x "$managed_node/bin/node" ] && [ -x "$managed_node/bin/npm" ]; then
		managed_version="$($managed_node/bin/node --version 2>/dev/null | sed 's/^v//' || true)"
		if [ "$managed_version" = "$managed_node_version" ]; then
			NODE_PATH="$managed_node/bin/node"
			NPM_PATH="$managed_node/bin/npm"
			NODE_SOURCE=managed
			NODE_VERSION="$managed_node_version"
			return
		fi
	fi

	tmp_node="$TMP_DIR/node"
	mkdir -p "$tmp_node"
	archive_name="node-v$managed_node_version-$node_os-$node_arch.tar.gz"
	download_file "https://nodejs.org/dist/v$managed_node_version/$archive_name" "$tmp_node/$archive_name" || die "failed to download Node.js $managed_node_version"
	download_file "https://nodejs.org/dist/v$managed_node_version/SHASUMS256.txt" "$tmp_node/SHASUMS256.txt" || die "failed to download Node.js checksum manifest"
	expected_checksum="$(awk -v file="$archive_name" '$2 == file { print $1; exit }' "$tmp_node/SHASUMS256.txt")"
	[ -n "$expected_checksum" ] || die "Node.js checksum manifest does not contain $archive_name"
	[ "$(sha256_file "$tmp_node/$archive_name")" = "$expected_checksum" ] || die "Node.js checksum mismatch for $archive_name"
	mkdir -p "$tmp_node/extracted"
	tar -xzf "$tmp_node/$archive_name" -C "$tmp_node/extracted"
	extracted_root="$tmp_node/extracted/node-v$managed_node_version-$node_os-$node_arch"
	[ -x "$extracted_root/bin/node" ] && [ -x "$extracted_root/bin/npm" ] || die "downloaded Node.js archive is incomplete"
	mkdir -p "$INSTALL_DIR/node"
	if [ -e "$node_root.new" ]; then rm -rf "$node_root.new"; fi
	mv "$extracted_root" "$node_root.new"
	if [ -e "$node_root" ]; then rm -rf "$node_root"; fi
	mv "$node_root.new" "$node_root"
	NODE_PATH="$node_root/bin/node"
	NPM_PATH="$node_root/bin/npm"
	NODE_SOURCE=managed
	NODE_VERSION="$managed_node_version"
}

resolve_package_version() {
	if [ -z "$REQUESTED_VERSION" ] || [ "$REQUESTED_VERSION" = latest ]; then
		if [ -n "${DISCO_NPM_REGISTRY:-}" ]; then
			version="$($NPM_PATH view "$PACKAGE_NAME@latest" version --json --registry "$DISCO_NPM_REGISTRY" 2>/dev/null | tr -d '"[:space:]' || true)"
		else
			version="$($NPM_PATH view "$PACKAGE_NAME@latest" version --json 2>/dev/null | tr -d '"[:space:]' || true)"
		fi
		[ -n "$version" ] || die "could not resolve the latest $PACKAGE_NAME version from npm"
		REQUESTED_VERSION="$version"
	fi
	validate_version "$REQUESTED_VERSION"
}

prepend_node_bin_to_path() {
	node_bin_dir="${NODE_PATH%/*}"
	case ":${PATH:-}:" in
		*":$node_bin_dir:"*) : ;;
		*) PATH="$node_bin_dir${PATH:+:$PATH}"; export PATH ;;
	esac
}

# The updater is persisted on disk and re-executed for every future --update, so
# an unverified download becomes a durable trust anchor for this installation.
# Verify it against the release SHA256SUMS whenever that file is published next
# to the installer; a mismatch is fatal, an unavailable or incomplete checksum
# file degrades to a warning so mirrors without one keep working.
verify_persisted_installer() {
	installer_url="$1"
	checksum_url=""
	case "$installer_url" in
		*/install-disco.sh) checksum_url="${installer_url%/install-disco.sh}/SHA256SUMS" ;;
	esac
	if [ -z "$checksum_url" ]; then
		echo "warning: cannot derive a checksum URL from $installer_url; the managed updater was not verified" >&2
		return 0
	fi
	checksum_file="$TMP_DIR/SHA256SUMS"
	if ! download_file "$checksum_url" "$checksum_file" 2>/dev/null; then
		echo "warning: could not fetch $checksum_url; the managed updater was not verified" >&2
		return 0
	fi
	expected="$(awk '$2 == "install-disco.sh" || $2 == "*install-disco.sh" { print $1; exit }' "$checksum_file")"
	if [ -z "$expected" ]; then
		echo "warning: $checksum_url has no entry for install-disco.sh; the managed updater was not verified" >&2
		return 0
	fi
	actual="$(sha256_file "$INSTALLER_PATH")"
	if [ "$actual" != "$expected" ]; then
		die "managed updater checksum mismatch: expected $expected, got $actual"
	fi
}

ensure_persisted_installer() {
	INSTALLER_PATH="$INSTALL_DIR/install-disco.sh"
	case "$0" in
		sh|bash|-sh|-bash|/bin/sh|/bin/bash|/dev/fd/*) use_download=1 ;;
		*) use_download=0 ;;
	esac
	if [ "$use_download" -eq 0 ] && [ -f "$0" ]; then
		source_path="$(resolve_existing_path "$0")"
		destination_path="$(resolve_existing_path "$INSTALLER_PATH")"
		if [ "$source_path" != "$destination_path" ]; then cp "$0" "$INSTALLER_PATH"; fi
	else
		installer_url="${DISCO_INSTALLER_URL:-$DEFAULT_INSTALLER_URL}"
		download_file "$installer_url" "$INSTALLER_PATH" || die "could not persist the managed updater"
		verify_persisted_installer "$installer_url"
	fi
	chmod 700 "$INSTALLER_PATH"
}

write_atomic() {
	destination="$1"
	content="$2"
	# Create the temporary file with mktemp instead of a predictable PID-suffixed
	# name. On a shared or NFS install root another local user can pre-create that
	# name as a symlink, so a plain `>` redirect would clobber any file this user
	# can write, and the `mv -f` below would run without any existing-file check.
	if ! temporary="$(mktemp "$destination.XXXXXX" 2>/dev/null)"; then
		return 1
	fi
	if ! printf '%s' "$content" > "$temporary"; then
		rm -f "$temporary"
		return 1
	fi
	if ! mv -f "$temporary" "$destination"; then
		rm -f "$temporary"
		return 1
	fi
}

backup_file() {
	source="$1"
	destination="$2"
	if [ -e "$source" ] || [ -L "$source" ]; then
		if ! cp -p "$source" "$destination"; then
			return 1
		fi
		return 0
	fi
	return 1
}

restore_file() {
	destination="$1"
	backup="$2"
	was_present="$3"
	if [ "$was_present" -eq 1 ]; then
		if ! cp -p "$backup" "$destination"; then
			return 1
		fi
	else
		if ! rm -f "$destination"; then
			return 1
		fi
	fi
}

write_launcher() {
	launcher_dir="$AGENT_DIR/bin"
	launcher="$launcher_dir/disco"
	mkdir -p "$launcher_dir"
	if [ -e "$launcher" ] || [ -L "$launcher" ]; then
		if ! grep -Fq "$INSTALL_DIR" "$launcher" 2>/dev/null; then
			printf 'error: %s already exists and is not owned by the DisCo managed installer\n' "$launcher" >&2
			return 1
		fi
	fi
	# mktemp rather than a predictable `$launcher.$$`: the write below follows
	# symlinks, so on a shared install root another local user could pre-create the
	# name as a link and have this clobber a file the installing user can write.
	if ! launcher_tmp="$(mktemp "$launcher.XXXXXX" 2>/dev/null)"; then
		printf 'error: cannot create a temporary launcher next to %s\n' "$launcher" >&2
		return 1
	fi
	install_literal="$(shell_quote "$INSTALL_DIR")"
	agent_literal="$(shell_quote "$AGENT_DIR")"
if ! cat > "$launcher_tmp" <<EOF
#!/usr/bin/env sh
set -eu
INSTALL_DIR=$install_literal
AGENT_DIR=$agent_literal
CURRENT_FILE="\$INSTALL_DIR/current-version"
NODE_FILE="\$INSTALL_DIR/node-path"
MARKER="\$INSTALL_DIR/managed-install.json"
[ -s "\$CURRENT_FILE" ] || { echo "error: DisCo managed install has no current release" >&2; exit 1; }
current=\$(tr -d '\\r\\n' < "\$CURRENT_FILE")
case "\$current" in ''|*[!A-Za-z0-9._+-]*) echo "error: invalid DisCo managed release pointer" >&2; exit 1;; esac
node_path=\$(tr -d '\\r\\n' < "\$NODE_FILE" 2>/dev/null || true)
[ -x "\$node_path" ] || node_path=\$(command -v node 2>/dev/null || true)
[ -x "\$node_path" ] || { echo "error: managed Node.js runtime is missing" >&2; exit 1; }
release="\$INSTALL_DIR/releases/\$current"
entrypoint="\$release/node_modules/@arex-skill/disco/dist/cli.js"
[ -f "\$MARKER" ] || { echo "error: invalid DisCo managed install marker" >&2; exit 1; }
grep -Fq '"packageName": "@arex-skill/disco"' "\$MARKER" || { echo "error: invalid DisCo managed package marker" >&2; exit 1; }
[ -f "\$entrypoint" ] || { echo "error: DisCo managed release \$current is incomplete" >&2; exit 1; }
export DISCO_MANAGED_INSTALL=1
export DISCO_MANAGED_INSTALL_DIR="\$INSTALL_DIR"
export DISCO_MANAGED_INSTALLER="\$INSTALL_DIR/install-disco.sh"
export DISCO_MANAGED_INSTALL_MARKER="\$MARKER"
export DISCO_CODING_AGENT_DIR="\$AGENT_DIR"
exec "\$node_path" "\$entrypoint" "\$@"
EOF
then
	rm -f "$launcher_tmp"
	return 1
fi
	if ! chmod 700 "$launcher_tmp"; then
		rm -f "$launcher_tmp"
		return 1
	fi
	if ! mv -f "$launcher_tmp" "$launcher"; then
		rm -f "$launcher_tmp"
		return 1
	fi
}

write_marker() {
	package_dir="$1"
	install_escaped="$(json_escape "$INSTALL_DIR")"
	entrypoint_escaped="$(json_escape "$package_dir/dist/cli.js")"
	node_escaped="$(json_escape "$NODE_PATH")"
	installer_escaped="$(json_escape "$INSTALLER_PATH")"
	# mktemp rather than a predictable `managed-install.json.tmp.$$` for the same
	# reason as the launcher above: the write follows symlinks.
	#
	# This must report failure with `return 1`, never `die`. `write_marker` is
	# called as `write_marker ... || activation_failed=1` while the previous
	# release sits in "$TMP_DIR/previous-release" and the cleanup trap is armed;
	# exiting here would skip the rollback below and then let the trap delete the
	# only copy of the previous release.
	if ! marker_tmp="$(mktemp "$INSTALL_DIR/managed-install.json.XXXXXX" 2>/dev/null)"; then
		printf 'error: cannot create a temporary install marker in %s\n' "$INSTALL_DIR" >&2
		return 1
	fi
if ! cat > "$marker_tmp" <<EOF
{
  "schemaVersion": 1,
  "packageName": "$PACKAGE_NAME",
  "activeVersion": "$REQUESTED_VERSION",
  "installDir": "$install_escaped",
  "entrypoint": "$entrypoint_escaped",
  "nodeSource": "$NODE_SOURCE",
  "nodeVersion": "$NODE_VERSION",
  "nodePath": "$node_escaped",
  "installerPath": "$installer_escaped",
  "platform": "$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
}
EOF
then
	rm -f "$marker_tmp"
	return 1
fi
	if ! mv -f "$marker_tmp" "$INSTALL_DIR/managed-install.json"; then
		rm -f "$marker_tmp"
		return 1
	fi
}

check_command_conflict() {
	existing="$(command -v disco 2>/dev/null || true)"
	if [ -z "$existing" ]; then
		return 0
	fi
	existing_real="$(resolve_existing_path "$existing")"
	launcher_real="$(resolve_existing_path "$AGENT_DIR/bin/disco")"
	if [ "$existing_real" != "$launcher_real" ] && [ "$existing" != "$AGENT_DIR/bin/disco" ]; then
		die "disco already resolves to $existing; refusing to overwrite an unrelated installation"
	fi
}

acquire_lock() {
	LOCK_DIR="$INSTALL_DIR/.lock"
	if mkdir "$LOCK_DIR" 2>/dev/null; then
		printf '%s\n' "$$" > "$LOCK_DIR/pid"
		return
	fi

	# Only the EXIT/INT/TERM trap removes the lock, so an installer killed with
	# SIGKILL or a power loss leaves it behind and every later install, --update
	# and --uninstall fails until the user deletes the directory by hand. Recover
	# the lock when its recorded holder is gone; a lock with no pid file is only
	# treated as abandoned once it is old enough that its creator cannot still be
	# mid-acquire.
	stale_pid=""
	if [ -f "$LOCK_DIR/pid" ]; then
		stale_pid="$(tr -d '[:space:]' < "$LOCK_DIR/pid" 2>/dev/null || true)"
	fi
	if [ -n "$stale_pid" ]; then
		# A holder that still answers kill -0 is running.
		if kill -0 "$stale_pid" 2>/dev/null; then
			die "another DisCo managed installer (pid $stale_pid) is already modifying $INSTALL_DIR"
		fi
		# kill -0 also fails with EPERM when the holder is alive but owned by another
		# user (an install run under sudo in a shared root). /proc distinguishes that
		# on Linux, so a live lock is not reclaimed out from under its holder.
		if [ -d "/proc/$stale_pid" ]; then
			die "another DisCo managed installer (pid $stale_pid) is already modifying $INSTALL_DIR"
		fi
	fi
	# No pid file: only an old lock can be abandoned, since its creator may still be
	# between mkdir and writing its pid.
	if [ -z "$stale_pid" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin -5 2>/dev/null)" ]; then
		die "another DisCo managed installer is already modifying $INSTALL_DIR"
	fi

	# Reclaim by renaming the abandoned lock aside. `mv` to a unique name succeeds
	# for exactly one waiter, whereas testing staleness and then `rm -rf`-ing is a
	# TOCTOU: between the check and the removal another installer can create a
	# fresh lock, which this process then deletes, leaving two installers writing
	# into $INSTALL_DIR at once.
	lock_graveyard="$LOCK_DIR.stale.$$"
	if ! mv "$LOCK_DIR" "$lock_graveyard" 2>/dev/null; then
		die "another DisCo managed installer is already modifying $INSTALL_DIR"
	fi
	# Re-check what was actually taken. If a live installer re-created the lock
	# between the test above and the rename, the directory moved aside belongs to
	# it: put it back rather than delete a live lock.
	if [ -f "$lock_graveyard/pid" ]; then
		taken_pid="$(tr -d '[:space:]' < "$lock_graveyard/pid" 2>/dev/null || true)"
		if [ -n "$taken_pid" ] && [ "$taken_pid" != "$stale_pid" ]; then
			mv "$lock_graveyard" "$LOCK_DIR" 2>/dev/null || rm -rf "$lock_graveyard"
			die "another DisCo managed installer (pid $taken_pid) is already modifying $INSTALL_DIR"
		fi
	fi
	echo "warning: recovering the stale installer lock at $LOCK_DIR" >&2
	rm -rf "$lock_graveyard"
	if ! mkdir "$LOCK_DIR" 2>/dev/null; then
		die "another DisCo managed installer is already modifying $INSTALL_DIR"
	fi
	printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

cleanup() {
	if [ -n "${RELEASE_STAGE:-}" ] && [ -e "$RELEASE_STAGE" ]; then rm -rf "$RELEASE_STAGE"; fi
	# Remove the lock only while this process still owns it; a lock reclaimed by a
	# later installer must not be deleted by this one's exit trap.
	if [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ]; then
		owner_pid="$(tr -d '[:space:]' < "$LOCK_DIR/pid" 2>/dev/null || true)"
		if [ -z "$owner_pid" ] || [ "$owner_pid" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
	fi
	if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

uninstall_managed_install() {
	marker="$INSTALL_DIR/managed-install.json"
	[ -f "$marker" ] || die "$INSTALL_DIR is not a recognized DisCo managed install"
	grep -Fq '"packageName": "@arex-skill/disco"' "$marker" || die "managed install marker package name does not match $PACKAGE_NAME"
	if [ -f "$AGENT_DIR/bin/disco" ] && grep -Fq "$INSTALL_DIR" "$AGENT_DIR/bin/disco" 2>/dev/null; then rm -f "$AGENT_DIR/bin/disco"; fi
	rm -rf "$INSTALL_DIR"
	printf 'Removed DisCo managed files under %s; user settings, credentials, sessions, and skills were preserved.\n' "$INSTALL_DIR"
}

install_release() {
	mkdir -p "$INSTALL_DIR/releases"
	RELEASE_STAGE="$INSTALL_DIR/releases/.stage-$REQUESTED_VERSION-$$"
	release_dir="$INSTALL_DIR/releases/$REQUESTED_VERSION"
	rm -rf "$RELEASE_STAGE"
	mkdir -p "$RELEASE_STAGE"
	if [ -n "${DISCO_NPM_REGISTRY:-}" ]; then
		"$NPM_PATH" install --prefix "$RELEASE_STAGE" --ignore-scripts --omit=dev --no-audit --no-fund "$PACKAGE_NAME@$REQUESTED_VERSION" --registry "$DISCO_NPM_REGISTRY" || die "failed to install $PACKAGE_NAME@$REQUESTED_VERSION"
	else
		"$NPM_PATH" install --prefix "$RELEASE_STAGE" --ignore-scripts --omit=dev --no-audit --no-fund "$PACKAGE_NAME@$REQUESTED_VERSION" || die "failed to install $PACKAGE_NAME@$REQUESTED_VERSION"
	fi
	package_dir="$RELEASE_STAGE/node_modules/@arex-skill/disco"
	[ -f "$package_dir/package.json" ] && [ -f "$package_dir/dist/cli.js" ] || die "managed npm install did not produce a complete DisCo package"
	actual_version="$($NODE_PATH -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version||""))' "$package_dir/package.json")"
	[ "$actual_version" = "$REQUESTED_VERSION" ] || die "managed package version mismatch: expected $REQUESTED_VERSION, got $actual_version"
	"$NODE_PATH" "$package_dir/dist/cli.js" --version >/dev/null || die "managed DisCo smoke check failed"

	old_release="$TMP_DIR/previous-release"
	old_marker="$TMP_DIR/previous-marker"
	old_current="$TMP_DIR/previous-current"
	old_node="$TMP_DIR/previous-node"
	old_launcher="$TMP_DIR/previous-launcher"
	old_release_present=0; old_marker_present=0; old_current_present=0; old_node_present=0; old_launcher_present=0
	if [ -e "$release_dir" ]; then mv "$release_dir" "$old_release"; old_release_present=1; fi
	if backup_file "$INSTALL_DIR/managed-install.json" "$old_marker"; then old_marker_present=1; fi
	if backup_file "$INSTALL_DIR/current-version" "$old_current"; then old_current_present=1; fi
	if backup_file "$INSTALL_DIR/node-path" "$old_node"; then old_node_present=1; fi
	if backup_file "$AGENT_DIR/bin/disco" "$old_launcher"; then old_launcher_present=1; fi

	if ! mv "$RELEASE_STAGE" "$release_dir"; then
		[ "$old_release_present" -eq 1 ] && mv "$old_release" "$release_dir"
		die "could not activate managed DisCo release $REQUESTED_VERSION"
	fi
	package_dir="$release_dir/node_modules/@arex-skill/disco"
	activation_failed=0
	write_atomic "$INSTALL_DIR/node-path" "$(printf '%s\n' "$NODE_PATH")" || activation_failed=1
	if [ "$activation_failed" -eq 0 ]; then
		write_marker "$package_dir" || activation_failed=1
	fi
	if [ "$activation_failed" -eq 0 ]; then
		write_launcher || activation_failed=1
	fi
	if [ "$activation_failed" -eq 0 ]; then
		write_atomic "$INSTALL_DIR/current-version" "$(printf '%s\n' "$REQUESTED_VERSION")" || activation_failed=1
	fi
	if [ "$activation_failed" -ne 0 ]; then
		rm -rf "$release_dir"
		[ "$old_release_present" -eq 1 ] && mv "$old_release" "$release_dir"
		restore_file "$INSTALL_DIR/managed-install.json" "$old_marker" "$old_marker_present"
		restore_file "$INSTALL_DIR/current-version" "$old_current" "$old_current_present"
		restore_file "$INSTALL_DIR/node-path" "$old_node" "$old_node_present"
		restore_file "$AGENT_DIR/bin/disco" "$old_launcher" "$old_launcher_present"
		die "could not activate managed DisCo release $REQUESTED_VERSION; previous release restored"
	fi
	RELEASE_STAGE=""
}

REQUESTED_VERSION=""
INSTALL_DIR=""
UPDATE=0
UNINSTALL=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		--help|-h) usage; exit 0 ;;
		--yes) shift ;;
		--update) UPDATE=1; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		--version) [ "$#" -ge 2 ] || die "--version requires a value"; REQUESTED_VERSION="$2"; shift 2 ;;
		--install-dir) [ "$#" -ge 2 ] || die "--install-dir requires a value"; INSTALL_DIR="$2"; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done

AGENT_DIR="${DISCO_CODING_AGENT_DIR:-${HOME:?HOME is not set}/.disco/agent}"
AGENT_DIR="$(normalize_path "$(absolute_path "$AGENT_DIR")")"
if [ -n "${DISCO_INSTALL_DIR:-}" ] && [ -z "$INSTALL_DIR" ]; then INSTALL_DIR="$DISCO_INSTALL_DIR"; fi
INSTALL_DIR="$(normalize_path "$(absolute_path "${INSTALL_DIR:-$AGENT_DIR/install}")")"
validate_install_dir
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/disco-install.XXXXXX")"
LOCK_DIR=""
RELEASE_STAGE=""
trap cleanup 0 1 2 3 15

if [ "$UNINSTALL" -eq 1 ]; then
	[ -d "$INSTALL_DIR" ] || die "$INSTALL_DIR is not a recognized DisCo managed install"
	acquire_lock
	uninstall_managed_install
	exit 0
fi

mkdir -p "$INSTALL_DIR"
acquire_lock
if [ "$UPDATE" -eq 1 ]; then
	[ -f "$INSTALL_DIR/managed-install.json" ] || die "$INSTALL_DIR is not a recognized DisCo managed install"
	grep -Fq '"packageName": "@arex-skill/disco"' "$INSTALL_DIR/managed-install.json" || die "managed install marker package name does not match $PACKAGE_NAME"
fi
check_command_conflict
resolve_node_runtime
prepend_node_bin_to_path
resolve_package_version
ensure_persisted_installer
install_release

printf 'Installed %s@%s using %s Node.js under %s\n' "$PACKAGE_NAME" "$REQUESTED_VERSION" "$NODE_SOURCE" "$INSTALL_DIR"
printf 'DisCo launcher: %s\n' "$AGENT_DIR/bin/disco"
printf 'Add %s to PATH if it is not already present, then run: disco --version\n' "$AGENT_DIR/bin"
