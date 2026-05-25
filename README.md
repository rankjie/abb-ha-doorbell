# ABB HA Doorbell

Scrypted bridge for the ABB Welcome Home Assistant custom integration.

The plugin exposes one Scrypted `Doorbell` device with:

- `VideoCamera`: returns the HA-provided RTSP stream.
- `Camera`: returns the latest HA doorbell screenshot for HomeKit previews without opening the live intercom stream.
- `BinarySensor`: mirrors the HA ring sensor for HomeKit doorbell notifications.
- `Intercom`: receives HomeKit/Scrypted microphone audio, converts it to 8 kHz mono PCM16LE, and sends it to the HA talkback services.

The Home Assistant integration remains responsible for SIP, RTP, RTSP, and door-opening logic.

## Configuration

In normal use, configure only:

- Home Assistant URL
- Home Assistant long-lived access token

The plugin discovers ABB Welcome camera entities, the streaming switch, ring
sensor, snapshot image entity, station id, and HA's `lan_rtsp_url`
automatically. Leave **Door Station** blank to use the first unlock-capable
station, or pick one from the discovered list. Use **Refresh Discovery** after
adding, removing, or renaming ABB Welcome stations in Home Assistant.

The plugin re-reads Home Assistant discovery before starting a new stream, so if
the HA integration reloads and moves its LAN RTSP proxy to a different free
port, Scrypted follows the updated `lan_rtsp_url` without changing plugin
settings. It also keeps a Home Assistant WebSocket subscription to the ABB-only
`abb_welcome_discovery_changed` event, which avoids subscribing to every entity's
state changes. The fallback RTSP setting is only for unusual setups where the HA
camera attribute is unavailable.

HA-side port selection starts at:

```text
rtsp://<home-assistant-lan-ip>:18556/abb_100000001
```

The HA-native HomeKit bridge can still be used for a one-way camera. Use this
Scrypted bridge when HomeKit needs the microphone/intercom path.
