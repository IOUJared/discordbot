import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const hex = (character, length) => character.repeat(length)

export function installOwnerAdapters(bin) {
  const adapters = {
    id: `#!/usr/bin/env bash
test "${"$"}{1:-}" = -u && printf '0\\n'
`,
    stat: `#!/usr/bin/env bash
if test "$*" = "-c %U:%G:%a $TEST_LOCK"; then printf 'root:root:600\\n'; else /usr/bin/stat "$@"; fi
`,
    curl: '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"status":"ok","discord":"ready","voice":"idle","uptime":10}\'\n',
    git: `#!/usr/bin/env bash
test "$1" = -C && test "$3 $4" = 'rev-parse HEAD'
printf '%s\\n' '${hex("3", 40)}'
`,
    docker: `#!/usr/bin/env bash
set -eu
state="$DOCKER_STATE"; mutations="$DOCKER_MUTATIONS"
replace_lease() {
  test -n "${"$"}{REPLACE_LEASE_WITH:-}" && test ! -e "$REPLACEMENT_MARKER" || return 0
  /usr/bin/cp "$REPLACE_LEASE_WITH" "$LEASE_PATH.replacement"
  /usr/bin/mv -f "$LEASE_PATH.replacement" "$LEASE_PATH"
  : >"$REPLACEMENT_MARKER"
}
lease_is_active() { jq -e '.state=="active"' "$LEASE_PATH" >/dev/null 2>&1; }
if test "$1" = ps; then
  case "$*" in
    *com.docker.compose.service=server*) printf 'server-container\\n'; exit 0 ;;
    *com.docker.compose.service=media-sidecar*) printf 'sidecar-container\\n'; exit 0 ;;
  esac
  if test -n "${"$"}{REPLACE_LEASE_WITH:-}" && test "${"$"}{MEDIA_OWNER_TEST_REPLACE_PHASE:-initial-ps}" = initial-ps && test ! -e "$REPLACEMENT_MARKER"; then
    replace_lease
  fi
  test -z "${"$"}{IN_USE_IMAGE:-}" || printf 'current-container\\n'
  exit 0
fi
if test "$1" = inspect; then
  if test "${"$"}{2:-}" = -f; then
    format="$3"; target="$4"
    case "$format:$target" in
      '{{index .Config.Labels "com.docker.compose.project.config_files"}}:server-container') printf '%s\\n' "$TEST_CONFIG" ;;
      '{{.Image}}:server-container') printf 'sha256:${hex("4", 64)}\\n' ;;
      '{{.Image}}:sidecar-container') printf 'sha256:${hex("5", 64)}\\n' ;;
      '{{.Image}}:current-container') printf '%s\\n' "$IN_USE_IMAGE" ;;
      '{{.Config.Image}}:server-container') printf 'discord-music-server:${hex("3", 40)}\\n' ;;
      '{{.Config.Image}}:sidecar-container') printf 'discord-music-media-sidecar:${hex("3", 40)}\\n' ;;
      *) exit 1 ;;
    esac
  elif test "$2" = server-container; then
    printf '%s\\n' '[{"Mounts":[{"Type":"volume","Name":"discord-data","Destination":"/app/data"}]}]'
  else exit 1; fi
  exit 0
fi
if test "$1 $2" = 'image inspect'; then
  if test "$3" = -f; then format="$4"; target="$5"; else target="$3"; format=exists; fi
  if lease_is_active; then
    case "${"$"}{MEDIA_OWNER_TEST_REPLACE_PHASE:-}:$target" in
      repair-tag-inspect:discord-music-rollback:*) replace_lease ;;
      repair-source-inspect:sha256:*) replace_lease ;;
    esac
    if test "${"$"}{MISSING_REPAIR_TAG:-0}" = 1; then case "$target" in discord-music-rollback:*) exit 1;; esac; fi
  fi
  row="$(awk -F '\\t' -v target="$target" '$1==target {print; exit}' "$state")"
  test -n "$row" || exit 1
  id="$(printf '%s' "$row" | cut -f2)"; revision="$(printf '%s' "$row" | cut -f3)"
  if test "${"$"}{TAG_MISMATCH:-0}" = 1 && case "$target" in *-server) true;; *) false;; esac; then id="sha256:${hex("f", 64)}"; fi
  test "${"$"}{WRONG_REVISION:-0}" != 1 || revision="${hex("e", 40)}"
  case "$format" in
    exists) : ;;
    '{{.Id}}') printf '%s\\n' "$id" ;;
    '{{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s\\n' "$revision" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$1 $2" in
  'image rm') test "${"$"}{MEDIA_OWNER_TEST_REPLACE_PHASE:-}" != retention-apply || replace_lease; printf '%s\\n' "$*" >>"$mutations"; exit 0 ;;
  'image tag') test "${"$"}{MEDIA_OWNER_TEST_REPLACE_PHASE:-}" != repair-tag || replace_lease; printf '%s\\n' "$*" >>"$mutations"; exit 0 ;;
  'container rm'|'volume rm') printf '%s\\n' "$*" >>"$mutations"; exit 0 ;;
esac
printf '%s\\n' "$*" >>"$mutations"; exit 1
`,
  }
  for (const [command, source] of Object.entries(adapters)) {
    writeFileSync(join(bin, command), source)
    chmodSync(join(bin, command), 0o700)
  }
}
