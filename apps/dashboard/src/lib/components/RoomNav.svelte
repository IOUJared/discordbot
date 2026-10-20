<script lang="ts">
  import ClockCounterClockwise from "phosphor-svelte/lib/ClockCounterClockwise"
  import Queue from "phosphor-svelte/lib/Queue"
  import SignOut from "phosphor-svelte/lib/SignOut"
  import SpeakerHigh from "phosphor-svelte/lib/SpeakerHigh"
  import UsersThree from "phosphor-svelte/lib/UsersThree"
  import Badge from "./Badge.svelte"
  import type { VoiceChannel } from "$lib/services/api.js"
  import type { SocketStatus } from "$lib/services/socket.js"
  let { channels, activeChannelId, voiceConnected, socketStatus, view, busy, onchange, onchannel, logout }: { channels: readonly VoiceChannel[]; activeChannelId: string | null; voiceConnected: boolean; socketStatus: SocketStatus; view: "player"|"history"; busy: boolean; onchange: (view: "player"|"history") => void; onchannel: (channel: VoiceChannel) => void; logout: () => void } = $props()
  const badgeStatus = (): "connected"|"reconnecting"|"disconnected" => socketStatus === "connected" ? "connected" : socketStatus === "reconnecting" || socketStatus === "connecting" ? "reconnecting" : "disconnected"
</script>
<nav aria-label="Voice channels and controls"><div class="brand" aria-hidden="true"><div class="brand-mark"></div><span class="brand-name">Listening room</span></div><div class="group channels"><p>Voice channels</p>{#if channels.length === 0}<span class="channel-empty">No joinable channels</span>{:else}{#each channels as channel (channel.id)}<button class:selected={activeChannelId === channel.id} aria-current={activeChannelId === channel.id ? "true" : undefined} aria-label={`${channel.name}, ${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`} disabled={busy} onclick={() => onchannel(channel)}><SpeakerHigh size={20} weight={activeChannelId === channel.id ? "fill" : "regular"} aria-hidden="true" /><span class="channel-name">{channel.name}</span><span class="member-count" aria-hidden="true"><UsersThree size={16} />{channel.memberCount}</span></button>{/each}{/if}</div><div class="group"><p>Controls</p><button class:active={view === "player"} onclick={() => onchange("player")}><Queue size={20} aria-hidden="true" /><span>Player</span></button><button class:active={view === "history"} onclick={() => onchange("history")}><ClockCounterClockwise size={20} aria-hidden="true" /><span>History</span></button></div><div class="status"><p>Status</p><Badge status={badgeStatus()} label={socketStatus === "connected" ? (voiceConnected ? "Voice connected" : "Server connected") : socketStatus} /><button onclick={logout}><SignOut size={20} aria-hidden="true" /><span>Log out</span></button></div></nav>
<style>
  nav{min-block-size:0;display:grid;grid-template-rows:auto auto auto minmax(0,1fr);gap:var(--space-5);padding:var(--space-5);background:linear-gradient(180deg,rgba(31,29,46,.55),rgba(22,20,31,.82));border-inline-end:var(--line-width) solid var(--hairline);overflow:auto}
  .brand{display:flex;align-items:center;gap:var(--space-2);padding-inline:var(--space-3);padding-block-end:var(--space-1);color:var(--text-primary);font-weight:600;letter-spacing:-.01em}
  .brand-mark{inline-size:14px;block-size:14px;flex:none;border-radius:50%;background:var(--accent-gradient);box-shadow:0 0 18px rgba(196,167,231,.55)}
  .group{display:grid;gap:var(--space-1)}
  .group p,.status>p{padding-inline:var(--space-3);margin-block-end:var(--space-1);color:var(--text-muted);font-size:var(--type-label);font-weight:600;text-transform:uppercase;letter-spacing:var(--tracking-label)}
  .group button,.status button{min-block-size:var(--target);display:flex;align-items:center;gap:var(--space-3);padding-inline:var(--space-3);border:0;border-radius:var(--radius-control);background:transparent;color:var(--text-secondary);text-align:start;transition:background var(--motion-micro),color var(--motion-micro)}
  .group button:hover:not(:disabled),.status button:hover{background:var(--surface-hover);color:var(--text-primary)}
  .group button:disabled{opacity:.55}
  .group button.active{color:var(--text-primary)}
  .group button.selected{background:linear-gradient(90deg,rgba(196,167,231,.16),rgba(196,167,231,.05));color:var(--text-primary);box-shadow:inset 2px 0 0 var(--indigo-500)}
  .channel-name{min-inline-size:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
  .member-count{margin-inline-start:auto;display:flex;align-items:center;gap:var(--space-1);color:var(--text-muted);font-family:var(--font-mono);font-size:var(--type-label)}
  .channel-empty{padding:var(--space-3);color:var(--text-muted);font-size:var(--type-compact)}
  .status{align-self:end;display:grid;gap:var(--space-2);padding-block-start:var(--space-5);border-block-start:var(--line-width) solid var(--hairline)}
  @media(min-width:1024px){nav{grid-template-rows:auto auto auto auto;align-content:start;gap:var(--space-6)}.status{align-self:auto;margin-block-start:var(--space-6)}}
  @media(min-width:768px) and (max-width:1023px){nav{padding-inline:var(--space-2)}nav span,.group p,.status>p{position:absolute;inline-size:1px;block-size:1px;overflow:hidden}.brand{justify-content:center;padding-inline:0}.group button,.status button{justify-content:center;padding:0}.status :global(.badge){justify-content:center;font-size:0}}
</style>
