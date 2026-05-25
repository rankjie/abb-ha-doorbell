# ABB HA Doorbell for Scrypted

Scrypted bridge for the [ABB Welcome Home Assistant integration][ha-integration].
Add the Scrypted doorbells from this plugin to Apple Home to turn ABB Welcome
stations into full HomeKit doorbells with live video, doorbell notifications,
and two-way audio.

The [Home Assistant integration][ha-integration] remains responsible for ABB
pairing, SIP, RTP, RTSP, talkback, and door opening. This plugin is the
HomeKit-facing bridge.

## What it exposes

The plugin discovers ABB Welcome entities from Home Assistant and creates one
Scrypted `Doorbell` device for each discovered door station. The first/primary
station keeps the legacy `front-door` native id so existing HomeKit pairings are
not replaced. Additional stations are published as separate child devices.

Each doorbell provides:

- `VideoCamera`: live RTSP from the matching HA camera `lan_rtsp_url`.
- `Camera`: station-matched snapshots from HA without opening the live intercom
  stream.
- `BinarySensor`: HA ring state for HomeKit doorbell notifications.
- `Intercom`: HomeKit microphone audio, converted to 8 kHz mono PCM16LE and sent
  to the HA talkback services.

The plugin also exposes a `Streaming Enabled` switch. Turn it on from Scrypted or
HomeKit when you want to manually arm streaming for testing.

## Setup

1. Install and configure the [ABB Welcome Home Assistant integration][ha-integration].
2. In Scrypted, install this plugin.
3. Open the plugin settings and fill in:
   - **Home Assistant URL**
   - **Home Assistant Token** (a long-lived HA access token)
4. Leave **Primary Door Station** blank unless you want a specific station to
   keep the `front-door` HomeKit identity.
5. Use **Refresh Discovery** after adding, removing, or renaming ABB Welcome
   stations in Home Assistant.
6. Add the Scrypted doorbells to the Scrypted HomeKit plugin.

The plugin automatically discovers the ABB camera entities, snapshot image
entity, streaming switch, ring sensor, station ids, and HA `lan_rtsp_url`.
Only the first/primary door station exposes the global plugin settings;
secondary stations use the same settings but do not show the settings panel.

## HomeKit settings

ABB Welcome streams use PCMA/G.711 audio and H.264 RTP that HomeKit does not
reliably accept as passthrough. When a doorbell is added to the Scrypted HomeKit
plugin, this plugin automatically enables HomeKit's `Transcode Video` and
`Transcode Audio` debug options for that doorbell. Keep both enabled.

Do not use the HA-native HomeKit bridge for two-way audio. HA can expose a
one-way camera, but the microphone path for this custom camera is bridged here.

## Apple TV / Home Hub preview safety

Apple TV and some Home Hubs can open a local HomeKit preview immediately after a
doorbell ring. ABB Welcome intercom media is exclusive; if a hub auto-opens the
stream, it can occupy the call before a person answers.

If this Apple Home has an Apple TV or Home Hub:

- Enable **Apple TV / Home Hub Present**.
- Strongly consider assigning the hub a fixed LAN IP and entering it in
  **Apple TV / Home Hub IPs**.
- Keep **Block Apple TV Preview Pickup** enabled.
- Leave **Apple TV / Home Hub IPs** blank if you do not want the plugin to block
  any hub preview.
- Do not enable Scrypted Rebroadcast or Prebuffer on these ABB doorbells.

During **Ring Preview Block Window**, local HomeKit stream requests from the
listed IPs are rejected. Manual Home app viewing is still allowed, and remote
Home app viewing through the same hub is still allowed because only local
preview requests are blocked.

## Streaming behavior

The plugin only starts an ABB intercom stream for HomeKit live view requests. It
rejects Scrypted admin previews, generic probes, and unscoped prebuffer requests
so they do not call the gateway.

After the plugin starts or reloads, stream auto-arming is suppressed briefly.
HomeKit may probe camera streams during plugin reload; those probes should not
open the ABB intercom call by themselves.

The plugin re-reads HA discovery before every new stream. If Home Assistant
reloads and moves its LAN RTSP proxy to a different free port, Scrypted follows
the updated `lan_rtsp_url` without changing plugin settings. It also subscribes
to the ABB-only `abb_welcome_discovery_changed` event over the HA WebSocket, so
it does not subscribe to every Home Assistant entity.

## Rebroadcast

For Apple TV/Home Hub homes, do not enable Scrypted Rebroadcast for these ABB
doorbells.

For homes without a Home Hub, Rebroadcast can be used only if prebuffering is
disabled. In most setups it is simpler to leave Rebroadcast off. ABB Welcome is
an exclusive, on-demand intercom call, and prebuffering can keep the building
intercom occupied or delay HomeKit live view while it waits for a sync frame.

## Fallbacks

The **Fallback RTSP URL** setting is only for unusual setups where the HA camera
does not expose `lan_rtsp_url`. Normal users should leave it blank.

Multiple HomeKit viewers can attach to the same HA station stream. Microphone
audio is tagged with a per-client session id so stale clients cannot stop a
newer talkback session.

[ha-integration]: https://github.com/rankjie/ha-abb-welcome
