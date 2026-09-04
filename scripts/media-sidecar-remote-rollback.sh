#!/usr/bin/env bash
# allow: SIZE_OK - this is one security-critical lease and rollback state machine.
set -Eeuo pipefail
umask 077

readonly MS_SCHEMA="discord-music-deploy-lease.v1"
readonly MS_TEST_ROOT="${MEDIA_OWNER_TEST_ROOT:-}"
readonly MS_REPO="${MEDIA_REPO:-$MS_TEST_ROOT/opt/discord-music}"
readonly MS_BACKUP="${MEDIA_BACKUP_ROOT:-$MS_TEST_ROOT/root/discord-music-rollbacks}"
readonly MS_LOCK="${MEDIA_LOCK_FILE:-$MS_TEST_ROOT/run/lock/discord-music-deploy.lock}"
readonly MS_LEASE="${MEDIA_LEASE_FILE:-$MS_BACKUP/active.json}"
readonly MS_COUNTER="${MEDIA_RUN_COUNTER:-$MS_BACKUP/run-counter}"
readonly MS_PROJECT="${MEDIA_COMPOSE_PROJECT:-}"
readonly MS_SHA="${MEDIA_SELECTED_SHA:-}"
readonly MS_OWNER_B64="${MEDIA_OWNER_B64:-}"
readonly MS_DEADLINE_SECONDS="${MEDIA_DEADLINE_SECONDS:-600}"
readonly MS_SELF="${BASH_SOURCE[0]:-/dev/stdin}"
readonly MS_RETENTION_DAYS="${MEDIA_RETENTION_DAYS:-7}"
readonly MS_DANGLING_RETENTION_DAYS="${MEDIA_DANGLING_RETENTION_DAYS:-1}"
readonly MS_LEASE_TEMP_STALE_SECONDS=300
readonly MS_EXPECT_UID="${MEDIA_OWNER_TEST_UID:-0}"

die() { printf '{"ok":false,"stage":"%s"}\n' "$1" >&2; exit 1; }
boottime() { awk '{printf "%d", $1}' /proc/uptime; }
atomic_file() {
  local target="$1" mode="$2" verify="${3:-false}" temp
  temp="${target}.tmp.$$"
  cat >"$temp"
  chmod "$mode" "$temp"
  sync -f "$temp"
  test "$verify" != true || verify_prior_lease_locked
  mv -f "$temp" "$target"
  sync -f "$(dirname "$target")"
}
strict_json_file() {
  python3 - "$1" 2>/dev/null <<'PY'
import json
import sys

def unique_object(pairs):
    value = {}
    for key, member in pairs:
        if key in value:
            raise ValueError("duplicate object member")
        value[key] = member
    return value

def invalid_constant(_value):
    raise ValueError("non-JSON numeric constant")

with open(sys.argv[1], encoding="utf-8") as source:
    json.load(source, object_pairs_hook=unique_object, parse_constant=invalid_constant)
PY
}
secure_owner_path() {
  python3 - "$MS_TEST_ROOT" "$MS_BACKUP" "$1" "$MS_EXPECT_UID" "$2" 2>/dev/null <<'PY'
import os
import stat
import sys

anchor_value, backup_value, target_value, uid_value, kind = sys.argv[1:]
anchor = os.path.abspath(anchor_value or "/")
backup = os.path.abspath(backup_value)
target = os.path.abspath(target_value)
uid = int(uid_value)

def fail():
    raise ValueError("unsafe owner path")

def inspect(path, expected_kind, exact_mode=None):
    value = os.lstat(path)
    if stat.S_ISLNK(value.st_mode) or value.st_uid != uid:
        fail()
    if expected_kind == "directory" and not stat.S_ISDIR(value.st_mode):
        fail()
    if expected_kind == "file" and not stat.S_ISREG(value.st_mode):
        fail()
    mode = stat.S_IMODE(value.st_mode)
    if exact_mode is not None and mode != exact_mode:
        fail()
    if expected_kind == "directory" and mode & 0o022:
        fail()

if os.path.commonpath((anchor, backup)) != anchor:
    fail()
current = anchor
inspect(current, "directory")
for component in os.path.relpath(backup, anchor).split(os.sep):
    if component in {"", ".", ".."}:
        fail()
    current = os.path.join(current, component)
    inspect(current, "directory", 0o700 if current == backup else None)
if kind == "lease":
    if os.path.dirname(target) != backup or os.path.basename(target) != "active.json":
        fail()
    inspect(target, "file", 0o600)
elif kind == "checkpoint":
    if os.path.dirname(target) != backup:
        fail()
    inspect(target, "directory", 0o700)
    if os.path.realpath(target) != target:
        fail()
    for name in ("manifest.json", "compose.yaml", "deploy.env"):
        inspect(os.path.join(target, name), "file", 0o600)
    terminal = os.path.join(target, "terminal.json")
    if os.path.lexists(terminal):
        inspect(terminal, "file", 0o600)
else:
    fail()
PY
}
verify_prior_lease_locked() {
  local observed_id observed_hash
  if test "$MS_PRIOR_LEASE_ID" = absent; then
    test ! -e "$MS_LEASE" && test ! -L "$MS_LEASE" || die lease-replaced
    return
  fi
  secure_owner_path "$MS_LEASE" lease || die lease-path-invalid
  observed_id="$(stat -c %d:%i "$MS_LEASE")" || die lease-replaced
  observed_hash="$(sha256sum "$MS_LEASE" | cut -d' ' -f1)" || die lease-replaced
  test "$observed_id" = "$MS_PRIOR_LEASE_ID" && test "$observed_hash" = "$MS_PRIOR_LEASE_HASH" || die lease-replaced
}
verify_prior_checkpoint_locked() {
  local observed_id
  test "$MS_PRIOR_CHECKPOINT_ID" != absent || return
  secure_owner_path "$MS_BACKUP/$MS_PRIOR_RUN_ID" checkpoint || die prior-checkpoint-replaced
  observed_id="$(stat -c %d:%i "$MS_BACKUP/$MS_PRIOR_RUN_ID")" || die prior-checkpoint-replaced
  test "$observed_id" = "$MS_PRIOR_CHECKPOINT_ID" || die prior-checkpoint-replaced
}
lease_value() { strict_json_file "$MS_LEASE" || die lease-json-invalid; jq -er "$1" "$MS_LEASE"; }
lease_write() { atomic_file "$MS_LEASE" 0600 "${1:-false}"; }
cleanup_retention_locked() {
  local current="${1:-}" cutoff candidate modified run_id manifest terminal containers container image role tag source resolved revision
  local -a candidates=() server_tags=() sidecar_tags=()
  cutoff="$(date -d "$MS_RETENTION_DAYS days ago" +%s)" || die retention-cutoff-invalid
  containers="$(docker ps -aq)" || die retention-container-list
  while IFS= read -r container; do
    test -n "$container" || continue
    image="$(docker inspect -f '{{.Image}}' "$container")" || die retention-container-inspect
    [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || die retention-container-image
    containers="${containers}"$'\n'"$image"
  done <<<"$containers"
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue
    run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    test "$run_id" != "$current" || continue
    test ! -L "$candidate" || die retention-archive-invalid
    modified="$(stat -c %Y "$candidate")" || die retention-archive-invalid
    test "$modified" -lt "$cutoff" || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"
    for file in "$manifest" "$terminal" "$candidate/compose.yaml" "$candidate/deploy.env"; do
      test -f "$file" && test ! -L "$file" || die retention-archive-invalid
    done
    validate_cleanup_archive "$manifest" "$terminal" "$run_id" || die retention-archive-invalid
    test "$(sha256sum "$candidate/compose.yaml"|cut -d' ' -f1)" = "$(jq -r .composeHash "$manifest")" || die retention-archive-invalid
    test "$(sha256sum "$candidate/deploy.env"|cut -d' ' -f1)" = "$(jq -r .envHash "$manifest")" || die retention-archive-invalid
    candidates+=("$candidate"); server_tags+=(""); sidecar_tags+=("")
    for role in server sidecar; do
      tag="$(jq -r --arg role "$role" '.rollbackTags[$role] // empty' "$manifest")"
      test -n "$tag" || continue
      source="$(jq -r --arg role "$role" '.priorState[($role+"Image")]' "$manifest")"
      grep -Fxq "$source" <<<"$containers" && die retention-image-in-use
      resolved="$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null || true)"
      test -n "$resolved" || continue
      [[ "$resolved" =~ ^sha256:[0-9a-f]{64}$ ]] || die retention-image-invalid
      test "$resolved" = "$source" || die retention-image-binding
      revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")" || die retention-image-revision
      test "$revision" = "$(jq -r .priorState.git "$manifest")" || die retention-image-revision
      grep -Fxq "$resolved" <<<"$containers" && die retention-image-in-use
      if test "$role" = server; then server_tags[-1]="$tag"; else sidecar_tags[-1]="$tag"; fi
    done
  done
  verify_prior_lease_locked
  verify_prior_checkpoint_locked
  for index in "${!candidates[@]}"; do
    test -z "${server_tags[$index]}" || docker image rm "${server_tags[$index]}" >/dev/null 2>&1 || true
    test -z "${sidecar_tags[$index]}" || docker image rm "${sidecar_tags[$index]}" >/dev/null 2>&1 || true
    rm -rf -- "${candidates[$index]}"
  done
}
cleanup_stale_lease_temps_locked() {
  local lease_validated="${1:-false}" candidate name pid now modified
  if test "$lease_validated" != true && test -r "$MS_LEASE"; then
    strict_json_file "$MS_LEASE" || die lease-json-invalid
    jq -e '(.state != "active") and (.restoreState != "restoring") and (.activeMutation == null)' "$MS_LEASE" >/dev/null || return 0
  fi
  now="$(date +%s)"
  while IFS= read -r -d '' candidate; do
    name="${candidate##*/}"; pid="${name##*.}"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    kill -0 "$pid" 2>/dev/null && continue
    test ! -s "$candidate" || continue
    test "$(stat -c %u:%a "$candidate")" = "$(id -u):600" || continue
    modified="$(stat -c %Y "$candidate")"
    test "$((now-modified))" -ge "$MS_LEASE_TEMP_STALE_SECONDS" || continue
    rm -f -- "$candidate"
  done < <(find "$(dirname "$MS_LEASE")" -maxdepth 1 -type f -name "$(basename "$MS_LEASE").tmp.*" -print0)
}
remove_new_untagged_images() {
  local before="$1" after="${before}.after" id tags
  docker images -q --no-trunc | sort -u >"$after"; chmod 0600 "$after"
  for _ in 1 2 3; do
    while read -r id; do
      test -n "$id" || continue
      tags="$(docker image inspect -f '{{json .RepoTags}}' "$id" 2>/dev/null || true)"; test "$tags" = null || test "$tags" = '[]' || continue
      docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
      docker image rm "$id" >/dev/null 2>&1 || true
    done < <(comm -13 "$before" "$after")
  done
  rm -f -- "$after"
}
require_root() { test "$(id -u)" -eq 0 || die root-required; }
require_paths() {
  if test -n "$MS_TEST_ROOT"; then
    [[ "$MS_TEST_ROOT" = /* && "$MS_TEST_ROOT" != / && "$MS_EXPECT_UID" =~ ^[0-9]+$ ]] || die test-root-invalid
  else
    test "$MS_EXPECT_UID" = 0 || die test-uid-forbidden
  fi
  test "$MS_REPO" = "$MS_TEST_ROOT/opt/discord-music" || die wrong-repository
  test "$MS_BACKUP" = "$MS_TEST_ROOT/root/discord-music-rollbacks" || die wrong-backup-root
  test "$MS_LOCK" = "$MS_TEST_ROOT/run/lock/discord-music-deploy.lock" || die wrong-lock
  test "$MS_LEASE" = "$MS_BACKUP/active.json" || die wrong-lease
  test "$MS_COUNTER" = "$MS_BACKUP/run-counter" || die wrong-counter
}
active_config() {
  local container config
  container="$(docker ps -q --filter "label=com.docker.compose.project=$MS_PROJECT" --filter label=com.docker.compose.service=server | head -1)"
  test -n "$container" || die server-container-missing
  config="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")"
  test -n "$config" || die compose-config-missing
  case "$config" in *,*) die multiple-compose-files-unsupported;; esac
  printf '%s' "$config"
}
mode_from_env() {
  local env_file="$1" value
  value="$(sed -n 's/^MEDIA_SIDECAR_MODE=//p' "$env_file" | tail -1)"
  printf '%s' "${value:-disabled}"
}
public_health() {
  local value
  value="$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health)"
  jq -ce 'if (keys|sort)==["discord","status","uptime","voice"] then . else error("health keys") end' <<<"$value"
}
repair_retained_tags_locked() {
  local cutoff candidate run_id manifest terminal role tag expected source repaired
  cutoff="$(date -d "$MS_RETENTION_DAYS days ago" +%s)"; repaired=0
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue; test "$(stat -c %Y "$candidate")" -ge "$cutoff" || continue
    run_id="${candidate##*/}"; [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"
    test -r "$manifest" && test -r "$terminal" || continue
    strict_json_file "$manifest" && strict_json_file "$terminal" || die retention-json-invalid
    jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" '.schema==$schema and .runId==$runId and (.selectedSha|test("^[0-9a-f]{40}$"))' "$manifest" >/dev/null || continue
    jq -e --arg runId "$run_id" '.runId==$runId and (.state=="committed" or (.state=="expired" and .restoreState=="restored"))' "$terminal" >/dev/null || continue
    test "$(sha256sum "$candidate/compose.yaml"|cut -d' ' -f1)" = "$(jq -r .composeHash "$manifest")" || continue
    test "$(sha256sum "$candidate/deploy.env"|cut -d' ' -f1)" = "$(jq -r .envHash "$manifest")" || continue
    for role in server sidecar; do
      tag="$(jq -r --arg role "$role" '.rollbackTags[$role] // empty' "$manifest")"; test -n "$tag" || continue
      expected="discord-music-rollback:$run_id-$role"; test "$tag" = "$expected" || die retention-tag-invalid
      docker image inspect "$tag" >/dev/null 2>&1 && continue
      source="$(jq -r --arg role "$role" '.priorState[($role+"Image")] // empty' "$manifest")"
      [[ "$source" =~ ^sha256:[0-9a-f]{64}$ ]] || die retention-source-invalid
      docker image inspect "$source" >/dev/null 2>&1 || die retention-source-missing
      docker image tag "$source" "$tag"; repaired=$((repaired+1))
    done
  done
  printf '%s\n' "$repaired"
}
state_json() {
  local config="$1" working env_file server sidecar server_image sidecar_image server_ref sidecar_ref volumes health mode
  working="$(dirname "$config")"; env_file="$working/.env"
  server="$(docker ps -q --filter "label=com.docker.compose.project=$MS_PROJECT" --filter label=com.docker.compose.service=server | head -1)"
  sidecar="$(docker ps -aq --filter "label=com.docker.compose.project=$MS_PROJECT" --filter label=com.docker.compose.service=media-sidecar | head -1)"
  server_image="$(test -n "$server" && docker inspect -f '{{.Image}}' "$server" || true)"
  sidecar_image="$(test -n "$sidecar" && docker inspect -f '{{.Image}}' "$sidecar" || true)"
  server_ref="$(test -n "$server" && docker inspect -f '{{.Config.Image}}' "$server" || true)"
  sidecar_ref="$(test -n "$sidecar" && docker inspect -f '{{.Config.Image}}' "$sidecar" || true)"
  volumes="$(docker inspect "$server" | jq -c '.[0].Mounts|map(select(.Type=="volume")|{name:.Name,destination:.Destination})|sort_by(.name)')"
  health="$(public_health | jq -c '{status,discord,voice,uptimeType:(.uptime|type)}')"; mode="$(mode_from_env "$env_file")"
  jq -cn --arg configHash "$(sha256sum "$config" | cut -d' ' -f1)" \
    --arg envHash "$(sha256sum "$env_file" | cut -d' ' -f1)" \
    --arg git "$(git -C "$MS_REPO" rev-parse HEAD)" --arg mode "$mode" \
    --arg serverImage "$server_image" --arg sidecarImage "$sidecar_image" --arg serverRef "$server_ref" --arg sidecarRef "$sidecar_ref" \
    --argjson sidecarPresent "$(test -n "$sidecar" && echo true || echo false)" \
    --argjson health "$health" --argjson volumes "$volumes" \
    '{configHash:$configHash,envHash:$envHash,git:$git,mode:$mode,serverImage:$serverImage,sidecarImage:$sidecarImage,serverRef:$serverRef,sidecarRef:$sidecarRef,sidecarPresent:$sidecarPresent,publicHealth:$health,volumes:$volumes}'
}
json_fingerprint() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
state_fingerprint() { local state; state="$(state_json "$1")"; json_fingerprint "$state"; }
project_mutation_event_count() {
  docker events --since "$1" --until "$2" --filter "label=com.docker.compose.project=$MS_PROJECT" --format '{{json .}}' |
    jq -sc '[.[]|select(.Action|test("^(create|start|stop|die|kill|destroy|restart|rename|health_status)"))]|length'
}
preflight() {
  require_root; require_paths
  test -r "$MS_REPO/.git/HEAD" || die repository-missing
  git -C "$MS_REPO" diff --quiet && git -C "$MS_REPO" diff --cached --quiet || die tracked-tree-dirty
  command -v docker >/dev/null; docker info >/dev/null
  command -v python3 >/dev/null || die python3-missing
  test "$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')" -ge "${MEDIA_MIN_FREE_MIB:-2048}" || die disk-capacity
  local config config_rel status tracked_clean managed_legacy lease_state restore_state before after
  config="$(active_config)"; test -r "$config"; test -r "$(dirname "$config")/.env"
  config_rel="${config#"$MS_REPO"/}"; test "$config_rel" = deploy/compose.yaml || die compose-path
  status="$(git -C "$MS_REPO" status --porcelain --untracked-files=all)"
  tracked_clean=true; managed_legacy=false
  if test -n "$status"; then
    test "$status" = "?? $config_rel" || die dirty-tree
    git -C "$MS_REPO" ls-files --error-unmatch "$config_rel" >/dev/null 2>&1 && die tracked-config-dirty
    tracked_clean=false; managed_legacy=true
  fi
  before="$(test -e "$MS_BACKUP" && find "$MS_BACKUP" -maxdepth 2 -printf '%P:%s:%T@\n' | sort | sha256sum | cut -d' ' -f1 || echo absent)"
  if test -r "$MS_LEASE"; then
    strict_json_file "$MS_LEASE" || die lease-json-invalid
    lease_state="$(jq -er .state "$MS_LEASE")"; restore_state="$(jq -er .restoreState "$MS_LEASE")"
  else
    lease_state=absent; restore_state=absent
  fi
  after="$(test -e "$MS_BACKUP" && find "$MS_BACKUP" -maxdepth 2 -printf '%P:%s:%T@\n' | sort | sha256sum | cut -d' ' -f1 || echo absent)"
  test "$before" = "$after" || die preflight-write
  jq -cn --arg sha "$(git -C "$MS_REPO" rev-parse HEAD)" --arg configHash "$(sha256sum "$config"|cut -d' ' -f1)" \
    --argjson trackedClean "$tracked_clean" --argjson managedLegacyConfig "$managed_legacy" \
    --arg lease "$lease_state" --arg restore "$restore_state" --arg snapshot "$after" \
    '{ok:true,readOnly:true,trackedClean:$trackedClean,managedLegacyConfig:$managedLegacyConfig,protectedConfig:true,sha:$sha,configHash:$configHash,lease:$lease,restoreState:$restore,writeSnapshot:$snapshot}'
}
begin_run() {
  require_root; require_paths
  [[ "$MS_SHA" =~ ^[0-9a-f]{40}$ ]] || die selected-sha
  [[ "$MS_DEADLINE_SECONDS" =~ ^[0-9]+$ ]] || die deadline
  install -d -m 0700 "$MS_BACKUP"
  test -e "$MS_LOCK" || install -m 0600 /dev/null "$MS_LOCK"
  test "$(stat -c %U:%G:%a "$MS_LOCK")" = root:root:600 || die lock-mode
  exec 9>"$MS_LOCK"; flock -x 9
  local prior_state="" prior_restore="" prior_id="" prior_manifest="" prior_lease="" lease_path_id lease_fd_id checkpoint_path_id checkpoint_fd_id
  MS_PRIOR_LEASE_ID=absent
  MS_PRIOR_LEASE_HASH=absent
  MS_PRIOR_CHECKPOINT_ID=absent
  MS_PRIOR_RUN_ID=""
  if test -r "$MS_LEASE"; then
    local prior_projection
    secure_owner_path "$MS_LEASE" lease || die lease-path-invalid
    exec 8<"$MS_LEASE"
    lease_path_id="$(stat -c %d:%i "$MS_LEASE")" || die lease-read-invalid
    lease_fd_id="$(stat -Lc %d:%i "/proc/$$/fd/8")" || die lease-read-invalid
    test "$lease_path_id" = "$lease_fd_id" || die lease-replaced
    MS_PRIOR_LEASE_ID="$lease_fd_id"
    prior_lease="$(command cat <&8 && printf x)" || die lease-read-invalid
    prior_lease="${prior_lease%x}"
    MS_PRIOR_LEASE_HASH="$(printf '%s' "$prior_lease" | sha256sum | cut -d' ' -f1)"
    strict_json_file <(printf '%s' "$prior_lease") || die lease-json-invalid
    prior_projection="$(jq -er --arg schema "$MS_SCHEMA" '
      if type == "object"
        and (.schema == $schema)
        and (.runId | type == "string" and test("^[1-9][0-9]*-[0-9a-f]{32}$"))
        and (.generation | type == "number" and floor == . and . >= 1)
        and (.selectedSha | type == "string" and test("^[0-9a-f]{40}$"))
        and (.state | type == "string")
        and (.restoreState | type == "string")
      then [.runId, .state, .restoreState] | @tsv
      else error("invalid lease discriminator")
      end
    ' <<<"$prior_lease")" || die lease-schema-invalid
    IFS=$'\t' read -r prior_id prior_state prior_restore <<<"$prior_projection"
    test "$prior_state" != active || die active-run-exists
    test "$prior_restore" != fencing && test "$prior_restore" != restoring || die restoration-incomplete
    test "$prior_state" != expired || test "$prior_restore" = restored || die restoration-incomplete
    case "$prior_state:$prior_restore" in
      committed:idle|expired:restored) ;;
      *) die prior-lease-state;;
    esac
    prior_manifest="$MS_BACKUP/$prior_id/manifest.json"
    secure_owner_path "$MS_BACKUP/$prior_id" checkpoint || die prior-checkpoint-invalid
    exec 7<"$MS_BACKUP/$prior_id"
    checkpoint_path_id="$(stat -c %d:%i "$MS_BACKUP/$prior_id")" || die prior-checkpoint-invalid
    checkpoint_fd_id="$(stat -Lc %d:%i "/proc/$$/fd/7")" || die prior-checkpoint-invalid
    test "$checkpoint_path_id" = "$checkpoint_fd_id" || die prior-checkpoint-replaced
    MS_PRIOR_CHECKPOINT_ID="$checkpoint_fd_id"
    MS_PRIOR_RUN_ID="$prior_id"
    validate_cleanup_archive "$prior_manifest" <(printf '%s' "$prior_lease") "$prior_id" || die prior-checkpoint-invalid
    for file in "$MS_BACKUP/$prior_id/compose.yaml" "$MS_BACKUP/$prior_id/deploy.env"; do
      test -f "$file" && test ! -L "$file" || die prior-checkpoint-invalid
    done
    test "$(sha256sum "$MS_BACKUP/$prior_id/compose.yaml"|cut -d' ' -f1)" = "$(jq -r .composeHash "$prior_manifest")" || die prior-checkpoint-invalid
    test "$(sha256sum "$MS_BACKUP/$prior_id/deploy.env"|cut -d' ' -f1)" = "$(jq -r .envHash "$prior_manifest")" || die prior-checkpoint-invalid
  fi
  cleanup_retention_locked "$prior_id"
  cleanup_stale_lease_temps_locked true
  if test -n "$prior_id"; then
    verify_prior_lease_locked
    verify_prior_checkpoint_locked
    printf '%s' "$prior_lease" >"$MS_BACKUP/$prior_id/terminal.json.tmp"
    sync -f "$MS_BACKUP/$prior_id/terminal.json.tmp"
    mv -f "$MS_BACKUP/$prior_id/terminal.json.tmp" "$MS_BACKUP/$prior_id/terminal.json"
    sync -f "$MS_BACKUP/$prior_id"
    repair_retained_tags_locked >/dev/null
  fi
  local generation random run_id temp run config working env_file state health cursor now deadline
  generation="$(test -r "$MS_COUNTER" && cat "$MS_COUNTER" || echo 0)"; [[ "$generation" =~ ^[0-9]+$ ]] || die counter-invalid; generation=$((generation+1))
  printf '%s\n' "$generation" | atomic_file "$MS_COUNTER" 0600
  random="$(openssl rand -hex 16)"; run_id="$generation-$random"; temp="$MS_BACKUP/.$run_id.tmp"; run="$MS_BACKUP/$run_id"
  trap 'test -n "${temp:-}" && test -d "$temp" && rm -rf -- "$temp"' ERR
  mkdir -m 0700 "$temp"; config="$(active_config)"; working="$(dirname "$config")"; env_file="$working/.env"
  cp -p "$config" "$temp/compose.yaml"; cp -p "$env_file" "$temp/deploy.env"; chmod 0600 "$temp/compose.yaml" "$temp/deploy.env"
  printf '%s' "$MS_OWNER_B64" | base64 -d >"$temp/owner.sh"; chmod 0700 "$temp/owner.sh"
  state="$(state_json "$config")"; health="$(public_health)"; cursor="$(date --iso-8601=ns)"
  jq -cn --arg schema "$MS_SCHEMA" --arg runId "$run_id" --argjson generation "$generation" --arg selectedSha "$MS_SHA" \
    --arg kind "${MEDIA_RUN_KIND:-deployment}" --arg configPath "$config" --arg workingDir "$working" --arg eventCursor "$cursor" \
    --arg composeHash "$(sha256sum "$temp/compose.yaml"|cut -d' ' -f1)" --arg envHash "$(sha256sum "$temp/deploy.env"|cut -d' ' -f1)" \
    --arg ownerHash "$(sha256sum "$temp/owner.sh"|cut -d' ' -f1)" --arg desiredFingerprint "$(json_fingerprint "$state")" \
    --argjson priorState "$state" --argjson priorPublicHealth "$health" '{schema:$schema,runId:$runId,generation:$generation,selectedSha:$selectedSha,kind:$kind,configPath:$configPath,workingDir:$workingDir,eventCursor:$eventCursor,composeHash:$composeHash,envHash:$envHash,ownerHash:$ownerHash,desiredFingerprint:$desiredFingerprint,priorState:$priorState,priorPublicHealth:$priorPublicHealth,rollbackTags:{server:("discord-music-rollback:"+$runId+"-server"),sidecar:(if $priorState.sidecarPresent then "discord-music-rollback:"+$runId+"-sidecar" else null end)}}' >"$temp/manifest.json"
  chmod 0600 "$temp/manifest.json"; jq -e . "$temp/manifest.json" >/dev/null
  test "$(sha256sum "$temp/compose.yaml"|cut -d' ' -f1)" = "$(jq -r .composeHash "$temp/manifest.json")"
  test "$(sha256sum "$temp/deploy.env"|cut -d' ' -f1)" = "$(jq -r .envHash "$temp/manifest.json")"
  sync -f "$temp/manifest.json"; sync -f "$temp"; mv "$temp" "$run"; sync -f "$MS_BACKUP"
  now="$(boottime)"; deadline=$((now+MS_DEADLINE_SECONDS))
  jq -cn --arg schema "$MS_SCHEMA" --arg runId "$run_id" --argjson generation "$generation" --arg selectedSha "$MS_SHA" \
    --argjson sequence 0 --argjson deadline "$deadline" --arg eventCursor "$cursor" \
    '{schema:$schema,runId:$runId,generation:$generation,selectedSha:$selectedSha,sequence:$sequence,deadlineClock:"CLOCK_BOOTTIME",deadlineBoottime:$deadline,eventCursor:$eventCursor,state:"active",restoreState:"idle",stableSamples:0,lateDaemonDetected:false,reconcilePasses:0,eventProof:null,acceptedOperations:[],activeMutation:null}' | lease_write true
  nohup setsid "$run/owner.sh" watchdog "$run_id" >/dev/null 2>&1 </dev/null 9>&- &
  jq -cn --arg runId "$run_id" --argjson generation "$generation" '{ok:true,runId:$runId,generation:$generation,sequence:0,checkpointDurable:true,watchdogLaunched:true}'
}
cas_active() {
  local run_id="$1" expected="$2" now
  test -r "$MS_LEASE" || die lease-missing
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .state)" = active || die terminal-lease
  test "$(lease_value .sequence)" -eq "$expected" || die stale-sequence
  now="$(boottime)"; test "$now" -lt "$(lease_value .deadlineBoottime)" || die lease-deadline
}
lease_replace() { local filter="$1"; strict_json_file "$MS_LEASE" || die lease-json-invalid; jq "$filter" "$MS_LEASE" | lease_write; }
build_operation_allowed() {
  case "$1" in
    build|build-server|build-sidecar) ;;
    *) die build-operation;;
  esac
}
validate_build_inputs() {
  local run_id="$1" manifest="$2"
  test "$MS_PROJECT" = deploy || die build-project
  [[ "$MS_SHA" =~ ^[0-9a-f]{40}$ ]] || die build-selected-sha
  strict_json_file "$manifest" || die build-manifest-json-invalid
  jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" --arg sha "$MS_SHA" \
    '.schema==$schema and .runId==$runId and .selectedSha==$sha' "$manifest" >/dev/null || die build-manifest-binding
  test "$(lease_value .runId)" = "$run_id" || die build-run
  test "$(lease_value .selectedSha)" = "$MS_SHA" || die build-lease-sha
}
validate_build_mutation() {
  local run_id="$1" sequence="$2" operation="$3" manifest="$MS_BACKUP/$1/manifest.json"
  build_operation_allowed "$operation"
  test -r "$manifest" || die build-manifest-missing
  validate_build_inputs "$run_id" "$manifest"
  test "$(lease_value .state)" = active || die build-state
  test "$(lease_value .sequence)" -eq "$sequence" || die build-sequence
  jq -e '.activeMutation == null' "$MS_LEASE" >/dev/null || die active-operation
}
build_binding() {
  local run_id="$1" sequence="$2" operation="$3" manifest="$4"
  build_operation_allowed "$operation"
  validate_build_inputs "$run_id" "$manifest"
  test "$(lease_value .state)" = active || die build-state
  test "$(lease_value .sequence)" -eq "$sequence" || die build-sequence
  test "$(lease_value .activeMutation.operation)" = "$operation" || die build-operation
  test "$(lease_value .activeMutation.sequence)" -eq "$sequence" || die build-operation-sequence
}
build_image() {
  local role="$1" run_id="$2" sequence="$3" operation="$4" manifest="$5" tree before
  build_binding "$run_id" "$sequence" "$operation" "$manifest"
  tree="$(git -C "$MS_REPO" rev-parse 'HEAD^{tree}')"; before="$run/images-before-build-$role"
  docker images -q --no-trunc | sort -u >"$before"; chmod 0600 "$before"; sync -f "$before"
  case "$role" in
    server) docker build -t "discord-music-server:$MS_SHA" --build-arg "BUILD_SHA=$MS_SHA" --build-arg "BUILD_TREE=$tree" "$MS_REPO";;
    sidecar) docker build -t "discord-music-media-sidecar:$MS_SHA" -f "$MS_REPO/Dockerfile.media-sidecar" --build-arg "BUILD_SHA=$MS_SHA" --build-arg "BUILD_TREE=$tree" "$MS_REPO";;
    *) die build-role;;
  esac
  remove_new_untagged_images "$before"
}
perform() {
  local run_id="$1" sequence="$2" operation="$3" run manifest config working
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  strict_json_file "$manifest" || die manifest-json-invalid
  config="$(jq -r .configPath "$manifest")"; working="$(jq -r .workingDir "$manifest")"
  case "$operation" in
    tag-prior)
      docker tag "$(jq -r .priorState.serverImage "$manifest")" "$(jq -r .rollbackTags.server "$manifest")"
      if jq -e '.priorState.sidecarPresent' "$manifest" >/dev/null; then docker tag "$(jq -r .priorState.sidecarImage "$manifest")" "$(jq -r .rollbackTags.sidecar "$manifest")"; fi
      ;;
    receive-bundle) cat >"$run/source.bundle"; chmod 0600 "$run/source.bundle"; sync -f "$run/source.bundle";;
    checkout)
      git -C "$MS_REPO" fetch "$run/source.bundle" "$MS_SHA"
      git -C "$MS_REPO" fetch origin main
      test "$(git -C "$MS_REPO" rev-parse origin/main)" = "$MS_SHA"
      if ! git -C "$MS_REPO" ls-files --error-unmatch "${config#"$MS_REPO"/}" >/dev/null 2>&1; then
        test "$(sha256sum "$config" | cut -d' ' -f1)" = "$(jq -r .composeHash "$manifest")"
        mv "$config" "$run/legacy-active-compose.yaml"
        chmod 0600 "$run/legacy-active-compose.yaml"; sync -f "$run/legacy-active-compose.yaml"; sync -f "$run"
      fi
      git -C "$MS_REPO" merge --ff-only "$MS_SHA"
      test "$(git -C "$MS_REPO" rev-parse HEAD)" = "$MS_SHA"
      git -C "$MS_REPO" ls-files --error-unmatch "${config#"$MS_REPO"/}" >/dev/null
      test -z "$(git -C "$MS_REPO" status --porcelain --untracked-files=all)"
      ;;
    build)
      build_image server "$run_id" "$sequence" "$operation" "$manifest"
      build_image sidecar "$run_id" "$sequence" "$operation" "$manifest"
      ;;
    build-server) build_image server "$run_id" "$sequence" "$operation" "$manifest";;
    build-sidecar) build_image sidecar "$run_id" "$sequence" "$operation" "$manifest";;
    configure-shadow|configure-rust|configure-disabled)
      local mode="${operation#configure-}" env_temp="${working}/.env.run-$run_id"
      awk -v mode="$mode" -v sha="$MS_SHA" 'BEGIN{modeDone=0;shaDone=0} /^MEDIA_SIDECAR_MODE=/{if(!modeDone){print "MEDIA_SIDECAR_MODE=" mode;modeDone=1}next} /^DEPLOY_SHA=/{if(!shaDone){print "DEPLOY_SHA=" sha;shaDone=1}next} {print} END{if(!modeDone)print "MEDIA_SIDECAR_MODE=" mode;if(!shaDone)print "DEPLOY_SHA=" sha}' "$working/.env" >"$env_temp"
      chmod 0600 "$env_temp"; sync -f "$env_temp"; mv -f "$env_temp" "$working/.env"; sync -f "$working"
      test -z "$(git -C "$MS_REPO" status --porcelain --untracked-files=all)"
      ;;
    up)
      docker compose -p "$MS_PROJECT" -f "$config" up -d --force-recreate --remove-orphans
      for _ in $(seq 1 60); do test "$(docker inspect -f '{{.State.Health.Status}}' discord-music 2>/dev/null || true)" = healthy && test "$(docker inspect -f '{{.State.Health.Status}}' "${MS_PROJECT}-media-sidecar-1" 2>/dev/null || true)" = healthy && exit 0; sleep 1; done
      exit 1;;
    stop-sidecar) docker compose -p "$MS_PROJECT" -f "$config" stop media-sidecar;;
    start-sidecar) docker compose -p "$MS_PROJECT" -f "$config" up -d media-sidecar;;
    benchmark-live|benchmark-fallback|benchmark-disabled|benchmark-fresh)
      local kind="${operation#benchmark-}" raw="$run/benchmark-$sequence.private.json" safe="$run/benchmark-$sequence.result.json" rustlog="$run/benchmark-$sequence.rust.jsonl" since result correlations rust_success upstream_success probe node_probe
      probe='{"healthStatus":0,"searchStatus":0,"resultCount":0}'
      node_probe='{"dnsCount":0,"healthStatus":0,"searchStatus":0,"resultCount":0,"failure":"not_run","mismatchFirst":0,"paired":0,"mismatchSecond":0}'
      if test "$kind" = live; then
        probe="$(docker exec "${MS_PROJECT}-media-sidecar-1" deno eval '
          const health = await fetch("http://127.0.0.1:3101/healthz")
          const search = await fetch("http://127.0.0.1:3101/v1/search", {
            method: "POST",
            headers: {"content-type":"application/json","x-media-sidecar-correlation-id":"00000000-0000-4000-8000-000000000000"},
            body: JSON.stringify({version:1,query:"never gonna give you up official video probe"}),
          })
          const body = await search.json().catch(() => ({}))
          console.log(JSON.stringify({healthStatus:health.status,searchStatus:search.status,resultCount:Array.isArray(body.results)?body.results.length:0}))
        ')"
        probe="$(jq -ce '{healthStatus,searchStatus,resultCount}' <<<"$probe")"
        node_probe="$(docker exec discord-music node --input-type=module -e '
          let dnsCount=0, healthStatus=0, searchStatus=0, resultCount=0, failure="none"
          const {Agent,fetch:undiciFetch}=await import("/app/apps/server/node_modules/undici/index.js")
          async function agentStatus(fetcher) {
            const dispatcher=new Agent({connections:1})
            try { return (await fetcher("http://media-sidecar:3101/healthz",{dispatcher,signal:AbortSignal.timeout(5000)})).status } catch { return 0 } finally { await dispatcher.close() }
          }
          const mismatchFirst=await agentStatus(globalThis.fetch)
          const paired=await agentStatus(undiciFetch)
          const mismatchSecond=await agentStatus(globalThis.fetch)
          try { dnsCount=(await import("node:dns/promises")).resolve4("media-sidecar").then((items)=>items.length).catch(()=>0); dnsCount=await dnsCount } catch { failure="dns" }
          try {
            const health=await fetch("http://media-sidecar:3101/healthz",{signal:AbortSignal.timeout(5000)})
            healthStatus=health.status
            const search=await fetch("http://media-sidecar:3101/v1/search",{method:"POST",headers:{"content-type":"application/json","x-media-sidecar-correlation-id":"00000000-0000-4000-8000-000000000001"},body:JSON.stringify({version:1,query:"never gonna give you up official video node probe"}),signal:AbortSignal.timeout(5000)})
            searchStatus=search.status
            const body=await search.json().catch(()=>({}))
            resultCount=Array.isArray(body.results)?body.results.length:0
          } catch { failure="transport" }
          console.log(JSON.stringify({dnsCount,healthStatus,searchStatus,resultCount,failure,mismatchFirst,paired,mismatchSecond,proxyEnvPresent:Boolean(process.env.HTTP_PROXY||process.env.HTTPS_PROXY||process.env.ALL_PROXY),nodeUseEnvProxy:process.env.NODE_USE_ENV_PROXY==="1",modeIsRust:process.env.MEDIA_SIDECAR_MODE==="rust",urlMatches:process.env.MEDIA_SIDECAR_URL==="http://media-sidecar:3101"}))
        ')"
        node_probe="$(jq -ce '{dnsCount,healthStatus,searchStatus,resultCount,failure,mismatchFirst,paired,mismatchSecond,proxyEnvPresent,nodeUseEnvProxy,modeIsRust,urlMatches}' <<<"$node_probe")"
      fi
      since="$(date --iso-8601=seconds)"
      docker exec -i -e "MEDIA_BENCH_KIND=$kind" -e "MEDIA_BENCH_RUN=$run_id" discord-music node --input-type=module - >"$raw"
      chmod 0600 "$raw"; result="$(jq -ce .result "$raw")"
      if test "$kind" = live; then
        correlations="$(jq -c .private.acceptCorrelations "$raw")"
        docker logs "${MS_PROJECT}-media-sidecar-1" --since "$since" 2>&1 | jq -Rc 'fromjson? | .fields.observation? | if type=="string" then fromjson? else . end' >"$rustlog"
        chmod 0600 "$rustlog"
        rust_success="$(jq -s --argjson ids "$correlations" '[.[]|select(.stage=="rust_handler" and .outcome=="success" and (.correlationId as $id|$ids|index($id)))]|length' "$rustlog")"
        upstream_success="$(jq -s --argjson ids "$correlations" '[.[]|select(.stage=="innertube_upstream" and .outcome=="success" and (.correlationId as $id|$ids|index($id)))]|length' "$rustlog")"
        result="$(jq -c --argjson rust "$rust_success" --argjson upstream "$upstream_success" --argjson probe "$probe" --argjson nodeProbe "$node_probe" '.uncached.rust=$rust | .uncached.upstream=$upstream | .probe=$probe | .nodeProbe=$nodeProbe' <<<"$result")"
        printf '%s\n' "$result" >"$safe"; chmod 0600 "$safe"; sync -f "$safe"
        jq -e '.probe.healthStatus==200 and .probe.searchStatus==200 and .probe.resultCount>0 and .nodeProbe.dnsCount>0 and .nodeProbe.healthStatus==200 and .nodeProbe.searchStatus==200 and .nodeProbe.resultCount>0 and .nodeProbe.failure=="none" and .warmups==30 and .uniqueAcceptance==40 and .nonEmptyResults==40 and .disjointKeys and .uncached.node==40 and .uncached.clientSent==40 and .uncached.clientSuccess==40 and .uncached.rust==40 and .uncached.upstream==40 and .uncached.inMemoryIdMatch==40 and .uncached.local==0 and .uncached.fallback==0 and .uncached.p95Ms<1000 and .replay.node==40 and .replay.rust==0 and .replay.upstream==0 and .replay.local==0 and .replay.fallback==0 and .replay.p95Ms<10 and .idsEqual and .fingerprintsValid and .fingerprintCount==40 and .resolve.observed and .internalState=="ready" and .errors==0' <<<"$result" >/dev/null
      elif test "$kind" = fallback; then jq -e '.node==1 and .rust==1 and .local==1 and .fallback==1 and .resultCount>0' <<<"$result" >/dev/null
      elif test "$kind" = disabled; then jq -e '.node==1 and .rust==0 and .local==1 and .fallback==0 and .resultCount>0 and .internalState=="disabled"' <<<"$result" >/dev/null
      else jq -e '.node==1 and .rust==1 and .local==0 and .fallback==0 and .resultCount>0 and .durationMs<1000 and .internalState=="ready"' <<<"$result" >/dev/null
      fi
      printf '%s\n' "$result"
      return 0
      ;;
    drill-accept)
      local delayed="$run/delayed.env"
      awk 'BEGIN{done=0} /^MEDIA_SIDECAR_MODE=/{if(!done){print "MEDIA_SIDECAR_MODE=rust";done=1}next} {print} END{if(!done)print "MEDIA_SIDECAR_MODE=rust"}' "$working/.env" >"$delayed"; chmod 0600 "$delayed"
      nohup setsid "$run/owner.sh" delayed-daemon "$run_id" "$delayed" >/dev/null 2>&1 </dev/null &
      cp "$delayed" "$working/.env"; docker compose -p "$MS_PROJECT" -f "$config" up -d --force-recreate server
      sleep 600;;
    *) die unknown-operation;;
  esac
  printf '{"ok":true,"operation":"%s","sequence":%s}\n' "$operation" "$sequence"
}
mutate() {
  local run_id="$1" expected="$2" operation="$3" next run log payload pid status
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9; cas_active "$run_id" "$expected"
  jq -e '.activeMutation == null' "$MS_LEASE" >/dev/null || die active-operation
  case "$operation" in
    build*) validate_build_mutation "$run_id" "$expected" "$operation";;
  esac
  next=$((expected+1)); run="$MS_BACKUP/$run_id"; mkdir -p "$run/operations"; chmod 0700 "$run/operations"
  log="$run/operations/$next.log"; payload="$run/operations/$next.input"
  : >"$log"; chmod 0600 "$log"; cat >"$payload"; chmod 0600 "$payload"; sync -f "$payload"
  jq --argjson sequence "$next" --arg operation "$operation" '.sequence=$sequence | .acceptedOperations += [{sequence:$sequence,operation:$operation,status:"accepted"}] | .activeMutation={sequence:$sequence,operation:$operation,pid:null,pgid:null}' "$MS_LEASE" | lease_write
  setsid "$MS_SELF" perform "$run_id" "$next" "$operation" <"$payload" >"$log" 2>&1 9>&- & pid=$!
  jq --argjson pid "$pid" '.activeMutation.pid=$pid | .activeMutation.pgid=$pid' "$MS_LEASE" | lease_write
  flock -u 9; wait "$pid" && status=0 || status=$?; flock -x 9
  if test "$(lease_value .runId)" = "$run_id" && test "$(lease_value .state)" = active && test "$(lease_value .sequence)" -eq "$next"; then
    jq --argjson sequence "$next" --arg status "$(test "$status" -eq 0 && echo succeeded || echo failed)" '(.acceptedOperations[]|select(.sequence==$sequence).status)=$status | .activeMutation=null' "$MS_LEASE" | lease_write
  fi
  flock -u 9
  test "$status" -eq 0 || { "$MS_SELF" expire "$run_id"; die operation-failed; }
  if [[ "$operation" == benchmark-* ]]; then tail -1 "$log" | jq -ce --argjson sequence "$next" '.sequence=$sequence'; else jq -cn --argjson sequence "$next" --arg operation "$operation" '{ok:true,sequence:$sequence,operation:$operation}'; fi
}
restore_locked() {
  local run_id="$1" run manifest config working server_ref sidecar_ref server_source sidecar_source deadline sample1 sample2 events_since events_until event_count observed_count desired marker
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  strict_json_file "$manifest" || die manifest-json-invalid
  config="$(jq -r .configPath "$manifest")"; working="$(jq -r .workingDir "$manifest")"
  server_ref="$(jq -r .priorState.serverRef "$manifest")"; sidecar_ref="$(jq -r '.priorState.sidecarRef // empty' "$manifest")"
  desired="$(jq -r .desiredFingerprint "$manifest")"; marker="$run/restore-first-sample"
  deadline=$(( $(boottime)+120 )); events_since="$(jq -r .eventCursor "$manifest")"; events_until="$(date +%s)"
  observed_count="$(project_mutation_event_count "$events_since" "$events_until")"
  while test "$(boottime)" -lt "$deadline"; do
    git -C "$MS_REPO" reset --hard "$(jq -r .priorState.git "$manifest")" >/dev/null
    cp "$run/compose.yaml" "$config"; cp "$run/deploy.env" "$working/.env"; chmod 0600 "$config" "$working/.env"
    server_source="$(jq -r .priorState.serverImage "$manifest")"; docker image inspect "$server_source" >/dev/null 2>&1 || server_source="$(jq -r .rollbackTags.server "$manifest")"
    docker tag "$server_source" "$server_ref" || return 1
    if jq -e '.priorState.sidecarPresent' "$manifest" >/dev/null; then
      sidecar_source="$(jq -r .priorState.sidecarImage "$manifest")"; docker image inspect "$sidecar_source" >/dev/null 2>&1 || sidecar_source="$(jq -r .rollbackTags.sidecar "$manifest")"
      docker tag "$sidecar_source" "$sidecar_ref" || return 1
    fi
    docker compose -p "$MS_PROJECT" -f "$config" up -d --force-recreate --remove-orphans >/dev/null 2>&1
    sample1=""
    for _ in $(seq 1 30); do sample1="$(state_fingerprint "$config" 2>/dev/null || true)"; test "$sample1" = "$desired" && break; sleep 1; done
    test "$sample1" = "$desired" || { jq '.reconcilePasses += 1 | .stableSamples=0' "$MS_LEASE" | lease_write; continue; }
    if test ! -e "$marker"; then : >"$marker"; chmod 0600 "$marker"; sync -f "$marker"; sync -f "$run"; fi
    events_since="$(date +%s)"; sleep 5; sample2="$(state_fingerprint "$config" 2>/dev/null || true)"; events_until="$(date +%s)"
    event_count="$(project_mutation_event_count "$events_since" "$events_until")"; observed_count=$((observed_count+event_count))
    if test "$sample2" = "$sample1" && test "$event_count" -eq 0; then
      jq --argjson observed "$observed_count" --argjson stableAt "$(boottime)" '.restoreState="restored" | .stableSamples=2 | .activeMutation=null | .acceptedOperations |= map(if .status=="accepted" then .status="superseded" else . end) | .eventProof={cursor:.eventCursor,observedCount:$observed,quietWindowEvents:0,stableAtBoottime:$stableAt}' "$MS_LEASE" | lease_write; return 0
    fi
    jq '.lateDaemonDetected=true | .reconcilePasses += 1 | .stableSamples=0' "$MS_LEASE" | lease_write
  done
  return 1
}
expire() {
  local run_id="$1" pid pgid
  require_root; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  if test "$(lease_value .state)" = active; then
    pid="$(jq -r '.activeMutation.pid // empty' "$MS_LEASE")"; pgid="$(jq -r '.activeMutation.pgid // empty' "$MS_LEASE")"
    jq '.state="expired" | .restoreState="fencing"' "$MS_LEASE" | lease_write
    if test -n "$pgid"; then kill -TERM -- "-$pgid" 2>/dev/null || true; for _ in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; kill -KILL -- "-$pgid" 2>/dev/null || true; fi
    jq '.restoreState="restoring"' "$MS_LEASE" | lease_write
  fi
  test "$(lease_value .state)" = expired || die terminal-lease
  if ! restore_locked "$run_id"; then flock -u 9; die restore-pending; fi
  jq -cn --arg runId "$run_id" '{ok:true,runId:$runId,state:"expired",restoreState:"restored",stableSamples:2}'
}
watchdog() {
  local run_id="$1" deadline now
  while :; do
    test -r "$MS_LEASE" || exit 0
    test "$(lease_value .runId)" = "$run_id" || exit 0
    test "$(lease_value .state)" = active || { test "$(lease_value .restoreState)" != restoring || "$MS_SELF" expire "$run_id" || true; exit 0; }
    deadline="$(lease_value .deadlineBoottime)"; now="$(boottime)"; test "$now" -ge "$deadline" && break; sleep 1
  done
  until "$MS_SELF" expire "$run_id" >/dev/null 2>&1; do sleep 10; done
}
delayed_daemon() {
  local run_id="$1" delayed="$2" run manifest config working deadline
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  strict_json_file "$manifest" || die manifest-json-invalid
  deadline=$(( $(boottime)+150 )); while test ! -e "$run/restore-first-sample" && test "$(boottime)" -lt "$deadline"; do sleep 1; done
  test -e "$run/restore-first-sample" || exit 1
  sleep 1
  config="$(jq -r .configPath "$manifest")"; working="$(jq -r .workingDir "$manifest")"
  cp "$delayed" "$working/.env"; docker compose -p "$MS_PROJECT" -f "$config" up -d --force-recreate server >/dev/null 2>&1 || true
}
recover_restoring() {
  local run_id="$1" cmdline pid
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .state)" = expired && test "$(lease_value .restoreState)" = restoring || die recovery-state
  for cmdline in /proc/[0-9]*/cmdline; do
    test -r "$cmdline" || continue; pid="${cmdline#/proc/}"; pid="${pid%/cmdline}"
    tr '\0' ' ' <"$cmdline" | grep -Fq "$MS_BACKUP/$run_id/owner.sh watchdog $run_id" || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  restore_locked "$run_id" || die restore-pending
  jq -cn --arg runId "$run_id" '{ok:true,runId:$runId,state:"expired",restoreState:"restored",stableSamples:2,recoveryOwner:true}'
}
reclaim_consumed_inputs() {
  local run_id="$1" run sequence input removed bytes size
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .state)" = active || die reclaim-state
  run="$MS_BACKUP/$run_id"; removed=0; bytes=0
  while read -r sequence; do
    input="$run/operations/$sequence.input"
    test -f "$input" || continue
    size="$(stat -c %s "$input")"; rm -f -- "$input"
    removed=$((removed+1)); bytes=$((bytes+size))
  done < <(jq -r '.acceptedOperations[]|select(.status=="succeeded")|.sequence' "$MS_LEASE")
  jq -cn --argjson removed "$removed" --argjson bytes "$bytes" '{ok:true,consumedInputsRemoved:$removed,bytesFreed:$bytes,volumesRemoved:0}'
}
terminal_cleanup_build_sequence() {
  jq -er '[.acceptedOperations[]|select(.operation=="build" or .operation=="build-server" or .operation=="build-sidecar")]|last|select(.status=="failed" or .status=="superseded")|.sequence|select(type=="number" and .>0 and floor==.)' "$1"
}
task_build_image_ids() {
  local candidate run_id manifest terminal sequence log
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue; run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"
    test -r "$manifest" && test -r "$terminal" || continue
    jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" '.schema==$schema and .runId==$runId' "$manifest" >/dev/null || continue
    jq -e --arg runId "$run_id" '.runId==$runId and (.state=="committed" or (.state=="expired" and .restoreState=="restored"))' "$terminal" >/dev/null || continue
    while read -r sequence; do
      log="$candidate/operations/$sequence.log"; test -r "$log" || continue
      sed $'s/\033\[[0-9;]*m//g' "$log" | sed -n 's/^ ---> \([0-9a-f]\{12,64\}\)$/\1/p'
    done < <(terminal_cleanup_build_sequence "$terminal")
  done | sort -u
}
task_build_container_ids() {
  local candidate run_id manifest terminal sequence log
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue; run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"
    test -r "$manifest" && test -r "$terminal" || continue
    jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" '.schema==$schema and .runId==$runId' "$manifest" >/dev/null || continue
    jq -e --arg runId "$run_id" '.runId==$runId and (.state=="committed" or (.state=="expired" and .restoreState=="restored"))' "$terminal" >/dev/null || continue
    while read -r sequence; do
      log="$candidate/operations/$sequence.log"; test -r "$log" || continue
      sed $'s/\033\[[0-9;]*m//g' "$log" | sed -n 's/^ ---> Running in \([0-9a-f]\{12,64\}\)$/\1/p'
    done < <(terminal_cleanup_build_sequence "$terminal")
  done | sort -u
}
task_event_floor() {
  local candidate run_id manifest
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue; run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    manifest="$candidate/manifest.json"; test -r "$manifest" || continue
    jq -er --arg schema "$MS_SCHEMA" --arg runId "$run_id" 'select(.schema==$schema and .runId==$runId)|.eventCursor' "$manifest" || continue
  done | sort | head -1
}
validate_cleanup_archive() {
  python3 - "$1" "$2" "$3" "$MS_SCHEMA" "$MS_TEST_ROOT/opt/discord-music/deploy/compose.yaml" "$MS_TEST_ROOT/opt/discord-music/deploy" 2>/dev/null <<'PY'
import json
import re
import sys
from datetime import datetime

MAX_SAFE_INTEGER = 9_007_199_254_740_991
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
OPERATIONS = {"tag-prior", "receive-bundle", "checkout", "build", "build-server", "build-sidecar", "configure-shadow", "configure-rust", "configure-disabled", "up", "stop-sidecar", "start-sidecar", "benchmark-live", "benchmark-fallback", "benchmark-disabled", "benchmark-fresh", "drill-accept"}

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate member")
        result[key] = value
    return result

def load(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source, object_pairs_hook=unique_object, parse_constant=lambda _value: fail())

def fail():
    raise ValueError("invalid archive")

def exact(value, required, optional=()):
    if type(value) is not dict or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        fail()

def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_SAFE_INTEGER:
        fail()
    return value

def string(value, pattern=None):
    if type(value) is not str or not value or (pattern is not None and pattern.fullmatch(value) is None):
        fail()
    return value

def timestamp(value):
    parsed = datetime.fromisoformat(string(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        fail()
    return value

manifest_path, terminal_path, run_id, schema, config_path, working_dir = sys.argv[1:]
manifest = load(manifest_path)
manifest_keys = {"schema", "runId", "generation", "selectedSha", "kind", "configPath", "workingDir", "eventCursor", "composeHash", "envHash", "ownerHash", "desiredFingerprint", "priorState", "priorPublicHealth", "rollbackTags"}
exact(manifest, manifest_keys)
if manifest["schema"] != schema or manifest["runId"] != run_id:
    fail()
generation = integer(manifest["generation"], 1)
if generation != int(run_id.split("-", 1)[0]):
    fail()
selected_sha = string(manifest["selectedSha"], HEX40)
string(manifest["kind"])
if manifest["configPath"] != config_path or manifest["workingDir"] != working_dir:
    fail()
event_cursor = timestamp(manifest["eventCursor"])
for field in ("composeHash", "envHash", "ownerHash", "desiredFingerprint"):
    string(manifest[field], HEX64)

prior = manifest["priorState"]
prior_keys = {"configHash", "envHash", "git", "mode", "serverImage", "sidecarImage", "serverRef", "sidecarRef", "sidecarPresent", "publicHealth", "volumes"}
exact(prior, prior_keys)
string(prior["configHash"], HEX64); string(prior["envHash"], HEX64); string(prior["git"], HEX40)
if prior["mode"] not in {"disabled", "shadow", "rust"} or type(prior["sidecarPresent"]) is not bool:
    fail()
string(prior["serverImage"], IMAGE); string(prior["serverRef"])
if type(prior["sidecarImage"]) is not str or type(prior["sidecarRef"]) is not str:
    fail()
if prior["sidecarPresent"]:
    string(prior["sidecarImage"], IMAGE); string(prior["sidecarRef"])
elif prior["sidecarImage"] or prior["sidecarRef"]:
    fail()
exact(prior["publicHealth"], {"status", "discord", "voice", "uptimeType"})
for field in ("status", "discord", "voice"):
    string(prior["publicHealth"][field])
if prior["publicHealth"]["uptimeType"] != "number":
    fail()
if type(prior["volumes"]) is not list:
    fail()
for volume in prior["volumes"]:
    exact(volume, {"name", "destination"}); string(volume["name"]); string(volume["destination"])
exact(manifest["priorPublicHealth"], {"status", "discord", "voice", "uptime"})
for field in ("status", "discord", "voice"):
    string(manifest["priorPublicHealth"][field])
integer(manifest["priorPublicHealth"]["uptime"])
exact(manifest["rollbackTags"], {"server", "sidecar"})
if manifest["rollbackTags"]["server"] != f"discord-music-rollback:{run_id}-server":
    fail()
expected_sidecar = f"discord-music-rollback:{run_id}-sidecar" if prior["sidecarPresent"] else None
if manifest["rollbackTags"]["sidecar"] != expected_sidecar:
    fail()

if not terminal_path:
    sys.exit(0)
terminal = load(terminal_path)
terminal_keys = {"schema", "runId", "generation", "selectedSha", "sequence", "deadlineClock", "deadlineBoottime", "eventCursor", "state", "restoreState", "stableSamples", "lateDaemonDetected", "reconcilePasses", "eventProof", "acceptedOperations", "activeMutation"}
exact(terminal, terminal_keys, {"cleanup"})
if terminal["schema"] != schema or terminal["runId"] != run_id or terminal["generation"] != generation or terminal["selectedSha"] != selected_sha or terminal["eventCursor"] != event_cursor:
    fail()
sequence = integer(terminal["sequence"])
integer(terminal["deadlineBoottime"]); integer(terminal["stableSamples"]); integer(terminal["reconcilePasses"])
if terminal["deadlineClock"] != "CLOCK_BOOTTIME" or type(terminal["lateDaemonDetected"]) is not bool or terminal["activeMutation"] is not None:
    fail()
state_pair = (terminal["state"], terminal["restoreState"])
if state_pair not in {("committed", "idle"), ("expired", "restored")}:
    fail()
proof = terminal["eventProof"]
if proof is None:
    if state_pair != ("committed", "idle") or terminal["stableSamples"] != 0:
        fail()
else:
    if terminal["stableSamples"] != 2:
        fail()
    exact(proof, {"cursor", "observedCount", "quietWindowEvents", "stableAtBoottime"})
    if proof["cursor"] != event_cursor:
        fail()
    integer(proof["observedCount"]); integer(proof["stableAtBoottime"])
    if integer(proof["quietWindowEvents"]) != 0:
        fail()
if type(terminal["acceptedOperations"]) is not list:
    fail()
previous = 0
for operation in terminal["acceptedOperations"]:
    exact(operation, {"sequence", "operation", "status"})
    observed = integer(operation["sequence"], 1)
    if observed <= previous or observed > sequence or operation["operation"] not in OPERATIONS or operation["status"] not in {"succeeded", "failed", "superseded"}:
        fail()
    previous = observed
if "cleanup" in terminal:
    cleanup = terminal["cleanup"]
    if cleanup is not None:
        cleanup_keys = {"failedBuildImagesRemoved", "freeMiBBefore", "freeMiBAfter", "volumesRemoved"}
        cleanup_optional = {"failedBuildContainersRemoved", "supersededSelectedTagsRemoved", "temporaryQaTagsRemoved"}
        exact(cleanup, cleanup_keys, cleanup_optional)
        for field in cleanup:
            integer(cleanup[field])
        if cleanup["volumesRemoved"] != 0:
            fail()
PY
}
validate_cleanup_json_records() {
  local current_run_id="$1" candidate run_id manifest terminal terminal_arg
  for candidate in "$MS_BACKUP"/*; do
    test -d "$candidate" || continue; run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    test "$run_id" != "$current_run_id" || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"; terminal_arg=""
    test ! -r "$terminal" || test -r "$manifest" || return 1
    test -r "$manifest" || continue
    test ! -r "$terminal" || terminal_arg="$terminal"
    validate_cleanup_archive "$manifest" "$terminal_arg" "$run_id" || return 1
  done
}
cleanup_failed_images() {
  local run_id="$1" selected_sha="$2" run manifest build_sequence build_log before after removed removed_containers removed_superseded removed_qa id tags ref revision project prior_server prior_sidecar floor floor_epoch created created_epoch status mounts labels used_images candidates config_image
  local -a selected_refs=() image_ids=() container_ids=() superseded_refs=() qa_refs=()
  local -A seen_images=() seen_containers=() seen_refs=()
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || die cleanup-run-id
  [[ "$selected_sha" =~ ^[0-9a-f]{40}$ ]] || die cleanup-selected-sha
  test "$MS_PROJECT" = deploy || die cleanup-project
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  test -r "$manifest" || die cleanup-manifest-missing
  strict_json_file "$manifest" || die cleanup-manifest-json-invalid
  strict_json_file "$MS_LEASE" || die cleanup-lease-json-invalid
  validate_cleanup_json_records "$run_id" || die cleanup-task-json-invalid
  jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" --arg sha "$selected_sha" \
    '.schema==$schema and .runId==$runId and .selectedSha==$sha and (.priorState.serverImage|test("^sha256:[0-9a-f]{64}$")) and ((.priorState.sidecarImage // "")|test("^(|sha256:[0-9a-f]{64})$"))' "$manifest" >/dev/null || die cleanup-manifest-binding
  jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" --arg sha "$selected_sha" \
    '.schema==$schema and .runId==$runId and .selectedSha==$sha and .state=="expired" and .restoreState=="restored"' "$MS_LEASE" >/dev/null || die cleanup-lease-binding
  build_sequence="$(terminal_cleanup_build_sequence "$MS_LEASE")" || die cleanup-build-operation
  build_log="$run/operations/$build_sequence.log"; test -r "$build_log" || die cleanup-build-log
  prior_server="$(jq -r .priorState.serverImage "$manifest")"; prior_sidecar="$(jq -r '.priorState.sidecarImage // empty' "$manifest")"
  floor="$(task_event_floor)"; test -n "$floor" || die cleanup-event-floor
  floor_epoch="$(date -d "$floor" +%s)" || die cleanup-event-floor
  used_images="$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}')" || die cleanup-container-images

  for ref in "discord-music-server:$selected_sha" "discord-music-media-sidecar:$selected_sha"; do
    id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"; test -n "$id" || continue
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cleanup-image-id
    revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" || die cleanup-image-revision
    test "$revision" = "$selected_sha" || die cleanup-image-revision
    grep -Fxq "$id" <<<"$used_images" && die cleanup-image-in-use
    selected_refs+=("$ref")
  done

  candidates="$(sed $'s/\033\[[0-9;]*m//g' "$build_log" | sed -n 's/^ ---> \([0-9a-f]\{12,64\}\)$/\1/p'; task_build_image_ids)"
  while read -r id; do
    test -n "$id" || continue
    id="$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null || true)"; test -n "$id" || continue
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cleanup-image-id
    test "$id" != "$prior_server" && test "$id" != "$prior_sidecar" || continue
    grep -Fxq "$id" <<<"$used_images" && continue
    tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")" || die cleanup-image-tags
    test "$tags" = null || test "$tags" = '[]' || continue
    test -n "${seen_images[$id]:-}" || { seen_images[$id]=1; image_ids+=("$id"); }
  done <<<"$candidates"

  candidates="$(task_build_container_ids; sed $'s/\033\[[0-9;]*m//g' "$build_log" | sed -n 's/^ ---> Running in \([0-9a-f]\{12,64\}\)$/\1/p')"
  while read -r id; do
    test -n "$id" || continue
    id="$(docker inspect -f '{{.Id}}' "$id" 2>/dev/null || true)"; test -n "$id" || continue
    [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || die cleanup-container-id
    status="$(docker inspect -f '{{.State.Status}}' "$id")" || die cleanup-container-status; test "$status" = exited || continue
    mounts="$(docker inspect -f '{{len .Mounts}}' "$id")" || die cleanup-container-mounts; test "$mounts" -eq 0 || continue
    labels="$(docker inspect -f '{{json .Config.Labels}}' "$id")" || die cleanup-container-labels; test "$labels" = null || test "$labels" = '{}' || continue
    created="$(docker inspect -f '{{.Created}}' "$id")" || die cleanup-container-created
    created_epoch="$(date -d "$created" +%s)" || die cleanup-container-created; test "$created_epoch" -ge "$floor_epoch" || continue
    test -n "${seen_containers[$id]:-}" || { seen_containers[$id]=1; container_ids+=("$id"); }
  done <<<"$candidates"

  candidates="$(docker ps -aq --filter status=exited)" || die cleanup-container-list
  while read -r id; do
    test -n "$id" || continue
    id="$(docker inspect -f '{{.Id}}' "$id")" || die cleanup-container-id
    [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || die cleanup-container-id
    mounts="$(docker inspect -f '{{len .Mounts}}' "$id")" || die cleanup-container-mounts; test "$mounts" -eq 0 || continue
    labels="$(docker inspect -f '{{json .Config.Labels}}' "$id")" || die cleanup-container-labels; test "$labels" = null || test "$labels" = '{}' || continue
    config_image="$(docker inspect -f '{{.Config.Image}}' "$id")" || die cleanup-container-image
    tags="$(docker image inspect -f '{{json .RepoTags}}' "$config_image")" || die cleanup-image-tags; test "$tags" = null || test "$tags" = '[]' || continue
    created="$(docker inspect -f '{{.Created}}' "$id")" || die cleanup-container-created
    created_epoch="$(date -d "$created" +%s)" || die cleanup-container-created; test "$created_epoch" -ge "$floor_epoch" || continue
    test -n "${seen_containers[$id]:-}" || { seen_containers[$id]=1; container_ids+=("$id"); }
  done <<<"$candidates"

  candidates="$(docker images -q --filter dangling=true --no-trunc | sort -u)" || die cleanup-image-list
  while read -r id; do
    test -n "$id" || continue
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cleanup-image-id
    created="$(docker image inspect -f '{{.Created}}' "$id")" || die cleanup-image-created
    created_epoch="$(date -d "$created" +%s)" || die cleanup-image-created; test "$created_epoch" -ge "$floor_epoch" || continue
    test "$id" != "$prior_server" && test "$id" != "$prior_sidecar" || continue
    grep -Fxq "$id" <<<"$used_images" && continue
    tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")" || die cleanup-image-tags; test "$tags" = null || test "$tags" = '[]' || continue
    test -n "${seen_images[$id]:-}" || { seen_images[$id]=1; image_ids+=("$id"); }
  done <<<"$candidates"

  while read -r ref; do
    test -n "$ref" || continue; revision="${ref##*:}"
    test "$revision" != "$selected_sha" || continue
    id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"; test -n "$id" || continue
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cleanup-image-id
    test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" = "$revision" || die cleanup-image-revision
    grep -Fxq "$id" <<<"$used_images" && continue
    test -n "${seen_refs[$ref]:-}" || { seen_refs[$ref]=1; superseded_refs+=("$ref"); }
  done < <(for candidate in "$MS_BACKUP"/*/manifest.json; do test -r "$candidate" || continue; jq -er 'select(.selectedSha|type=="string" and test("^[0-9a-f]{40}$"))|.selectedSha as $sha|["discord-music-server:\($sha)","discord-music-media-sidecar:\($sha)"][]' "$candidate" || continue; done | sort -u)

  candidates="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^discord-music-(node|media-sidecar):qa-[0-9a-f]{40}$' || true)"
  while read -r ref; do
    test -n "$ref" || continue
    revision="${ref##*:qa-}"
    id="$(docker image inspect -f '{{.Id}}' "$ref")" || die cleanup-image-id
    [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cleanup-image-id
    project="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$ref")" || die cleanup-image-project
    test "$project" = "discord-music-sidecar-qa-${revision:0:12}" || die cleanup-image-project
    test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" = "$revision" || die cleanup-image-revision
    grep -Fxq "$id" <<<"$used_images" && continue
    test -n "${seen_refs[$ref]:-}" || { seen_refs[$ref]=1; qa_refs+=("$ref"); }
  done <<<"$candidates"

  before="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"; removed=0; removed_containers=0; removed_superseded=0; removed_qa=0
  for id in "${container_ids[@]}"; do if docker container rm "$id" >/dev/null; then removed_containers=$((removed_containers+1)); fi; done
  for ref in "${selected_refs[@]}"; do if docker image rm "$ref" >/dev/null; then removed=$((removed+1)); fi; done
  for id in "${image_ids[@]}"; do if docker image rm "$id" >/dev/null; then removed=$((removed+1)); fi; done
  for ref in "${superseded_refs[@]}"; do if docker image rm "$ref" >/dev/null; then removed_superseded=$((removed_superseded+1)); fi; done
  for ref in "${qa_refs[@]}"; do if docker image rm "$ref" >/dev/null; then removed_qa=$((removed_qa+1)); fi; done
  after="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"
  jq --argjson removed "$removed" --argjson containers "$removed_containers" --argjson superseded "$removed_superseded" --argjson qa "$removed_qa" --argjson before "$before" --argjson after "$after" '.cleanup={failedBuildImagesRemoved:$removed,failedBuildContainersRemoved:$containers,supersededSelectedTagsRemoved:$superseded,temporaryQaTagsRemoved:$qa,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}' "$MS_LEASE" | lease_write
  jq -cn --argjson removed "$removed" --argjson containers "$removed_containers" --argjson superseded "$removed_superseded" --argjson qa "$removed_qa" --argjson before "$before" --argjson after "$after" '{ok:true,state:"expired",restoreState:"restored",failedBuildImagesRemoved:$removed,failedBuildContainersRemoved:$containers,supersededSelectedTagsRemoved:$superseded,temporaryQaTagsRemoved:$qa,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}'
}
cleanup_terminal_space() {
  local run_id="$1" selected_sha="$2" before after cutoff removed id created created_epoch tags digests
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .selectedSha)" = "$selected_sha" || die selected-sha
  test "$(lease_value .state)" = committed || { test "$(lease_value .state)" = expired && test "$(lease_value .restoreState)" = restored || die cleanup-state; }
  before="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"; cutoff="$(date -d "$MS_DANGLING_RETENTION_DAYS days ago" +%s)"; removed=0
  while read -r id; do
    test -n "$id" || continue
    docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
    tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")"; test "$tags" = null || test "$tags" = '[]' || continue
    digests="$(docker image inspect -f '{{json .RepoDigests}}' "$id")"; test "$digests" = null || test "$digests" = '[]' || continue
    created="$(docker image inspect -f '{{.Created}}' "$id")"; created_epoch="$(date -d "$created" +%s)"; test "$created_epoch" -lt "$cutoff" || continue
    docker image rm "$id" >/dev/null; removed=$((removed+1))
  done < <(docker images -q --filter dangling=true --no-trunc | sort -u)
  after="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"
  jq -cn --argjson removed "$removed" --argjson before "$before" --argjson after "$after" '{ok:true,terminalLeaseUnchanged:true,expiredDanglingImagesRemoved:$removed,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}'
}
repair_terminal_retention() {
  local run_id="$1" selected_sha="$2" repaired
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .selectedSha)" = "$selected_sha" || die selected-sha
  test "$(lease_value .state)" = committed || { test "$(lease_value .state)" = expired && test "$(lease_value .restoreState)" = restored || die repair-state; }
  repaired="$(repair_retained_tags_locked)"
  jq -cn --argjson repaired "$repaired" '{ok:true,terminalLeaseUnchanged:true,rollbackTagsRepaired:$repaired,volumesRemoved:0}'
}
docker_image_identity() {
  local excluded="${1:-}"
  while read -r image; do
    test -n "$image" || continue
    test "$image" != "$excluded" || continue
    docker image inspect -f '{{.Id}} {{json .RepoDigests}}' "$image"
  done < <(docker images -q --no-trunc | sort -u)
}
docker_volume_identity() {
  while read -r volume; do
    test -n "$volume" || continue
    docker volume inspect -f '{{.Name}} {{.Driver}} {{.Mountpoint}} {{json .Labels}} {{json .Options}} {{.Scope}}' "$volume"
  done < <(docker volume ls -q | sort -u)
}
qa_image_in_use() {
  local image_id="$1" containers container observed
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die cache-cleanup-image-id
  containers="$(docker ps -aq)" || die cache-cleanup-container-list
  while IFS= read -r container; do
    test -n "$container" || continue
    observed="$(docker inspect -f '{{.Image}}' "$container")" || die cache-cleanup-container-inspect
    [[ "$observed" =~ ^sha256:[0-9a-f]{64}$ ]] || die cache-cleanup-container-image
    test "$observed" = "$image_id" && return 0
  done <<<"$containers"
  return 1
}
cleanup_terminal_build_cache() {
  local run_id="$1" selected_sha="$2" config qa_ref qa_id qa_project qa_revision qa_removed images_before images_after volumes_before volumes_after state_before state_after before after
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .selectedSha)" = "$selected_sha" || die selected-sha
  test "$(lease_value .state)" = committed || { test "$(lease_value .state)" = expired && test "$(lease_value .restoreState)" = restored || die cache-cleanup-state; }
  jq -e '.activeMutation==null and (.acceptedOperations|all(.status!="accepted"))' "$MS_LEASE" >/dev/null || die cache-cleanup-operation-active
  ps -eo args= | grep -E '(^|[ /])(docker|buildctl|buildx)[^[:cntrl:]]* (build|bake)( |$)' >/dev/null && die cache-cleanup-build-active
  config="$(active_config)"; qa_ref="discord-music-media-sidecar:qa-$selected_sha"; qa_id="$(docker image inspect -f '{{.Id}}' "$qa_ref" 2>/dev/null || true)"; qa_removed=0
  if test -n "$qa_id"; then
    qa_project="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$qa_ref")"
    qa_revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$qa_ref")"
    test "$qa_project" = "discord-music-sidecar-qa-${selected_sha:0:12}" || die cache-cleanup-qa-project
    test "$qa_revision" = "$selected_sha" || die cache-cleanup-qa-revision
    qa_image_in_use "$qa_id" && die cache-cleanup-qa-in-use || true
  fi
  images_before="$(docker_image_identity "$qa_id" | sort | sha256sum | cut -d' ' -f1)"; volumes_before="$(docker_volume_identity | sort | sha256sum | cut -d' ' -f1)"
  state_before="$(state_fingerprint "$config")"; before="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"
  if test -n "$qa_id"; then docker image rm "$qa_ref" >/dev/null; qa_removed=1; fi
  docker builder prune --filter until=0s --force >/dev/null
  images_after="$(docker_image_identity "$qa_id" | sort | sha256sum | cut -d' ' -f1)"; volumes_after="$(docker_volume_identity | sort | sha256sum | cut -d' ' -f1)"
  state_after="$(state_fingerprint "$config")"; after="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"
  test "$images_before" = "$images_after" || die cache-cleanup-images-changed
  test "$volumes_before" = "$volumes_after" || die cache-cleanup-volumes-changed
  test "$state_before" = "$state_after" || die cache-cleanup-state-changed
  test "$after" -ge 2048 || die cache-cleanup-capacity
  jq -cn --argjson before "$before" --argjson after "$after" --argjson qaRemoved "$qa_removed" '{ok:true,terminalLeaseUnchanged:true,filter:"until=0s",temporaryQaImageRemoved:$qaRemoved,imagesUnchanged:true,volumesUnchanged:true,liveStateUnchanged:true,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}'
}
commit_run() {
  local run_id="$1" expected="$2" next run manifest config cursor events_until observed quiet_since quiet_until quiet_events sample1 sample2 stable_at
  require_root; exec 9>"$MS_LOCK"; flock -x 9; cas_active "$run_id" "$expected"; next=$((expected+1))
  jq -e '.activeMutation==null and (.acceptedOperations|all(.status!="accepted"))' "$MS_LEASE" >/dev/null || die accepted-operation-active
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"; strict_json_file "$manifest" || die manifest-json-invalid
  config="$(jq -r .configPath "$manifest")"; cursor="$(lease_value .eventCursor)"
  events_until="$(date --iso-8601=ns)"
  observed="$(project_mutation_event_count "$cursor" "$events_until")"
  sample1="$(state_fingerprint "$config")"; quiet_since="$(date +%s)"; sleep 5
  sample2="$(state_fingerprint "$config")"; quiet_until="$(date +%s)"
  quiet_events="$(project_mutation_event_count "$quiet_since" "$quiet_until")"
  test "$sample1" = "$sample2" || die commit-state-unstable
  test "$quiet_events" -eq 0 || die commit-daemon-not-quiet
  cas_active "$run_id" "$expected"; stable_at="$(boottime)"
  jq --argjson sequence "$next" --arg cursor "$cursor" --argjson observed "$observed" --argjson stableAt "$stable_at" '.sequence=$sequence | .state="committed" | .restoreState="idle" | .stableSamples=2 | .activeMutation=null | .eventProof={cursor:$cursor,observedCount:$observed,quietWindowEvents:0,stableAtBoottime:$stableAt}' "$MS_LEASE" | lease_write
  jq -cn --arg runId "$run_id" --argjson sequence "$next" --argjson observed "$observed" --argjson stableAt "$stable_at" '{ok:true,runId:$runId,sequence:$sequence,state:"committed",eventProof:{retained:true,observedCount:$observed,quietWindowEvents:0,stableAtBoottime:$stableAt}}'
}
state() { require_root; strict_json_file "$MS_LEASE" || die lease-json-invalid; jq -c '{ok:true,runId,generation,selectedSha,sequence,state,restoreState,stableSamples,deadlineClock,lateDaemonDetected,reconcilePasses,eventProof,acceptedOperationCount:(.acceptedOperations|length),acceptedOperationsTerminal:(.acceptedOperations|all(.status!="accepted")),activeOperation:(.activeMutation.operation // null)}' "$MS_LEASE"; }

case "${1:-}" in
  preflight) preflight;;
  begin-run) begin_run;;
  mutate) shift; mutate "$@";;
  perform) shift; perform "$@";;
  expire) shift; expire "$@";;
  watchdog) shift; watchdog "$@";;
  delayed-daemon) shift; delayed_daemon "$@";;
  recover-restoring) shift; recover_restoring "$@";;
  reclaim-consumed-inputs) shift; reclaim_consumed_inputs "$@";;
  cleanup-failed-images) shift; cleanup_failed_images "$@";;
  cleanup-terminal-space) shift; cleanup_terminal_space "$@";;
  repair-terminal-retention) shift; repair_terminal_retention "$@";;
  cleanup-terminal-build-cache) shift; cleanup_terminal_build_cache "$@";;
  commit) shift; commit_run "$@";;
  state) state;;
  *) die command;;
esac
