set -Eeuo pipefail
umask 077
if test "$VERIFY_MODE" = inspect; then
  stage=production-container
  failure() { printf 'failure_stage=%s\n' "$stage"; }
  trap failure ERR
  cd "$PRODUCTION_REPO"
  sidecar="$(docker compose ps -q media-sidecar)"
  test -n "$sidecar"
  test "$(docker inspect -f '{{.State.Running}}' "$sidecar")" = true
  test "$(docker inspect -f '{{.State.Health.Status}}' "$sidecar")" = healthy
  test -z "$(docker port "$sidecar")"
  stage=production-pins
  image="$(docker inspect -f '{{.Image}}' "$sidecar")"
  test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$CHECKPOINT_SHA"
  test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.yt-dlp.sha256"}}' "$image")" = 58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
  test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.deno.asset-sha256"}}' "$image")" = 8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530
  test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.extractor.proxy"}}' "$image")" = direct-empty
  test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.extractor.js-runtime"}}' "$image")" = deno:/usr/local/bin/deno
  test "$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" | awk -F= 'NF { print $1 }' | sort | paste -sd, -)" = HOME,LANG,LC_ALL,PATH,SSL_CERT_FILE,TMPDIR
  stage=production-processes
  docker exec "$sidecar" sh -ceu '
test "$(cat /proc/1/comm)" = tini
tr "\0" " " </proc/1/cmdline | grep -Eq "^/usr/bin/tini -s -- /usr/local/bin/discord-music-media-sidecar"
child="$(for p in /proc/[0-9]*; do test -r "$p/stat" || continue; set -- $(cat "$p/stat"); test "$4" = 1 && test "$2" = "(discord-music-m)" && echo "${p##*/}" && break; done)"; test -n "$child"
test "$(awk "/^Uid:/ {print \$2}" "/proc/$child/status")" = 10001
test "$(/usr/bin/tini --version 2>&1)" = "tini version 0.19.0"
/usr/local/bin/discord-music-media-sidecar --version | grep -F "build '"${CHECKPOINT_SHA:0:12}"'" >/dev/null
test "$(/usr/local/bin/yt-dlp --version)" = 2026.08.19
/usr/local/bin/deno --version | grep -F "deno 2.9.5" >/dev/null
! command -v node; ! command -v bun; ! command -v qjs; ! command -v ffmpeg'
  for attempt in $(seq 1 20); do
    process_state="$(docker top "$sidecar" -eo stat,comm | awk 'NR > 1 { count++; if ($1 ~ /^Z/) zombie=1 } END { printf "%s:%s", count, zombie + 0 }')"
    test "$process_state" = 2:0 && break
    sleep 0.1
  done
  test "$process_state" = 2:0
  printf 'checkpoint=%s\nproduction_private=true\nproduction_pins=true\nproduction_tini_subreaper=true\nproduction_descendants_clean=true\n' "$CHECKPOINT_SHA"
  exit 0
fi
work="$REMOTE_ROOT/$CHECKPOINT_SHA"; source="$work/source"; raw="$work/raw.log"
four_latched=not-run; deno_latched=not-run; environment_observed=not-run
cleanup() { cd /; CHECKPOINT_SHA="$CHECKPOINT_SHA" CHECKPOINT_TREE="$CHECKPOINT_TREE" docker compose -p "$PROJECT" -f "$source/$COMPOSE" down --remove-orphans --volumes >"$raw" 2>&1 || true; rm -rf -- "$work"; printf 'cleanup=true\n'; }
failure() { printf 'failure_stage=%s\nfour_latched=%s\ndeno_latched=%s\nenvironment_observed=%s\n' "$stage" "$four_latched" "$deno_latched" "$environment_observed"; }
trap cleanup EXIT
trap failure ERR
stage=clone
git clone --quiet --no-checkout "$work/source.bundle" "$source" >"$raw" 2>&1
git -C "$source" checkout --quiet --detach "$CHECKPOINT_SHA" >>"$raw" 2>&1
test "$(git -C "$source" rev-parse HEAD)" = "$CHECKPOINT_SHA"
test "$(git -C "$source" rev-parse 'HEAD^{tree}')" = "$CHECKPOINT_TREE"
test -z "$(git -C "$source" status --porcelain)"
cd "$source"; export CHECKPOINT_SHA CHECKPOINT_TREE; stage=compose-schema
test "$(docker compose -p "$PROJECT" -f "$COMPOSE" config --services | paste -sd, -)" = media-sidecar,probe
test "$(docker compose -p "$PROJECT" -f "$COMPOSE" config --images | sort | paste -sd, -)" = "discord-music-media-sidecar:qa-$CHECKPOINT_SHA,discord-music-node:qa-$CHECKPOINT_SHA"
docker compose -p "$PROJECT" -f "$COMPOSE" config >"$raw" 2>&1
! grep -Eq '^[[:space:]]+(ports|volumes|env_file|secrets|configs):|external:[[:space:]]*true' "$raw"
stage=context-clean
mkdir "$work/context"
printf 'FROM scratch\nCOPY . /\n' | docker build --quiet --output "type=local,dest=$work/context" -f - . >"$raw" 2>&1
! find "$work/context" -mindepth 1 \( -type d \( -name .git -o -name .omo -o -name secrets -o -name target \) -o -type f -iname '*cookies*' \) -print -quit | grep -q .
stage=image-build; docker compose -p "$PROJECT" -f "$COMPOSE" build >"$raw" 2>&1
stage=compose-start; docker compose -p "$PROJECT" -f "$COMPOSE" up -d >"$raw" 2>&1
sidecar="$(docker compose -p "$PROJECT" -f "$COMPOSE" ps -q media-sidecar)"; probe="$(docker compose -p "$PROJECT" -f "$COMPOSE" ps -q probe)"
test -n "$sidecar"; test -n "$probe"; stage=sidecar-health
for attempt in $(seq 1 30); do test "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$sidecar")" = healthy && break; sleep 1; done
test "$(docker inspect -f '{{.State.Health.Status}}' "$sidecar")" = healthy; stage=image-labels
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "discord-music-media-sidecar:qa-$CHECKPOINT_SHA")" = "$CHECKPOINT_SHA"
test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.source-tree"}}' "discord-music-media-sidecar:qa-$CHECKPOINT_SHA")" = "$CHECKPOINT_TREE"
test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.yt-dlp.sha256"}}' "discord-music-media-sidecar:qa-$CHECKPOINT_SHA")" = 58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
test "$(docker image inspect -f '{{index .Config.Labels "io.discord-music.deno.asset-sha256"}}' "discord-music-media-sidecar:qa-$CHECKPOINT_SHA")" = 8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530
stage=history-clean
docker image history --no-trunc "discord-music-media-sidecar:qa-$CHECKPOINT_SHA" >"$raw"
! grep -Eqi '(authorization:|bearer[[:space:]]|begin [a-z ]*private key|authorized_keys|(^|[/ ])cookies?([^a-z]|$)|(^|[/ ])\.env([^a-z]|$))' "$raw"
test "$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "discord-music-media-sidecar:qa-$CHECKPOINT_SHA" | awk -F= 'NF { print $1 }' | sort | paste -sd, -)" = HOME,LANG,LC_ALL,PATH,SSL_CERT_FILE,TMPDIR
test -z "$(docker port "$sidecar")"; stage=private-health
docker exec "$probe" node -e "fetch('http://media-sidecar:3101/healthz').then(async r=>{if(r.status!==200||JSON.stringify(await r.json())!=='{\"version\":1,\"status\":\"ok\"}')process.exit(1)})" >"$raw" 2>&1
stage=sidecar-runtime
docker exec "$sidecar" sh -ceu '
test "$(cat /proc/1/comm)" = tini; tr "\0" " " </proc/1/cmdline | grep -Eq "^/usr/bin/tini -s -- /usr/local/bin/discord-music-media-sidecar"
child="$(for p in /proc/[0-9]*; do test -r "$p/stat" || continue; set -- $(cat "$p/stat"); test "$4" = 1 && test "$2" = "(discord-music-m)" && echo "${p##*/}" && break; done)"; test -n "$child"
test "$(awk "/^Uid:/ {print \$2}" "/proc/$child/status")" != 0
/usr/bin/tini --version 2>&1 | grep -F 0.19.0
/usr/local/bin/discord-music-media-sidecar --version | grep -F "build '"${CHECKPOINT_SHA:0:12}"'"
test "$(/usr/local/bin/yt-dlp --version)" = 2026.08.19
echo "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a  /usr/local/bin/yt-dlp" | sha256sum -c -
/usr/local/bin/deno --version | grep -F "deno 2.9.5"
! command -v node; ! command -v bun; ! command -v qjs; ! command -v ffmpeg
! grep -aEq "test-upstream|media-sidecar-test-harness" /usr/local/bin/discord-music-media-sidecar'
stage=node-fallback-tools
docker exec "$probe" sh -ceu 'ffmpeg -version >/dev/null; yt-dlp --version >/dev/null'
if test "$VERIFY_MODE" = smoke; then
  stage=challenge-smoke
  docker exec -d "$probe" node -e "const fs=require('node:fs'),net=require('node:net');fs.writeFileSync('/tmp/proxy-count','0');let n=0;net.createServer(s=>{n++;fs.writeFileSync('/tmp/proxy-count',String(n));s.destroy()}).listen(43123,'0.0.0.0');setInterval(()=>{},2147483647)"
  docker exec "$sidecar" sh -ceu 'umask 077; raw=/tmp/challenge.raw; trap "rm -f -- $raw" EXIT; HTTP_PROXY=http://probe:43123 HTTPS_PROXY=http://probe:43123 ALL_PROXY=http://probe:43123 NO_PROXY= http_proxy=http://probe:43123 https_proxy=http://probe:43123 all_proxy=http://probe:43123 no_proxy= /usr/bin/timeout 30 /usr/local/bin/yt-dlp --ignore-config --proxy "" --js-runtimes deno:/usr/local/bin/deno --no-playlist --no-warnings --simulate https://www.youtube.com/watch?v=jNQXAC9IVRw >$raw 2>&1'
  test "$(docker exec "$probe" cat /tmp/proxy-count | tr -d '\r')" = 0
fi
if test "$VERIFY_MODE" = drain; then
  stage=saturation-observation
  four_latched=false; deno_latched=false; environment_observed=false
  docker exec -d "$sidecar" sh -ceu '
rm -f /tmp/qa-deno-observed /tmp/qa-four-observed
for attempt in $(seq 1 20000); do
  count=0; deno_child=false
  for p in /proc/[0-9]*; do
    test -r "$p/comm" || continue
    comm="$(cat "$p/comm")"
    case "$comm" in
      yt-dlp*) count=$((count+1));;
      deno) ppid="$(awk "{print \$4}" "$p/stat")"; parent="$(cat "/proc/$ppid/comm" 2>/dev/null || true)"; case "$parent" in yt-dlp*) deno_child=true;; esac;;
    esac
  done
  test "$count" -eq 4 && : >/tmp/qa-four-observed
  $deno_child && : >/tmp/qa-deno-observed
  test -f /tmp/qa-four-observed && test -f /tmp/qa-deno-observed && exit 0
  sleep 0.001
done
exit 1'
  docker exec -d "$probe" node -e "const ids=['jNQXAC9IVRw','dQw4w9WgXcQ','9bZkp7q19f0','kJQP7kiw5Fk'];Promise.allSettled(ids.map((id,i)=>fetch('http://media-sidecar:3101/v1/resolve',{method:'POST',headers:{'content-type':'application/json','x-media-sidecar-correlation-id':['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'][i]},body:JSON.stringify({version:1,track:{id,url:'https://www.youtube.com/watch?v='+id}})}))).then(()=>process.exit())"
  observed=false; : >"$work/children"
  for attempt in $(seq 1 100); do
    count="$(docker exec "$sidecar" sh -ceu 'count=0; : >/tmp/qa-pids; for p in /proc/[0-9]*; do test -r "$p/comm" || continue; comm="$(cat "$p/comm")"; case "$comm" in yt-dlp*) keys="$(tr "\0" "\n" <"$p/environ" | cut -d= -f1 | sort | paste -sd, -)"; test "$keys" = HOME,LANG,LC_ALL,PATH,SSL_CERT_FILE,TMPDIR; echo "${p##*/}" >>/tmp/qa-pids; count=$((count+1));; esac; done; printf "%s" "$count"')"
    docker exec "$sidecar" cat /tmp/qa-pids >"$work/children"
    test "$count" -eq 4 && { observed=true; environment_observed=true; }
    $observed && docker exec "$sidecar" test -f /tmp/qa-deno-observed && break
    sleep 0.1
  done
  docker exec "$sidecar" test -f /tmp/qa-four-observed && four_latched=true
  docker exec "$sidecar" test -f /tmp/qa-deno-observed && deno_latched=true
  $observed
  $four_latched
  $deno_latched
  stage=host-process-snapshot
  docker top "$sidecar" -eo pid,stat,comm | awk 'NR > 1 { if ($2 ~ /^Z/) exit 1; print $1 }' >"$work/host-pids"
  while read -r pid; do test -r "/proc/$pid/stat"; printf '%s:%s\n' "$pid" "$(awk '{print $22}' "/proc/$pid/stat")"; done <"$work/host-pids" >"$work/host-processes"
  stage=sigterm-deadline
  started="$(date +%s%3N)"; docker kill --signal=TERM "$sidecar" >"$raw" 2>&1
  while test "$(docker inspect -f '{{.State.Running}}' "$sidecar")" = true; do test $(( $(date +%s%3N) - started )) -lt 10000; sleep 0.1; done
  test $(( $(date +%s%3N) - started )) -lt 10000
  stage=host-process-reap
  while IFS=: read -r pid start; do test ! -r "/proc/$pid/stat" || test "$(awk '{print $22}' "/proc/$pid/stat")" != "$start"; done <"$work/host-processes"
fi
test "$VERIFY_MODE" = smoke && challenge=true || challenge=not-run
test "$VERIFY_MODE" = drain && saturated=true || saturated=not-run
printf 'checkpoint=%s\ntree=%s\ncontext_clean=true\nhistory_clean=true\nprivate_health=true\nruntime_pins=true\nnode_fallback_tools=true\nproxy_sentinel_connections=0\nchallenge_smoke=%s\nsaturated_drain=%s\n' "$CHECKPOINT_SHA" "$CHECKPOINT_TREE" "$challenge" "$saturated"
test "$VERIFY_MODE" = drain && exit 86 || true
