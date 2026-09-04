#!/usr/bin/env bash
# allow: SIZE_OK - this is one security-critical lease and rollback state machine.
set -Eeuo pipefail
umask 077

readonly MS_SCHEMA="discord-music-deploy-lease.v1"
readonly MS_REPO="${MEDIA_REPO:-/opt/discord-music}"
readonly MS_BACKUP="${MEDIA_BACKUP_ROOT:-/root/discord-music-rollbacks}"
readonly MS_LOCK="${MEDIA_LOCK_FILE:-/run/lock/discord-music-deploy.lock}"
readonly MS_LEASE="${MEDIA_LEASE_FILE:-$MS_BACKUP/active.json}"
readonly MS_COUNTER="${MEDIA_RUN_COUNTER:-$MS_BACKUP/run-counter}"
readonly MS_PROJECT="${MEDIA_COMPOSE_PROJECT:-deploy}"
readonly MS_SHA="${MEDIA_SELECTED_SHA:-}"
readonly MS_OWNER_B64="${MEDIA_OWNER_B64:-}"
readonly MS_DEADLINE_SECONDS="${MEDIA_DEADLINE_SECONDS:-600}"
readonly MS_SELF="${BASH_SOURCE[0]:-/dev/stdin}"
readonly MS_RETENTION_DAYS="${MEDIA_RETENTION_DAYS:-7}"

die() { printf '{"ok":false,"stage":"%s"}\n' "$1" >&2; exit 1; }
boottime() { awk '{printf "%d", $1}' /proc/uptime; }
atomic_file() {
  local target="$1" mode="$2" temp
  temp="${target}.tmp.$$"
  cat >"$temp"
  chmod "$mode" "$temp"
  sync -f "$temp"
  mv -f "$temp" "$target"
  sync -f "$(dirname "$target")"
}
lease_value() { jq -er "$1" "$MS_LEASE"; }
lease_write() { atomic_file "$MS_LEASE" 0600; }
cleanup_retention_locked() {
  local current candidate run_id manifest terminal server_tag sidecar_tag
  current="$(test -r "$MS_LEASE" && lease_value .runId || true)"
  while IFS= read -r -d '' candidate; do
    run_id="${candidate##*/}"
    [[ "$run_id" =~ ^[1-9][0-9]*-[0-9a-f]{32}$ ]] || continue
    test "$run_id" != "$current" || continue
    manifest="$candidate/manifest.json"; terminal="$candidate/terminal.json"
    test -f "$manifest" && test -f "$terminal" || continue
    jq -e --arg schema "$MS_SCHEMA" --arg runId "$run_id" '.schema==$schema and .runId==$runId and (.selectedSha|test("^[0-9a-f]{40}$"))' "$manifest" >/dev/null || continue
    jq -e --arg runId "$run_id" '.runId==$runId and (.state=="committed" or (.state=="expired" and .restoreState=="restored"))' "$terminal" >/dev/null || continue
    test "$(sha256sum "$candidate/compose.yaml"|cut -d' ' -f1)" = "$(jq -r .composeHash "$manifest")" || continue
    test "$(sha256sum "$candidate/deploy.env"|cut -d' ' -f1)" = "$(jq -r .envHash "$manifest")" || continue
    server_tag="$(jq -r '.rollbackTags.server // empty' "$manifest")"; sidecar_tag="$(jq -r '.rollbackTags.sidecar // empty' "$manifest")"
    test -z "$server_tag" || docker image rm "$server_tag" >/dev/null 2>&1 || true
    test -z "$sidecar_tag" || docker image rm "$sidecar_tag" >/dev/null 2>&1 || true
    rm -rf -- "$candidate"
  done < <(find "$MS_BACKUP" -mindepth 1 -maxdepth 1 -type d -mtime "+$MS_RETENTION_DAYS" -print0)
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
  test "$MS_REPO" = /opt/discord-music || die wrong-repository
  test "$MS_BACKUP" = /root/discord-music-rollbacks || die wrong-backup-root
  test "$MS_LOCK" = /run/lock/discord-music-deploy.lock || die wrong-lock
  test "$MS_LEASE" = /root/discord-music-rollbacks/active.json || die wrong-lease
  test "$MS_COUNTER" = /root/discord-music-rollbacks/run-counter || die wrong-counter
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
preflight() {
  require_root; require_paths
  test -r "$MS_REPO/.git/HEAD" || die repository-missing
  git -C "$MS_REPO" diff --quiet && git -C "$MS_REPO" diff --cached --quiet || die tracked-tree-dirty
  command -v docker >/dev/null; docker info >/dev/null
  test "$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')" -ge "${MEDIA_MIN_FREE_MIB:-2048}" || die disk-capacity
  local config status extras lease_state restore_state before after
  config="$(active_config)"; test -r "$config"; test -r "$(dirname "$config")/.env"
  status="$(git -C "$MS_REPO" status --porcelain)"
  extras="$(printf '%s\n' "$status" | awk '$1=="??" {print $2}' | grep -vFx "${config#"$MS_REPO"/}" || true)"
  test -z "$extras" || die unexpected-untracked-path
  before="$(test -e "$MS_BACKUP" && find "$MS_BACKUP" -maxdepth 2 -printf '%P:%s:%T@\n' | sort | sha256sum | cut -d' ' -f1 || echo absent)"
  lease_state="$(test -r "$MS_LEASE" && jq -er .state "$MS_LEASE" || echo absent)"
  restore_state="$(test -r "$MS_LEASE" && jq -er .restoreState "$MS_LEASE" || echo absent)"
  after="$(test -e "$MS_BACKUP" && find "$MS_BACKUP" -maxdepth 2 -printf '%P:%s:%T@\n' | sort | sha256sum | cut -d' ' -f1 || echo absent)"
  test "$before" = "$after" || die preflight-write
  jq -cn --arg sha "$(git -C "$MS_REPO" rev-parse HEAD)" --arg configHash "$(sha256sum "$config"|cut -d' ' -f1)" \
    --arg lease "$lease_state" --arg restore "$restore_state" --arg snapshot "$after" \
    '{ok:true,readOnly:true,trackedClean:true,protectedConfig:true,sha:$sha,configHash:$configHash,lease:$lease,restoreState:$restore,writeSnapshot:$snapshot}'
}
begin_run() {
  require_root; require_paths
  [[ "$MS_SHA" =~ ^[0-9a-f]{40}$ ]] || die selected-sha
  [[ "$MS_DEADLINE_SECONDS" =~ ^[0-9]+$ ]] || die deadline
  install -d -m 0700 "$MS_BACKUP"
  test -e "$MS_LOCK" || install -m 0600 /dev/null "$MS_LOCK"
  test "$(stat -c %U:%G:%a "$MS_LOCK")" = root:root:600 || die lock-mode
  exec 9>"$MS_LOCK"; flock -x 9
  if test -r "$MS_LEASE"; then
    local prior_state prior_restore prior_id
    prior_state="$(lease_value .state)"; prior_restore="$(lease_value .restoreState)"
    test "$prior_state" != active || die active-run-exists
    test "$prior_state" != expired || test "$prior_restore" = restored || die restoration-incomplete
    prior_id="$(lease_value .runId)"
    test -d "$MS_BACKUP/$prior_id" || die prior-checkpoint-missing
    cp -p "$MS_LEASE" "$MS_BACKUP/$prior_id/terminal.json.tmp"
    sync -f "$MS_BACKUP/$prior_id/terminal.json.tmp"
    mv -f "$MS_BACKUP/$prior_id/terminal.json.tmp" "$MS_BACKUP/$prior_id/terminal.json"
    sync -f "$MS_BACKUP/$prior_id"
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
    '{schema:$schema,runId:$runId,generation:$generation,selectedSha:$selectedSha,sequence:$sequence,deadlineClock:"CLOCK_BOOTTIME",deadlineBoottime:$deadline,eventCursor:$eventCursor,state:"active",restoreState:"idle",stableSamples:0,lateDaemonDetected:false,reconcilePasses:0,eventProof:null,acceptedOperations:[],activeMutation:null}' | lease_write
  nohup setsid "$run/owner.sh" watchdog "$run_id" >/dev/null 2>&1 </dev/null 9>&- &
  cleanup_retention_locked
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
lease_replace() { local filter="$1"; jq "$filter" "$MS_LEASE" | lease_write; }
perform() {
  local run_id="$1" sequence="$2" operation="$3" run manifest config working
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  config="$(jq -r .configPath "$manifest")"; working="$(jq -r .workingDir "$manifest")"
  case "$operation" in
    tag-prior)
      docker tag "$(jq -r .priorState.serverImage "$manifest")" "$(jq -r .rollbackTags.server "$manifest")"
      if jq -e '.priorState.sidecarPresent' "$manifest" >/dev/null; then docker tag "$(jq -r .priorState.sidecarImage "$manifest")" "$(jq -r .rollbackTags.sidecar "$manifest")"; fi
      ;;
    receive-bundle) cat >"$run/source.bundle"; chmod 0600 "$run/source.bundle"; sync -f "$run/source.bundle";;
    checkout)
      git -C "$MS_REPO" fetch "$run/source.bundle" "$MS_SHA"
      git -C "$MS_REPO" merge --ff-only "$MS_SHA"
      test "$(git -C "$MS_REPO" rev-parse HEAD)" = "$MS_SHA"
      test -z "$(git -C "$MS_REPO" diff --name-only)"
      ;;
    build)
      local tree before; tree="$(git -C "$MS_REPO" rev-parse 'HEAD^{tree}')"; before="$run/images-before-build"
      docker images -q --no-trunc | sort -u >"$before"; chmod 0600 "$before"; sync -f "$before"
      docker build -t "discord-music-server:$MS_SHA" --build-arg "BUILD_SHA=$MS_SHA" --build-arg "BUILD_TREE=$tree" "$MS_REPO"
      docker build -t "discord-music-media-sidecar:$MS_SHA" -f "$MS_REPO/Dockerfile.media-sidecar" --build-arg "BUILD_SHA=$MS_SHA" --build-arg "BUILD_TREE=$tree" "$MS_REPO"
      remove_new_untagged_images "$before"
      ;;
    configure-shadow|configure-rust|configure-disabled)
      local mode="${operation#configure-}" env_temp="${working}/.env.run-$run_id"
      awk -v mode="$mode" 'BEGIN{done=0} /^MEDIA_SIDECAR_MODE=/{if(!done){print "MEDIA_SIDECAR_MODE=" mode;done=1}next} {print} END{if(!done)print "MEDIA_SIDECAR_MODE=" mode}' "$working/.env" >"$env_temp"
      chmod 0600 "$env_temp"; sync -f "$env_temp"; mv -f "$env_temp" "$working/.env"; sync -f "$working"
      cat >"$config" <<YAML
services:
  server:
    image: discord-music-server:$MS_SHA
    container_name: discord-music
    restart: unless-stopped
    env_file: [.env]
    environment:
      DATABASE_PATH: /data/discord-music.sqlite
      HOST: 0.0.0.0
      PORT: 3000
      MEDIA_SIDECAR_URL: http://media-sidecar:3101
    ports: ["3000:3000"]
    volumes:
      - discord-music-data:/data
      - /opt/discord-music-secrets:/run/secrets/discord-music
    depends_on:
      media-sidecar:
        condition: service_healthy
    links: [media-sidecar]
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
  media-sidecar:
    image: discord-music-media-sidecar:$MS_SHA
    restart: unless-stopped
    environment: {SIDECAR_HOST: 0.0.0.0, SIDECAR_PORT: 3101}
    expose: ["3101"]
    healthcheck:
      test: ["CMD", "deno", "eval", "const r=await fetch('http://127.0.0.1:3101/healthz');if(r.status!==200)Deno.exit(1)"]
      interval: 5s
      timeout: 3s
      retries: 6
      start_period: 5s
volumes:
  discord-music-data:
    external: true
    name: deploy_discord-music-data
YAML
      chmod 0600 "$config"; sync -f "$config"; sync -f "$working"
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
      node_probe='{"dnsCount":0,"healthStatus":0,"searchStatus":0,"resultCount":0,"failure":"not_run"}'
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
          try { dnsCount=(await import("node:dns/promises")).resolve4("media-sidecar").then((items)=>items.length).catch(()=>0); dnsCount=await dnsCount } catch { failure="dns" }
          try {
            const health=await fetch("http://media-sidecar:3101/healthz",{signal:AbortSignal.timeout(5000)})
            healthStatus=health.status
            const search=await fetch("http://media-sidecar:3101/v1/search",{method:"POST",headers:{"content-type":"application/json","x-media-sidecar-correlation-id":"00000000-0000-4000-8000-000000000001"},body:JSON.stringify({version:1,query:"never gonna give you up official video node probe"}),signal:AbortSignal.timeout(5000)})
            searchStatus=search.status
            const body=await search.json().catch(()=>({}))
            resultCount=Array.isArray(body.results)?body.results.length:0
          } catch { failure="transport" }
          console.log(JSON.stringify({dnsCount,healthStatus,searchStatus,resultCount,failure}))
        ')"
        node_probe="$(jq -ce '{dnsCount,healthStatus,searchStatus,resultCount,failure}' <<<"$node_probe")"
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
  if [[ "$operation" == benchmark-* ]]; then tail -1 "$log" | jq -ce .; else jq -cn --argjson sequence "$next" --arg operation "$operation" '{ok:true,sequence:$sequence,operation:$operation}'; fi
}
restore_locked() {
  local run_id="$1" run manifest config working server_ref sidecar_ref server_source sidecar_source deadline sample1 sample2 events_since events_until event_count observed_count desired marker
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"
  config="$(jq -r .configPath "$manifest")"; working="$(jq -r .workingDir "$manifest")"
  server_ref="$(jq -r .priorState.serverRef "$manifest")"; sidecar_ref="$(jq -r '.priorState.sidecarRef // empty' "$manifest")"
  desired="$(jq -r .desiredFingerprint "$manifest")"; marker="$run/restore-first-sample"
  deadline=$(( $(boottime)+120 )); events_since="$(jq -r .eventCursor "$manifest")"; events_until="$(date +%s)"
  observed_count="$(docker events --since "$events_since" --until "$events_until" --filter "label=com.docker.compose.project=$MS_PROJECT" --format '{{json .}}' | wc -l)"
  while test "$(boottime)" -lt "$deadline"; do
    cp "$run/compose.yaml" "$config"; cp "$run/deploy.env" "$working/.env"; chmod 0600 "$config" "$working/.env"
    git -C "$MS_REPO" reset --hard "$(jq -r .priorState.git "$manifest")" >/dev/null
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
    event_count="$(docker events --since "$events_since" --until "$events_until" --filter "label=com.docker.compose.project=$MS_PROJECT" --format '{{json .}}' | wc -l)"; observed_count=$((observed_count+event_count))
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
    done < <(jq -r '.acceptedOperations[]|select(.operation=="build")|.sequence' "$terminal")
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
    done < <(jq -r '.acceptedOperations[]|select(.operation=="build")|.sequence' "$terminal")
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
cleanup_failed_images() {
  local run_id="$1" selected_sha="$2" run manifest build_sequence build_log before after removed removed_containers removed_superseded removed_qa id tags ref revision project prior_server prior_sidecar pass_removed floor floor_epoch created created_epoch status mounts labels
  require_root; require_paths; exec 9>"$MS_LOCK"; flock -x 9
  test "$(lease_value .runId)" = "$run_id" || die wrong-run
  test "$(lease_value .selectedSha)" = "$selected_sha" || die selected-sha
  test "$(lease_value .state)" = expired && test "$(lease_value .restoreState)" = restored || die cleanup-state
  run="$MS_BACKUP/$run_id"; manifest="$run/manifest.json"; before="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"; removed=0; removed_containers=0; removed_superseded=0; removed_qa=0
  prior_server="$(jq -r .priorState.serverImage "$manifest")"; prior_sidecar="$(jq -r '.priorState.sidecarImage // empty' "$manifest")"
  for tags in "discord-music-server:$selected_sha" "discord-music-media-sidecar:$selected_sha"; do
    id="$(docker image inspect -f '{{.Id}}' "$tags" 2>/dev/null || true)"; test -n "$id" || continue
    docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && die cleanup-image-in-use
    docker image rm "$tags" >/dev/null; removed=$((removed+1))
  done
  build_sequence="$(jq -r '[.acceptedOperations[]|select(.operation=="build")|.sequence]|last // empty' "$MS_LEASE")"; build_log="$run/operations/$build_sequence.log"
  test -r "$build_log" || die cleanup-build-log
  for _ in 1 2 3; do
    while read -r id; do
      id="$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null || true)"; test -n "$id" || continue
      test "$id" != "$prior_server" && test "$id" != "$prior_sidecar" || continue
      docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
      tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")"; test "$tags" = null || test "$tags" = '[]' || continue
      docker image rm "$id" >/dev/null 2>&1 || continue; removed=$((removed+1))
    done < <(sed $'s/\033\[[0-9;]*m//g' "$build_log" | sed -n 's/^ ---> \([0-9a-f]\{12,64\}\)$/\1/p' | awk '!seen[$0]++')
  done
  for _ in $(seq 1 32); do
    pass_removed=0
    while read -r id; do
      id="$(docker image inspect -f '{{.Id}}' "$id" 2>/dev/null || true)"; test -n "$id" || continue
      test "$id" != "$prior_server" && test "$id" != "$prior_sidecar" || continue
      docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
      tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")"; test "$tags" = null || test "$tags" = '[]' || continue
      docker image rm "$id" >/dev/null 2>&1 || continue; removed=$((removed+1)); pass_removed=$((pass_removed+1))
    done < <(task_build_image_ids)
    test "$pass_removed" -gt 0 || break
  done
  floor="$(task_event_floor)"; test -n "$floor" || die cleanup-event-floor
  floor_epoch="$(date -d "$floor" +%s)"
  while read -r id; do
    id="$(docker inspect -f '{{.Id}}' "$id" 2>/dev/null || true)"; test -n "$id" || continue
    status="$(docker inspect -f '{{.State.Status}}' "$id")"; test "$status" = exited || continue
    mounts="$(docker inspect -f '{{len .Mounts}}' "$id")"; test "$mounts" -eq 0 || continue
    labels="$(docker inspect -f '{{json .Config.Labels}}' "$id")"; test "$labels" = null || test "$labels" = '{}' || continue
    created="$(docker inspect -f '{{.Created}}' "$id")"; created_epoch="$(date -d "$created" +%s)"; test "$created_epoch" -ge "$floor_epoch" || continue
    docker container rm "$id" >/dev/null; removed_containers=$((removed_containers+1))
  done < <(task_build_container_ids; sed $'s/\033\[[0-9;]*m//g' "$build_log" | sed -n 's/^ ---> Running in \([0-9a-f]\{12,64\}\)$/\1/p')
  while read -r id; do
    test -n "$id" || continue
    mounts="$(docker inspect -f '{{len .Mounts}}' "$id")"; test "$mounts" -eq 0 || continue
    tags="$(docker inspect -f '{{.Config.Image}}' "$id")"
    docker image inspect -f '{{json .RepoTags}}' "$tags" | grep -Eq '^(null|\[\])$' || continue
    created="$(docker inspect -f '{{.Created}}' "$id")"; created_epoch="$(date -d "$created" +%s)"; test "$created_epoch" -ge "$floor_epoch" || continue
    docker container rm "$id" >/dev/null; removed_containers=$((removed_containers+1))
  done < <(docker ps -aq --filter status=exited)
  for _ in $(seq 1 32); do
    pass_removed=0
    while read -r id; do
      test -n "$id" || continue
      created="$(docker image inspect -f '{{.Created}}' "$id")"; created_epoch="$(date -d "$created" +%s)"
      test "$created_epoch" -ge "$floor_epoch" || continue
      test "$id" != "$prior_server" && test "$id" != "$prior_sidecar" || continue
      docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
      tags="$(docker image inspect -f '{{json .RepoTags}}' "$id")"; test "$tags" = null || test "$tags" = '[]' || continue
      docker image rm "$id" >/dev/null 2>&1 || continue; removed=$((removed+1)); pass_removed=$((pass_removed+1))
    done < <(docker images -q --filter dangling=true --no-trunc | sort -u)
    test "$pass_removed" -gt 0 || break
  done
  while read -r ref; do
    test -n "$ref" || continue; revision="${ref##*:}"
    test "$revision" != "$selected_sha" || continue
    id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"; test -n "$id" || continue
    test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")" = "$revision" || continue
    docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
    docker image rm "$ref" >/dev/null; removed_superseded=$((removed_superseded+1))
  done < <(for candidate in "$MS_BACKUP"/*/manifest.json; do test -r "$candidate" || continue; jq -r '.selectedSha as $sha|["discord-music-server:\($sha)","discord-music-media-sidecar:\($sha)"][]' "$candidate"; done | sort -u)
  while read -r ref; do
    test -n "$ref" || continue
    id="$(docker image inspect -f '{{.Id}}' "$ref")"
    project="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$ref")"
    [[ "$project" == discord-music-sidecar-qa-* ]] || continue
    docker ps -aq | xargs -r docker inspect -f '{{.Image}}' | grep -Fxq "$id" && continue
    docker image rm "$ref" >/dev/null; removed_qa=$((removed_qa+1))
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^discord-music-(node|media-sidecar):qa-[0-9a-f]{40}$' || true)
  after="$(df -Pm "$MS_REPO" | awk 'NR==2 {print $4}')"
  jq --argjson removed "$removed" --argjson containers "$removed_containers" --argjson superseded "$removed_superseded" --argjson qa "$removed_qa" --argjson before "$before" --argjson after "$after" '.cleanup={failedBuildImagesRemoved:$removed,failedBuildContainersRemoved:$containers,supersededSelectedTagsRemoved:$superseded,temporaryQaTagsRemoved:$qa,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}' "$MS_LEASE" | lease_write
  jq -cn --argjson removed "$removed" --argjson containers "$removed_containers" --argjson superseded "$removed_superseded" --argjson qa "$removed_qa" --argjson before "$before" --argjson after "$after" '{ok:true,state:"expired",restoreState:"restored",failedBuildImagesRemoved:$removed,failedBuildContainersRemoved:$containers,supersededSelectedTagsRemoved:$superseded,temporaryQaTagsRemoved:$qa,freeMiBBefore:$before,freeMiBAfter:$after,volumesRemoved:0}'
}
commit_run() {
  local run_id="$1" expected="$2" next
  require_root; exec 9>"$MS_LOCK"; flock -x 9; cas_active "$run_id" "$expected"; next=$((expected+1))
  jq --argjson sequence "$next" '.sequence=$sequence | .state="committed" | .restoreState="idle" | .activeMutation=null' "$MS_LEASE" | lease_write
  jq -cn --arg runId "$run_id" --argjson sequence "$next" '{ok:true,runId:$runId,sequence:$sequence,state:"committed"}'
}
state() { require_root; jq -c '{ok:true,runId,generation,selectedSha,sequence,state,restoreState,stableSamples,deadlineClock,lateDaemonDetected,reconcilePasses,eventProof,acceptedOperationCount:(.acceptedOperations|length),acceptedOperationsTerminal:(.acceptedOperations|all(.status!="accepted")),activeOperation:(.activeMutation.operation // null)}' "$MS_LEASE"; }

case "${1:-}" in
  preflight) preflight;;
  begin-run) begin_run;;
  mutate) shift; mutate "$@";;
  perform) shift; perform "$@";;
  expire) shift; expire "$@";;
  watchdog) shift; watchdog "$@";;
  delayed-daemon) shift; delayed_daemon "$@";;
  recover-restoring) shift; recover_restoring "$@";;
  cleanup-failed-images) shift; cleanup_failed_images "$@";;
  commit) shift; commit_run "$@";;
  state) state;;
  *) die command;;
esac
