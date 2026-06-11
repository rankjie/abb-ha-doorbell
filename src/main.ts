import sdk, {
    BinarySensor,
    Camera,
    DeviceProvider,
    FFmpegInput,
    Intercom,
    MediaObject,
    OnOff,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    Setting,
    SettingValue,
    Settings,
    VideoCamera,
} from '@scrypted/sdk';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';

const WebSocket = require('ws');

const NATIVE_ID = 'front-door';
const STREAMING_SWITCH_NATIVE_ID = 'streaming-enabled';
const AUTO_DISCOVERY_TTL_MS = 30_000;
const DEVICE_REFRESH_VERSION = '2026-05-25-multi-station-media-ids';
const HA_DISCOVERY_EVENT = 'abb_welcome_discovery_changed';
const HA_RING_EVENT = 'abb_welcome_ring';
const RING_EVENT_DURATION_MS = 30000;
const HOMEKIT_MIXIN_INTERFACE = 'mixin:@scrypted/homekit';
const HOMEKIT_DESTINATION_TYPE = '@scrypted/homekit';
const PREBUFFER_MIXIN_PLUGIN_ID = '@scrypted/prebuffer-mixin';
const HOMEKIT_DEBUG_MODE_KEY = 'homekit:debugMode';
const REQUIRED_HOMEKIT_DEBUG_MODE = ['Transcode Video', 'Transcode Audio'];
const HOMEKIT_TRANSCODING_ENSURE_DELAY_MS = 5000;
const STREAM_AUTO_ARM_SUPPRESS_AFTER_START_MS = 30000;
const DEFAULT_RING_PREVIEW_BLOCK_SECONDS = 45;
const RTSP_FFMPEG_INPUT_OPTIONS = [
    '-analyzeduration',
    '0',
    '-probesize',
    '32768',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-reorder_queue_size',
    '0',
    '-rtsp_transport',
    'tcp',
    '-f',
    'rtsp',
];
const FALLBACK_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
    'base64',
);

type SettingKey =
    | 'deviceName'
    | 'haBaseUrl'
    | 'haToken'
    | 'rtspUrl'
    | 'cameraEntityId'
    | 'imageEntityId'
    | 'streamingSwitchEntityId'
    | 'ringSensorEntityId'
    | 'stationId'
    | 'pollIntervalMs'
    | 'talkChunkMs'
    | 'appleHomeHubPresent'
    | 'blockAppleHomeHubPreview'
    | 'ringPreviewBlockSeconds'
    | 'blockedHomeKitClientIds';

interface HaState {
    entity_id: string;
    state: string;
    attributes?: Record<string, any>;
}

interface AutoConfig {
    cameraEntityId: string;
    imageEntityId: string;
    streamingSwitchEntityId: string;
    ringSensorEntityId: string;
    stationId: string;
    rtspUrl: string;
    cameras: DiscoveredCamera[];
    summary: string;
}

interface DiscoveredCamera {
    entityId: string;
    name: string;
    stationId: string;
    rtspUrl: string;
    imageEntityId: string;
}

interface IntercomSession {
    id: number;
    talkbackSessionId: string;
    talkbackStarted: boolean;
    process: ChildProcessWithoutNullStreams;
    targetData: Record<string, string>;
    buffer: Buffer;
    queue: Buffer[];
    sending: boolean;
    stopped: boolean;
    stderr: string;
}

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function settingString(value: SettingValue): string {
    if (value === undefined || value === null)
        return '';
    return String(value);
}

function stateValue(value: any): any {
    if (value && typeof value === 'object' && 'value' in value)
        return value.value;
    return value;
}

function isValidRtspUrl(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('rtsp://') && !value.includes('<');
}

function entityDomain(entityId: string): string {
    return entityId.split('.', 1)[0] || '';
}

function friendlyName(state?: HaState): string {
    return String(state?.attributes?.friendly_name || state?.entity_id || '');
}

function isAbbCamera(state: HaState): boolean {
    if (entityDomain(state.entity_id) !== 'camera')
        return false;
    const attrs = state.attributes || {};
    return state.entity_id.startsWith('camera.abb_welcome_')
        || String(attrs.go2rtc_stream || '').startsWith('abb_');
}

function isAbbEntity(state: HaState, domain: string): boolean {
    if (entityDomain(state.entity_id) !== domain)
        return false;
    return state.entity_id.includes('abb_welcome')
        || friendlyName(state).toLowerCase().includes('abb welcome');
}

function cameraSortScore(state: HaState): string {
    const attrs = state.attributes || {};
    const canUnlock = attrs.can_unlock === false ? 1 : 0;
    const subCamera = attrs.camera_index === undefined ? 0 : 1;
    const outdoor = state.entity_id.includes('outdoor') || friendlyName(state).toLowerCase().includes('outdoor') ? 0 : 1;
    return `${canUnlock}${subCamera}${outdoor}${state.entity_id}`;
}

function stationIdFromCamera(state?: HaState): string {
    const stream = String(state?.attributes?.go2rtc_stream || '');
    const match = /^abb_([^_]+)/.exec(stream);
    return match?.[1] || '';
}

function htmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function nativeIdSlug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function cameraNativeId(camera: DiscoveredCamera, primaryEntityId: string): string {
    if (camera.entityId === primaryEntityId)
        return NATIVE_ID;
    if (camera.stationId)
        return `station-${nativeIdSlug(camera.stationId)}`;
    return `entity-${nativeIdSlug(camera.entityId)}`;
}

function cleanCameraName(name: string): string {
    return name
        .replace(/^ABB Welcome\s*/i, '')
        .replace(/^GATEWAY\s*/i, '')
        .replace(/\s+Camera$/i, '')
        .trim() || name || 'ABB Door';
}

function compactRequestMediaStreamOptions(options?: RequestMediaStreamOptions): Record<string, any> {
    const raw = options as any;
    if (!raw || typeof raw !== 'object')
        return {};

    const summary: Record<string, any> = {};
    for (const key of [
        'refresh',
        'id',
        'name',
        'container',
        'tool',
        'source',
        'destination',
        'destinationId',
        'destinationType',
        'prebuffer',
        'prebufferBytes',
    ]) {
        const value = raw[key];
        if (value !== undefined && value !== null)
            summary[key] = value;
    }

    for (const key of ['video', 'audio']) {
        const value = raw[key];
        if (!value || typeof value !== 'object')
            continue;
        summary[key] = {};
        for (const mediaKey of ['codec', 'profile', 'width', 'height', 'fps', 'sampleRate', 'channel', 'bitRate'])
            if (value[mediaKey] !== undefined && value[mediaKey] !== null)
                summary[key][mediaKey] = value[mediaKey];
    }

    if (raw.route && typeof raw.route === 'object') {
        summary.route = {};
        for (const routeKey of ['id', 'name', 'destination', 'destinationId', 'source'])
            if (raw.route[routeKey] !== undefined && raw.route[routeKey] !== null)
                summary.route[routeKey] = raw.route[routeKey];
    }

    if (raw.metadata && typeof raw.metadata === 'object')
        summary.metadataKeys = Object.keys(raw.metadata).sort();

    summary.optionKeys = Object.keys(raw).sort();
    return summary;
}

function isHomeKitStreamRequest(options?: RequestMediaStreamOptions): boolean {
    const raw = options as any;
    if (!raw || typeof raw !== 'object')
        return false;
    return raw.destinationType === HOMEKIT_DESTINATION_TYPE;
}

function redactMediaUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    catch {
        return url.split('?')[0];
    }
}

function settingStringArray(value: unknown): string[] {
    value = stateValue(value);
    if (Array.isArray(value))
        return value.map(item => String(item));
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed))
                return parsed.map(item => String(item));
        }
        catch {
            return value ? [value] : [];
        }
    }
    return [];
}

function settingList(value: unknown): string[] {
    if (value === undefined || value === null)
        return [];
    return String(value)
        .split(/[\s,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function settingBoolean(value: unknown): boolean {
    value = stateValue(value);
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return value !== 0;
    if (typeof value === 'string')
        return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    return false;
}

function normalizeHomeKitClientId(value: unknown): string {
    return String(value || '').trim().replace(/^::ffff:/, '').toLowerCase();
}

function streamTimingPrefix(deviceName: string, startedAt: number, step: string): string {
    return `[${new Date().toISOString()}] stream timing ${deviceName}: ${step} +${Date.now() - startedAt}ms`;
}

class AbbDoorbellProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    private doorbells = new Map<string, AbbDoorbell>();
    private streamingSwitch = new AbbStreamingSwitch(this, STREAMING_SWITCH_NATIVE_ID);
    private deviceNames = new Map<string, string>();
    private startedAt = Date.now();
    private pollTimer?: NodeJS.Timeout;
    private lastPollWarning = 0;
    private autoConfig?: AutoConfig;
    private autoConfigExpires = 0;
    private autoConfigPromise?: Promise<AutoConfig>;
    private haEventSocket?: any;
    private haEventReconnectTimer?: NodeJS.Timeout;
    private haEventSocketGeneration = 0;
    private haEventSocketSubscribeId = 0;

    constructor() {
        super();
        this.deviceForNativeId(NATIVE_ID);
        this.syncDevice()
            .then(() => {
                this.restartPolling();
                this.restartHaEventSocket();
            })
            .catch(e => this.console.error('device sync failed', e));
    }

    private deviceForNativeId(nativeId: string): AbbDoorbell {
        let doorbell = this.doorbells.get(nativeId);
        if (!doorbell) {
            doorbell = new AbbDoorbell(this, nativeId);
            this.doorbells.set(nativeId, doorbell);
        }
        return doorbell;
    }

    getSetting(key: SettingKey): string {
        const value = this.storage.getItem(key);
        if (value !== undefined && value !== null)
            return value;

        const existingBlockedClients = settingList(this.storage.getItem('blockedHomeKitClientIds')).length > 0;
        const defaults: Record<SettingKey, string> = {
            deviceName: 'Front Door',
            haBaseUrl: '',
            haToken: '',
            rtspUrl: '',
            cameraEntityId: '',
            imageEntityId: '',
            streamingSwitchEntityId: '',
            ringSensorEntityId: '',
            stationId: '',
            pollIntervalMs: '750',
            talkChunkMs: '100',
            appleHomeHubPresent: existingBlockedClients ? 'true' : 'false',
            blockAppleHomeHubPreview: existingBlockedClients ? 'true' : 'false',
            ringPreviewBlockSeconds: String(DEFAULT_RING_PREVIEW_BLOCK_SECONDS),
            blockedHomeKitClientIds: '',
        };
        return defaults[key];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'refreshDiscovery') {
            this.clearAutoConfig();
            await this.getAutoConfig();
            await this.syncDevice();
            this.restartPolling();
            return;
        }
        this.storage.setItem(key, settingString(value));
        if (key === 'deviceName')
            await this.syncDevice();
        if ([
            'haBaseUrl',
            'haToken',
            'rtspUrl',
            'cameraEntityId',
            'imageEntityId',
            'streamingSwitchEntityId',
            'ringSensorEntityId',
            'stationId',
        ].includes(key)) {
            this.clearAutoConfig();
        }
        if (key === 'cameraEntityId')
            await this.syncDevice();
        if (key === 'haBaseUrl' || key === 'haToken')
            this.restartHaEventSocket();
        if (key === 'pollIntervalMs' || key === 'haBaseUrl' || key === 'haToken' || key === 'ringSensorEntityId')
            this.restartPolling();
    }

    async getSettings(): Promise<Setting[]> {
        const discovery = await this.discoveryStatusSetting();
        let config: AutoConfig | undefined;
        try {
            if (this.getSetting('haBaseUrl') && this.getSetting('haToken'))
                config = await this.getAutoConfig();
        }
        catch {
            config = undefined;
        }
        const cameraChoices = config?.cameras.map(camera => camera.entityId) || [];
        return [
            {
                key: 'deviceName',
                title: 'Device Name',
                group: 'Doorbell',
                type: 'string',
                value: this.getSetting('deviceName'),
            },
            {
                key: 'haBaseUrl',
                title: 'Home Assistant URL',
                group: 'Connection',
                type: 'string',
                value: this.getSetting('haBaseUrl'),
                placeholder: 'http://homeassistant.local:8123',
            },
            {
                key: 'haToken',
                title: 'Home Assistant Token',
                group: 'Connection',
                type: 'password',
                value: this.getSetting('haToken'),
            },
            discovery,
            {
                key: 'refreshDiscovery',
                title: 'Refresh Discovery',
                group: 'Connection',
                type: 'button',
                description: 'Re-read ABB Welcome entities from Home Assistant.',
            },
            {
                key: 'rtspUrl',
                title: 'Fallback RTSP URL',
                group: 'Advanced Overrides',
                type: 'string',
                value: this.getSetting('rtspUrl'),
                placeholder: 'Auto-discovered from the HA camera lan_rtsp_url attribute',
            },
            {
                key: 'cameraEntityId',
                title: 'Primary Door Station',
                group: 'Doorbell',
                type: 'string',
                value: this.getSetting('cameraEntityId'),
                choices: cameraChoices,
                combobox: true,
                placeholder: config?.cameraEntityId || 'Auto',
                description: 'Leave blank to keep the first unlock-capable ABB Welcome camera on the existing front-door device. Other discovered stations are exposed as additional doorbells.',
            },
            {
                key: 'imageEntityId',
                title: 'Snapshot Image Entity Override',
                group: 'Advanced Overrides',
                type: 'string',
                value: this.getSetting('imageEntityId'),
                placeholder: 'Auto',
            },
            {
                key: 'streamingSwitchEntityId',
                title: 'Streaming Switch Entity Override',
                group: 'Advanced Overrides',
                type: 'string',
                value: this.getSetting('streamingSwitchEntityId'),
                placeholder: 'Auto',
            },
            {
                key: 'ringSensorEntityId',
                title: 'Ring Sensor Entity Override',
                group: 'Advanced Overrides',
                type: 'string',
                value: this.getSetting('ringSensorEntityId'),
                placeholder: 'Auto',
            },
            {
                key: 'stationId',
                title: 'Station ID Override',
                group: 'Advanced Overrides',
                type: 'string',
                value: this.getSetting('stationId'),
                placeholder: 'Auto',
            },
            {
                key: 'pollIntervalMs',
                title: 'Ring Poll Interval',
                group: 'Advanced Overrides',
                type: 'integer',
                value: Number(this.getSetting('pollIntervalMs')),
                range: [250, 5000],
            },
            {
                key: 'talkChunkMs',
                title: 'Talkback Chunk Size',
                group: 'Advanced Overrides',
                type: 'integer',
                value: Number(this.getSetting('talkChunkMs')),
                range: [40, 250],
            },
            {
                key: 'appleHomeHubPresent',
                title: 'Apple TV / Home Hub Present',
                group: 'HomeKit Pickup Safety',
                type: 'boolean',
                value: this.appleHomeHubPresent(),
                description: 'Enable this if Apple Home uses an Apple TV or HomePod as a Home Hub.',
            },
            {
                key: 'appleHomeHubNotice',
                title: 'Apple TV Preview Warning',
                group: 'HomeKit Pickup Safety',
                type: 'html',
                readonly: true,
                value: this.appleHomeHubPresent()
                    ? 'Apple TV and some Home Hubs may open a local doorbell preview immediately after a ring. ABB Welcome calls are exclusive, so this can occupy the intercom before a person answers. If you use this safety mode, assign the hub a fixed LAN IP, enter it below, and keep Scrypted Rebroadcast/Prebuffer disabled for these doorbells.'
                    : 'Leave this off if this Apple Home has no Apple TV/Home Hub. If you add one later, enable this section and enter its fixed LAN IP if ring previews auto-open the intercom.',
            },
            {
                key: 'blockAppleHomeHubPreview',
                title: 'Block Apple TV Preview Pickup',
                group: 'HomeKit Pickup Safety',
                type: 'boolean',
                value: this.blockAppleHomeHubPreviewSetting(),
                description: 'Reject matching local HomeKit preview streams during a ring. Manual Home app viewing and remote viewing through the Home Hub remain allowed.',
            },
            {
                key: 'blockedHomeKitClientIds',
                title: 'Apple TV / Home Hub IPs',
                group: 'HomeKit Pickup Safety',
                type: 'string',
                value: this.getSetting('blockedHomeKitClientIds'),
                placeholder: '192.168.1.50, 192.168.1.51',
                description: 'Comma-separated fixed LAN IPs reported as HomeKit destinationId. Leave blank to disable preview blocking.',
            },
            {
                key: 'ringPreviewBlockSeconds',
                title: 'Ring Preview Block Window',
                group: 'HomeKit Pickup Safety',
                type: 'integer',
                value: Number(this.getSetting('ringPreviewBlockSeconds')) || DEFAULT_RING_PREVIEW_BLOCK_SECONDS,
                range: [0, 180],
                description: 'Seconds after a ring event during which the listed Apple TV/Home Hub IPs may not auto-open the intercom stream.',
            },
        ];
    }

    private clearAutoConfig(): void {
        this.autoConfig = undefined;
        this.autoConfigExpires = 0;
        this.autoConfigPromise = undefined;
    }

    private async discoveryStatusSetting(): Promise<Setting> {
        if (!this.getSetting('haBaseUrl') || !this.getSetting('haToken')) {
            return {
                key: 'discoveryStatus',
                title: 'Discovery Status',
                group: 'Connection',
                type: 'html',
                readonly: true,
                value: 'Enter the Home Assistant URL and a long-lived access token. ABB Welcome entities will be detected automatically.',
            };
        }
        try {
            const config = await this.getAutoConfig();
            return {
                key: 'discoveryStatus',
                title: 'Discovery Status',
                group: 'Connection',
                type: 'html',
                readonly: true,
                value: config.summary,
            };
        }
        catch (e) {
            return {
                key: 'discoveryStatus',
                title: 'Discovery Status',
                group: 'Connection',
                type: 'html',
                readonly: true,
                value: `Automatic discovery failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }

    async getAutoConfig(): Promise<AutoConfig> {
        const now = Date.now();
        if (this.autoConfig && now < this.autoConfigExpires)
            return this.autoConfig;
        if (this.autoConfigPromise)
            return this.autoConfigPromise;
        this.autoConfigPromise = this.discoverAutoConfig()
            .then(config => {
                this.autoConfig = config;
                this.autoConfigExpires = Date.now() + AUTO_DISCOVERY_TTL_MS;
                return config;
            })
            .finally(() => {
                this.autoConfigPromise = undefined;
            });
        return this.autoConfigPromise;
    }

    async refreshAutoConfig(): Promise<AutoConfig> {
        this.clearAutoConfig();
        return this.getAutoConfig();
    }

    private restartHaEventSocket(): void {
        this.stopHaEventSocket();
        this.startHaEventSocket();
    }

    private stopHaEventSocket(): void {
        this.haEventSocketGeneration++;
        if (this.haEventReconnectTimer) {
            clearTimeout(this.haEventReconnectTimer);
            this.haEventReconnectTimer = undefined;
        }
        if (this.haEventSocket) {
            const socket = this.haEventSocket;
            this.haEventSocket = undefined;
            try {
                socket.close();
            }
            catch {
                // ignore close failures from an already-closing socket
            }
        }
    }

    private startHaEventSocket(): void {
        if (!this.getSetting('haBaseUrl') || !this.getSetting('haToken'))
            return;

        const generation = ++this.haEventSocketGeneration;
        let url: string;
        try {
            url = this.haWebSocketUrl();
        }
        catch (e) {
            this.console.warn('HA event socket URL is invalid', e);
            return;
        }

        const socket = new WebSocket(url);
        this.haEventSocket = socket;

        socket.on('message', (message: Buffer | string) => {
            this.handleHaEventSocketMessage(socket, generation, message).catch(e => this.console.warn('HA event socket message failed', e));
        });
        socket.on('close', () => {
            if (this.haEventSocket === socket)
                this.haEventSocket = undefined;
            this.scheduleHaEventSocketReconnect(generation);
        });
        socket.on('error', (e: Error) => {
            if (this.haEventSocket === socket)
                this.console.warn('HA event socket error', e.message || e);
        });
    }

    private haWebSocketUrl(): string {
        const base = new URL(normalizeBaseUrl(this.getSetting('haBaseUrl')));
        base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/websocket`;
        base.search = '';
        base.hash = '';
        return base.toString();
    }

    private scheduleHaEventSocketReconnect(generation: number): void {
        if (generation !== this.haEventSocketGeneration)
            return;
        if (!this.getSetting('haBaseUrl') || !this.getSetting('haToken'))
            return;
        if (this.haEventReconnectTimer)
            return;
        this.haEventReconnectTimer = setTimeout(() => {
            this.haEventReconnectTimer = undefined;
            if (generation === this.haEventSocketGeneration)
                this.startHaEventSocket();
        }, 15000);
    }

    private async handleHaEventSocketMessage(socket: any, generation: number, message: Buffer | string): Promise<void> {
        if (generation !== this.haEventSocketGeneration)
            return;

        let payload: any;
        try {
            payload = JSON.parse(message.toString());
        }
        catch {
            return;
        }

        if (payload.type === 'auth_required') {
            socket.send(JSON.stringify({
                type: 'auth',
                access_token: this.getSetting('haToken'),
            }));
            return;
        }

        if (payload.type === 'auth_invalid') {
            this.console.warn('HA event socket authentication failed');
            try {
                socket.close();
            }
            catch {
                // ignore close failures
            }
            return;
        }

        if (payload.type === 'auth_ok') {
            for (const eventType of [HA_DISCOVERY_EVENT, HA_RING_EVENT]) {
                const id = ++this.haEventSocketSubscribeId;
                socket.send(JSON.stringify({
                    id,
                    type: 'subscribe_events',
                    event_type: eventType,
                }));
            }
            await this.handleHaDiscoveryChanged({ reason: 'websocket_connected' });
            return;
        }

        if (payload.type === 'result' && payload.success === false) {
            this.console.warn('HA event subscription failed', payload.error || payload);
            return;
        }

        if (payload.type === 'event' && payload.event?.event_type === HA_DISCOVERY_EVENT) {
            await this.handleHaDiscoveryChanged(payload.event.data || {});
        }
        if (payload.type === 'event' && payload.event?.event_type === HA_RING_EVENT) {
            await this.handleHaRing(payload.event.data || {});
        }
    }

    private async handleHaDiscoveryChanged(data: Record<string, any>): Promise<void> {
        this.console.log(`HA ABB discovery changed: ${data.reason || 'unknown'}`);
        this.clearAutoConfig();
        await this.getAutoConfig()
            .then(() => this.syncDevice())
            .then(() => this.restartPolling())
            .catch(e => this.console.warn('HA discovery refresh after event failed', e));
    }

    private async handleHaRing(data: Record<string, any>): Promise<void> {
        const stationId = String(data.station_id || data.caller_user || '').trim();
        const nativeId = await this.nativeIdForStation(stationId);
        this.deviceForNativeId(nativeId).triggerRing(RING_EVENT_DURATION_MS);
    }

    async getResolvedConfig(): Promise<AutoConfig> {
        const auto = await this.getAutoConfig();
        const manualStationId = this.getSetting('stationId').trim();
        const manualRtspUrl = this.getSetting('rtspUrl').trim();
        return {
            ...auto,
            stationId: manualStationId || auto.stationId,
            rtspUrl: manualRtspUrl || auto.rtspUrl,
        };
    }

    async getResolvedConfigForNativeId(nativeId: string): Promise<AutoConfig> {
        if (nativeId === NATIVE_ID)
            return this.getResolvedConfig();

        const auto = await this.getAutoConfig();
        const camera = auto.cameras.find(item => cameraNativeId(item, auto.cameraEntityId) === nativeId);
        if (!camera)
            throw new Error(`No ABB Welcome camera is mapped to Scrypted device ${nativeId}`);

        const manualRtspUrl = this.getSetting('rtspUrl').trim();
        const manualImageEntityId = this.getSetting('imageEntityId').trim();
        return {
            ...auto,
            cameraEntityId: camera.entityId,
            imageEntityId: manualImageEntityId || camera.imageEntityId,
            stationId: camera.stationId,
            rtspUrl: camera.rtspUrl || manualRtspUrl || auto.rtspUrl,
        };
    }

    private async nativeIdForStation(stationId: string): Promise<string> {
        if (!stationId)
            return NATIVE_ID;
        const config = await this.getAutoConfig();
        const camera = config.cameras.find(item => item.stationId === stationId);
        return camera ? cameraNativeId(camera, config.cameraEntityId) : NATIVE_ID;
    }

    private async discoverAutoConfig(): Promise<AutoConfig> {
        const states = await this.callHa('/api/states') as HaState[];
        if (!Array.isArray(states))
            throw new Error('Home Assistant did not return a state list');

        const cameras = states.filter(isAbbCamera).sort((a, b) => cameraSortScore(a).localeCompare(cameraSortScore(b)));
        const discoveredCameras: DiscoveredCamera[] = cameras.map(state => ({
            entityId: state.entity_id,
            name: friendlyName(state),
            stationId: stationIdFromCamera(state),
            rtspUrl: isValidRtspUrl(state.attributes?.lan_rtsp_url) ? state.attributes.lan_rtsp_url : '',
            imageEntityId: this.findImageEntityForCamera(states, state)?.entity_id || '',
        }));
        const manualCamera = this.getSetting('cameraEntityId').trim();
        const camera = cameras.find(state => state.entity_id === manualCamera)
            || cameras[0];
        if (!camera)
            throw new Error('No ABB Welcome camera entity was found in Home Assistant');

        const image = this.findConfiguredOrAutoState(
            states,
            'imageEntityId',
            state => isAbbEntity(state, 'image') && state.entity_id.includes('latest_screenshot'),
        ) || this.findConfiguredOrAutoState(
            states,
            'imageEntityId',
            state => isAbbEntity(state, 'image'),
        );
        const streamingSwitch = this.findConfiguredOrAutoState(
            states,
            'streamingSwitchEntityId',
            state => isAbbEntity(state, 'switch') && state.entity_id.includes('streaming_enabled'),
        );
        const ringSensor = this.findConfiguredOrAutoState(
            states,
            'ringSensorEntityId',
            state => isAbbEntity(state, 'binary_sensor') && (
                state.entity_id.includes('ring')
                || state.entity_id.includes('intercom')
                || friendlyName(state).toLowerCase().includes('ring')
            ),
        );

        const attrs = camera.attributes || {};
        const rtspUrl = isValidRtspUrl(attrs.lan_rtsp_url) ? attrs.lan_rtsp_url : '';
        const stationId = stationIdFromCamera(camera);
        const cameraList = discoveredCameras
            .map(item => `${htmlEscape(item.name)} (${htmlEscape(item.entityId)})`)
            .join('<br>');
        const summary = [
            `Selected camera: ${htmlEscape(camera.entity_id)}`,
            `Discovered cameras: ${discoveredCameras.length}`,
            cameraList || 'No camera list available',
            streamingSwitch ? `Streaming switch: ${htmlEscape(streamingSwitch.entity_id)}` : 'Streaming switch: not found',
            ringSensor ? `Ring sensor: ${htmlEscape(ringSensor.entity_id)}` : 'Ring sensor: not found',
            image ? `Snapshot image: ${htmlEscape(image.entity_id)}` : 'Snapshot image: camera snapshot fallback',
            rtspUrl ? `RTSP: ${htmlEscape(rtspUrl)}` : 'RTSP: waiting for HA lan_rtsp_url',
        ].join('<br>');

        return {
            cameraEntityId: camera.entity_id,
            imageEntityId: image?.entity_id || '',
            streamingSwitchEntityId: streamingSwitch?.entity_id || '',
            ringSensorEntityId: ringSensor?.entity_id || '',
            stationId,
            rtspUrl,
            cameras: discoveredCameras,
            summary,
        };
    }

    private findConfiguredOrAutoState(
        states: HaState[],
        key: SettingKey,
        predicate: (state: HaState) => boolean,
    ): HaState | undefined {
        const configured = this.getSetting(key).trim();
        if (configured) {
            const found = states.find(state => state.entity_id === configured);
            if (found)
                return found;
        }
        return states.find(predicate);
    }

    private findImageEntityForCamera(states: HaState[], camera: HaState): HaState | undefined {
        const stationId = stationIdFromCamera(camera);
        const cameraName = cleanCameraName(friendlyName(camera)).toLowerCase();
        const cameraKey = camera.entity_id.replace(/^camera\./, '').toLowerCase();

        return states.find(state => {
            if (!isAbbEntity(state, 'image'))
                return false;
            const entityId = state.entity_id.toLowerCase();
            const name = cleanCameraName(friendlyName(state)).toLowerCase();
            return (stationId && entityId.includes(stationId.toLowerCase()))
                || (cameraKey && entityId.includes(cameraKey))
                || (cameraName && name.includes(cameraName));
        });
    }

    async getDevice(nativeId: string): Promise<AbbDoorbell | AbbStreamingSwitch> {
        if (nativeId === STREAMING_SWITCH_NATIVE_ID)
            return this.streamingSwitch;
        return this.deviceForNativeId(nativeId);
    }

    async releaseDevice(_id: string, _nativeId: string): Promise<void> {
        if (_nativeId === STREAMING_SWITCH_NATIVE_ID)
            return;
        await this.deviceForNativeId(_nativeId).stopIntercom();
    }

    private doorbellInterfaces(nativeId: string): ScryptedInterface[] {
        const interfaces = [
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Camera,
            ScryptedInterface.Intercom,
            ScryptedInterface.BinarySensor,
        ];
        if (nativeId === NATIVE_ID)
            interfaces.push(ScryptedInterface.Settings);
        return interfaces;
    }

    private updateVisibleDeviceName(nativeId: string, name: string): void {
        try {
            const state = sdk.deviceManager.getDeviceState(nativeId);
            const current = String(state.name || '').trim();
            const globalName = this.getSetting('deviceName').trim() || 'Front Door';
            if (
                !current
                || /^GATEWAY\s+/i.test(current)
                || (nativeId !== NATIVE_ID && (current === globalName || current === 'Front Door'))
            ) {
                state.name = name;
            }
        }
        catch (e) {
            this.console.warn(`failed to update device name for ${nativeId}`, e);
        }
    }

    async syncDevice(): Promise<void> {
        const configuredName = this.getSetting('deviceName');
        const needsRefresh = this.storage.getItem('deviceRefreshVersion') !== DEVICE_REFRESH_VERSION;
        let config: AutoConfig | undefined;
        try {
            if (this.getSetting('haBaseUrl') && this.getSetting('haToken'))
                config = await this.getAutoConfig();
        }
        catch (e) {
            this.console.warn('device discovery sync failed', e);
        }

        this.deviceNames.clear();
        const cameras = config?.cameras.length ? config.cameras : [];
        const devices = cameras.map(camera => {
            const nativeId = cameraNativeId(camera, config!.cameraEntityId);
            const defaultName = cleanCameraName(camera.name);
            const name = nativeId === NATIVE_ID
                ? (configuredName || defaultName || 'Front Door')
                : defaultName;
            this.deviceNames.set(nativeId, name);
            this.deviceForNativeId(nativeId);
            return {
                nativeId,
                name,
                type: ScryptedDeviceType.Doorbell,
                interfaces: this.doorbellInterfaces(nativeId),
                refresh: needsRefresh,
                info: {
                    manufacturer: 'ABB',
                    model: 'Welcome via Home Assistant',
                    ip: normalizeBaseUrl(this.getSetting('haBaseUrl')).replace(/^https?:\/\//, ''),
                },
            };
        });

        if (!devices.length) {
            this.deviceNames.set(NATIVE_ID, configuredName || 'Front Door');
            this.deviceForNativeId(NATIVE_ID);
            devices.push({
                nativeId: NATIVE_ID,
                name: configuredName || 'Front Door',
                type: ScryptedDeviceType.Doorbell,
                interfaces: this.doorbellInterfaces(NATIVE_ID),
                refresh: needsRefresh,
                info: {
                    manufacturer: 'ABB',
                    model: 'Welcome via Home Assistant',
                    ip: normalizeBaseUrl(this.getSetting('haBaseUrl')).replace(/^https?:\/\//, ''),
                },
            });
        }

        if (config?.streamingSwitchEntityId) {
            devices.push({
                nativeId: STREAMING_SWITCH_NATIVE_ID,
                name: 'Streaming Enabled',
                type: ScryptedDeviceType.Switch,
                interfaces: [
                    ScryptedInterface.OnOff,
                ],
                refresh: needsRefresh,
                info: {
                    manufacturer: 'ABB',
                    model: 'Welcome via Home Assistant',
                    ip: normalizeBaseUrl(this.getSetting('haBaseUrl')).replace(/^https?:\/\//, ''),
                },
            });
            this.streamingSwitch.refreshState()
                .catch(e => this.console.warn('streaming switch state refresh failed', e));
        }

        await sdk.deviceManager.onDevicesChanged({
            devices,
        });
        if (needsRefresh)
            this.storage.setItem('deviceRefreshVersion', DEVICE_REFRESH_VERSION);
        for (const device of devices)
            this.updateVisibleDeviceName(device.nativeId, device.name);
        for (const device of devices) {
            if (device.type !== ScryptedDeviceType.Doorbell)
                continue;
            this.ensureDoorbellScryptedDefaults(device.nativeId)
                .catch(e => this.console.warn(`Scrypted default setup failed for ${device.name}`, e));
            setTimeout(() => {
                this.ensureDoorbellScryptedDefaults(device.nativeId)
                    .catch(e => this.console.warn(`delayed Scrypted default setup failed for ${device.name}`, e));
            }, HOMEKIT_TRANSCODING_ENSURE_DELAY_MS);
        }
    }

    private async ensureDoorbellScryptedDefaults(nativeId: string): Promise<void> {
        await this.ensurePrebufferDisabled(nativeId);
        await this.ensureHomeKitTranscoding(nativeId);
    }

    private async ensurePrebufferDisabled(nativeId: string): Promise<void> {
        const state = sdk.deviceManager.getDeviceState(nativeId);
        const mixins = settingStringArray((state as any).mixins);
        if (!mixins.length)
            return;

        const nextMixins: string[] = [];
        let removed = false;
        for (const mixinId of mixins) {
            const mixinDevice = sdk.systemManager.getDeviceById(mixinId) as any;
            if (stateValue(mixinDevice?.pluginId) === PREBUFFER_MIXIN_PLUGIN_ID) {
                removed = true;
                continue;
            }
            nextMixins.push(mixinId);
        }
        if (!removed)
            return;

        const deviceId = stateValue((state as any).id);
        const device = sdk.systemManager.getDeviceById(deviceId) as any;
        if (!device?.setMixins)
            throw new Error(`Scrypted device ${nativeId} does not support mixin updates`);
        await device.setMixins(nextMixins);
        this.console.warn(`disabled Scrypted Rebroadcast/Prebuffer for ${this.deviceName(nativeId)}`);
    }

    private async ensureHomeKitTranscoding(nativeId: string): Promise<void> {
        const state = sdk.deviceManager.getDeviceState(nativeId);
        const interfaces = settingStringArray((state as any).interfaces);
        if (!state.id || !interfaces.includes(HOMEKIT_MIXIN_INTERFACE))
            return;

        const device = sdk.systemManager.getDeviceById(stateValue(state.id)) as any;
        if (!device?.getSettings || !device?.putSetting)
            return;

        const settings = await device.getSettings();
        const debugMode = settings.find((setting: Setting) => setting.key === HOMEKIT_DEBUG_MODE_KEY);
        if (!debugMode)
            return;

        const current = settingStringArray(debugMode.value);
        if (REQUIRED_HOMEKIT_DEBUG_MODE.every(item => current.includes(item)))
            return;

        const next = Array.from(new Set([...REQUIRED_HOMEKIT_DEBUG_MODE, ...current]));
        await device.putSetting(HOMEKIT_DEBUG_MODE_KEY, next);
        this.console.log(`enabled HomeKit video/audio transcoding for ${this.deviceName(nativeId)}`);
    }

    deviceName(nativeId: string): string {
        return this.deviceNames.get(nativeId)
            || (nativeId === NATIVE_ID ? this.getSetting('deviceName') : '')
            || 'ABB Door';
    }

    async targetData(nativeId = NATIVE_ID): Promise<Record<string, string>> {
        const config = await this.getResolvedConfigForNativeId(nativeId);
        const data: Record<string, string> = {};
        const entityId = config.cameraEntityId;
        const stationId = config.stationId;
        if (entityId)
            data.entity_id = entityId;
        if (stationId)
            data.station_id = stationId;
        return data;
    }

    async callHa(path: string, init?: RequestInit): Promise<any> {
        const response = await this.fetchHa(path, init);
        const text = await response.text();
        if (!response.ok) {
            const detail = text ? `: ${text.slice(0, 300)}` : '';
            throw new Error(`Home Assistant ${response.status} ${response.statusText}${detail}`);
        }
        if (!text)
            return undefined;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }

    async fetchHa(path: string, init?: RequestInit): Promise<Response> {
        const token = this.getSetting('haToken');
        if (!token)
            throw new Error('Home Assistant token is not configured');
        const baseUrl = this.getSetting('haBaseUrl');
        if (!baseUrl)
            throw new Error('Home Assistant URL is not configured');

        const url = path.startsWith('http://') || path.startsWith('https://')
            ? path
            : `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
        return fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init?.headers || {}),
            },
        });
    }

    async callHaService(domain: string, service: string, data?: Record<string, any>): Promise<any> {
        return this.callHa(`/api/services/${domain}/${service}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data || {}),
        });
    }

    async ensureStreaming(nativeId = NATIVE_ID): Promise<void> {
        const config = await this.getResolvedConfigForNativeId(nativeId);
        if (config.stationId) {
            try {
                await this.callHaService('abb_welcome', 'arm_streaming', {
                    station_id: config.stationId,
                    duration: 180,
                });
                return;
            }
            catch (e) {
                this.console.warn(
                    'targeted HA streaming arm failed, falling back to switch.turn_on',
                    e,
                );
            }
        }

        const entityId = config.streamingSwitchEntityId;
        if (!entityId)
            throw new Error('ABB Welcome streaming switch was not found in Home Assistant');
        await this.callHaService('switch', 'turn_on', { entity_id: entityId });
    }

    appleHomeHubPresent(): boolean {
        return settingBoolean(this.getSetting('appleHomeHubPresent'));
    }

    blockAppleHomeHubPreviewSetting(): boolean {
        return settingBoolean(this.getSetting('blockAppleHomeHubPreview'));
    }

    blockAppleHomeHubPreview(): boolean {
        return this.appleHomeHubPresent() && this.blockAppleHomeHubPreviewSetting();
    }

    blockedHomeKitClientIds(): Set<string> {
        if (!this.blockAppleHomeHubPreview())
            return new Set();
        return new Set(
            settingList(this.getSetting('blockedHomeKitClientIds'))
                .map(normalizeHomeKitClientId)
                .filter(Boolean),
        );
    }

    ringPreviewBlockMs(): number {
        return Math.max(0, Number(this.getSetting('ringPreviewBlockSeconds')) || DEFAULT_RING_PREVIEW_BLOCK_SECONDS) * 1000;
    }

    streamAutoArmSuppressed(): number {
        return Math.max(
            0,
            STREAM_AUTO_ARM_SUPPRESS_AFTER_START_MS - (Date.now() - this.startedAt),
        );
    }

    private restartPolling(): void {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        const interval = Math.max(250, Number(this.getSetting('pollIntervalMs')) || 750);
        this.pollTimer = setInterval(() => {
            this.pollRing().catch(e => this.warnPoll(e));
        }, interval);
        this.pollRing().catch(e => this.warnPoll(e));
    }

    private warnPoll(error: unknown): void {
        const now = Date.now();
        if (now - this.lastPollWarning < 30000)
            return;
        this.lastPollWarning = now;
        this.console.warn('ring polling failed', error);
    }

    private async pollRing(): Promise<void> {
        if (!this.getSetting('haBaseUrl') || !this.getSetting('haToken'))
            return;
        const entityId = (await this.getResolvedConfig()).ringSensorEntityId;
        if (!entityId)
            return;
        const state = await this.callHa(`/api/states/${encodeURIComponent(entityId)}`);
        const next = state?.state === 'on';
        this.deviceForNativeId(NATIVE_ID).updateRingState(next);
    }
}

class AbbStreamingSwitch extends ScryptedDeviceBase implements OnOff {
    constructor(private provider: AbbDoorbellProvider, nativeId: string) {
        super(nativeId);
    }

    private async entityId(): Promise<string> {
        const entityId = (await this.provider.getResolvedConfig()).streamingSwitchEntityId;
        if (!entityId)
            throw new Error('ABB Welcome streaming switch was not found in Home Assistant');
        return entityId;
    }

    async refreshState(): Promise<void> {
        const entityId = await this.entityId();
        const state = await this.provider.callHa(`/api/states/${encodeURIComponent(entityId)}`);
        this.on = state?.state === 'on';
    }

    async turnOn(): Promise<void> {
        const entityId = await this.entityId();
        await this.provider.callHaService('switch', 'turn_on', { entity_id: entityId });
        this.on = true;
    }

    async turnOff(): Promise<void> {
        const entityId = await this.entityId();
        await this.provider.callHaService('switch', 'turn_off', { entity_id: entityId });
        this.on = false;
    }
}

class AbbDoorbell extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, BinarySensor, Settings {
    private intercom?: IntercomSession;
    private sessionCounter = 0;
    private ringClearTimer?: NodeJS.Timeout;
    private lastRingAt = 0;

    constructor(private provider: AbbDoorbellProvider, private doorNativeId: string) {
        super(doorNativeId);
    }

    async getSettings(): Promise<Setting[]> {
        return this.provider.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.provider.putSetting(key, value);
    }

    updateRingState(state: boolean): void {
        let current: boolean | undefined;
        try {
            current = this.binaryState;
        }
        catch {
            current = undefined;
        }
        if (current === state)
            return;
        try {
            this.binaryState = state;
            this.onDeviceEvent(ScryptedInterface.BinarySensor, state).catch(e => this.console.warn('ring event failed', e));
        }
        catch (e) {
            this.console.warn('ring state update failed', e);
        }
    }

    triggerRing(durationMs: number): void {
        this.lastRingAt = Date.now();
        this.updateRingState(true);
        if (this.ringClearTimer)
            clearTimeout(this.ringClearTimer);
        this.ringClearTimer = setTimeout(() => {
            this.ringClearTimer = undefined;
            this.updateRingState(false);
        }, durationMs);
    }

    private streamOptions(): ResponseMediaStreamOptions {
        return {
            id: `main-${this.doorNativeId}`,
            name: this.provider.deviceName(this.doorNativeId),
            container: 'rtsp',
            tool: 'ffmpeg',
            source: 'local',
            destinations: ['local', 'remote'],
            video: {
                codec: 'h264',
                profile: 'baseline',
                width: 640,
                height: 480,
                fps: 15,
                keyframeInterval: 30,
            },
            audio: {
                codec: 'pcm_alaw',
                sampleRate: 8000,
            },
        };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [this.streamOptions()];
    }

    async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const startedAt = Date.now();
        const deviceName = this.provider.deviceName(this.doorNativeId);
        const logStep = (step: string, extra = ''): void => {
            this.console.log(`${streamTimingPrefix(deviceName, startedAt, step)}${extra ? ` ${extra}` : ''}`);
        };
        const requestSummary = compactRequestMediaStreamOptions(_options);
        this.console.log(
            `${streamTimingPrefix(deviceName, startedAt, 'request')} options=${JSON.stringify(requestSummary)}`,
        );
        this.rejectBlockedHomeKitRingPreview(_options);
        if (!isHomeKitStreamRequest(_options)) {
            this.console.warn(
                `${streamTimingPrefix(deviceName, startedAt, 'blocked')} non-HomeKit stream request`,
            );
            throw new Error('ABB Welcome refused a non-HomeKit stream request.');
        }
        // Discovery is event-driven: the HA integration fires
        // abb_welcome_discovery_changed (handled over the websocket) whenever
        // the LAN RTSP URL or door topology changes, which clears this cache.
        // So only pay for a full /api/states refresh when we don't already
        // hold a usable stream URL — that keeps doorbell pickup fast on the
        // common warm-cache path instead of dumping every HA entity each time.
        const cachedConfig = await this.provider.getResolvedConfigForNativeId(this.doorNativeId);
        if (isValidRtspUrl(cachedConfig.rtspUrl)) {
            logStep('refreshAutoConfig:skip-cached');
        }
        else {
            logStep('refreshAutoConfig:start');
            await this.provider.refreshAutoConfig();
            logStep('refreshAutoConfig:done');
        }
        if ((_options as any)?.refresh) {
            this.console.log(
                `${streamTimingPrefix(deviceName, startedAt, 'skip-arm')} refresh=true`,
            );
        }
        else if (this.provider.streamAutoArmSuppressed()) {
            this.console.log(
                `${streamTimingPrefix(deviceName, startedAt, 'skip-arm')} startupSuppressionMs=${this.provider.streamAutoArmSuppressed()}`,
            );
        }
        else {
            logStep('ensureStreaming:start');
            await this.provider.ensureStreaming(this.doorNativeId);
            logStep('ensureStreaming:done');
        }

        logStep('getRtspUrl:start');
        const rtspUrl = await this.getRtspUrl();
        logStep('getRtspUrl:done', `url=${redactMediaUrl(rtspUrl)}`);
        const ffmpegInput: FFmpegInput = {
            url: rtspUrl,
            inputArguments: [
                ...RTSP_FFMPEG_INPUT_OPTIONS,
                '-i',
                rtspUrl,
            ],
            h264EncoderArguments: [
                '-vcodec',
                'libx264',
                '-profile:v',
                'baseline',
                '-level',
                '3.1',
                '-pix_fmt',
                'yuv420p',
                '-preset',
                'veryfast',
                '-tune',
                'zerolatency',
                '-r',
                '15',
                '-g',
                '30',
            ],
            mediaStreamOptions: this.streamOptions(),
        };
        logStep('createFFmpegMediaObject:start', `inputArguments=${JSON.stringify(ffmpegInput.inputArguments)}`);
        const mediaObject = await sdk.mediaManager.createFFmpegMediaObject(ffmpegInput, {
            sourceId: this.id,
        });
        logStep('createFFmpegMediaObject:done');
        return mediaObject;
    }

    private rejectBlockedHomeKitRingPreview(options?: RequestMediaStreamOptions): void {
        const raw = options as any;
        if (!raw || raw.destinationType !== HOMEKIT_DESTINATION_TYPE)
            return;

        const clientId = normalizeHomeKitClientId(raw.destinationId);
        if (!clientId)
            return;

        const blockMs = this.provider.ringPreviewBlockMs();
        if (!blockMs)
            return;

        const ageMs = Date.now() - this.lastRingAt;
        if (ageMs < 0 || ageMs > blockMs)
            return;

        // Remote Home app viewing through a Home Hub can use the hub's
        // destinationId. Only block local HomeKit clients so remote pickup
        // remains possible.
        if (raw.destination !== 'local')
            return;

        if (!this.provider.blockedHomeKitClientIds().has(clientId))
            return;

        this.console.warn(
            `blocked HomeKit ring preview for ${this.provider.deviceName(this.doorNativeId)} from ${clientId} ` +
            `(destination=${raw.destination}, ringAgeMs=${ageMs})`,
        );
        throw new Error(`ABB Welcome HomeKit preview blocked for ${clientId}`);
    }

    private async getRtspUrl(): Promise<string> {
        const config = await this.provider.getResolvedConfigForNativeId(this.doorNativeId);
        if (config.rtspUrl)
            return config.rtspUrl;
        throw new Error('ABB Welcome RTSP URL is not available yet. Reload the HA integration or refresh Scrypted discovery.');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [
            {
                id: `latest-${this.doorNativeId}`,
                name: `${this.provider.deviceName(this.doorNativeId)} Snapshot`,
                picture: {
                    width: 640,
                    height: 480,
                },
                canResize: false,
                staleDuration: 10 * 60 * 1000,
            },
        ];
    }

    async takePicture(_options?: RequestPictureOptions): Promise<MediaObject> {
        const config = await this.provider.getResolvedConfigForNativeId(this.doorNativeId);
        const image = await this.fetchHaEntityPicture(config.cameraEntityId)
            || FALLBACK_JPEG;
        return sdk.mediaManager.createMediaObject(image, 'image/jpeg', {
            sourceId: this.id,
        });
    }

    private async fetchHaEntityPicture(entityId: string): Promise<Buffer | undefined> {
        if (!entityId)
            return undefined;
        try {
            const state = await this.provider.callHa(`/api/states/${encodeURIComponent(entityId)}`);
            const picture = state?.attributes?.entity_picture;
            if (!picture)
                return undefined;
            const response = await this.provider.fetchHa(picture);
            if (!response.ok)
                return undefined;
            const type = response.headers.get('content-type') || '';
            if (!type.includes('image/'))
                return undefined;
            return Buffer.from(await response.arrayBuffer());
        }
        catch (e) {
            this.console.warn(`snapshot fetch failed for ${entityId}`, e);
            return undefined;
        }
    }

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();

        const talkbackSessionId = randomUUID();
        const session: IntercomSession = {
            id: ++this.sessionCounter,
            talkbackSessionId,
            talkbackStarted: false,
            process: undefined as any,
            targetData: {
                ...await this.provider.targetData(this.doorNativeId),
                talkback_session_id: talkbackSessionId,
            },
            buffer: Buffer.alloc(0),
            queue: [],
            sending: false,
            stopped: false,
            stderr: '',
        };

        try {
            const inputArguments = await this.getIntercomFfmpegInputArguments(media, talkbackSessionId);

            const ffmpeg = await sdk.mediaManager.getFFmpegPath();
            session.process = spawn(ffmpeg, [
                '-hide_banner',
                '-loglevel',
                'warning',
                '-nostdin',
                ...inputArguments,
                '-vn',
                '-ac',
                '1',
                '-ar',
                '8000',
                '-acodec',
                'pcm_s16le',
                '-f',
                's16le',
                'pipe:1',
            ]);
        }
        catch (e) {
            throw e;
        }

        this.intercom = session;
        this.console.log(`started ABB HA intercom session ${session.talkbackSessionId}`);

        session.process.stdout.on('data', chunk => this.enqueuePcm(session, chunk));
        session.process.stderr.on('data', chunk => {
            session.stderr = (session.stderr + chunk.toString()).slice(-1000);
        });
        session.process.on('close', (code, signal) => {
            if (this.intercom === session)
                this.intercom = undefined;
            const detail = session.stderr ? ` ${session.stderr}` : '';
            if (!session.stopped || code)
                this.console.warn(`intercom ffmpeg exited code=${code} signal=${signal || ''}${detail}`);
            if (session.talkbackStarted) {
                this.provider.callHaService('abb_welcome', 'talk_stop', session.targetData)
                    .catch(e => this.console.warn('HA talk_stop after ffmpeg close failed', e));
            }
        });
    }

    private async getIntercomFfmpegInputArguments(media: MediaObject, talkbackSessionId: string): Promise<string[]> {
        this.console.log(
            `intercom media for ABB HA session ${talkbackSessionId}: ${JSON.stringify({
                mimeType: media?.mimeType,
                sourceId: media?.sourceId,
                toMimeTypes: media?.toMimeTypes,
            })}`,
        );

        let lastError: unknown;
        try {
            const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
            const inputArguments = ffmpegInput.inputArguments?.length
                ? [...ffmpegInput.inputArguments]
                : ffmpegInput.url
                    ? ['-i', ffmpegInput.url]
                    : [];
            if (inputArguments.length) {
                this.console.log(
                    `using FFmpegInput mic source for ABB HA intercom session ${talkbackSessionId}: ${JSON.stringify({
                        hasUrl: !!ffmpegInput.url,
                        inputArgumentCount: inputArguments.length,
                        container: ffmpegInput.container,
                    })}`,
                );
                return inputArguments;
            }
        }
        catch (e) {
            lastError = e;
            this.console.warn('FFmpegInput mic conversion failed; trying local mic URL', e);
        }

        try {
            if (media?.convert) {
                const ffmpegInput = await media.convert<FFmpegInput>(ScryptedMimeTypes.FFmpegInput);
                const inputArguments = ffmpegInput.inputArguments?.length
                    ? [...ffmpegInput.inputArguments]
                    : ffmpegInput.url
                        ? ['-i', ffmpegInput.url]
                        : [];
                if (inputArguments.length) {
                    this.console.log(
                        `using MediaObject.convert FFmpegInput mic source for ABB HA intercom session ${talkbackSessionId}: ${JSON.stringify({
                            hasUrl: !!ffmpegInput.url,
                            inputArgumentCount: inputArguments.length,
                            container: ffmpegInput.container,
                        })}`,
                    );
                    return inputArguments;
                }
            }
        }
        catch (e) {
            lastError = e;
            this.console.warn('MediaObject FFmpegInput mic conversion failed; trying local mic URL', e);
        }

        const fallbackMimeType = media?.mimeType || 'audio/basic';

        try {
            const inputUrl = await sdk.mediaManager.convertMediaObjectToInsecureLocalUrl(media, fallbackMimeType);
            this.console.log(`using insecure local mic URL for ABB HA intercom session ${talkbackSessionId}: ${redactMediaUrl(inputUrl)}`);
            return ['-i', inputUrl];
        }
        catch (e) {
            lastError = e;
            this.console.warn('insecure local mic URL conversion failed; trying secure local URL', e);
        }

        try {
            const inputUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(media, fallbackMimeType);
            this.console.log(`using secure local mic URL for ABB HA intercom session ${talkbackSessionId}: ${redactMediaUrl(inputUrl)}`);
            return ['-i', inputUrl];
        }
        catch (e) {
            throw lastError || e;
        }
    }

    async stopIntercom(): Promise<void> {
        const session = this.intercom;
        if (!session)
            return;
        this.intercom = undefined;
        session.stopped = true;
        session.process.kill('SIGTERM');
        if (session.talkbackStarted) {
            session.talkbackStarted = false;
            await this.provider.callHaService('abb_welcome', 'talk_stop', session.targetData)
                .catch(e => this.console.warn('HA talk_stop failed', e));
        }
    }

    private async startHaTalkbackWithRetry(targetData: Record<string, string>): Promise<void> {
        const deadline = Date.now() + 8000;
        let lastError: unknown;
        do {
            try {
                await this.provider.callHaService('abb_welcome', 'talk_start', targetData);
                return;
            }
            catch (e) {
                lastError = e;
                await sleep(500);
            }
        } while (Date.now() < deadline);
        throw lastError;
    }

    private enqueuePcm(session: IntercomSession, chunk: Buffer): void {
        if (session.stopped || this.intercom !== session)
            return;

        const chunkMs = Math.max(40, Math.min(250, Number(this.provider.getSetting('talkChunkMs')) || 100));
        const bytesPerChunk = Math.max(320, Math.round(8000 * 2 * chunkMs / 1000));
        session.buffer = Buffer.concat([session.buffer, chunk]);
        while (session.buffer.length >= bytesPerChunk) {
            session.queue.push(session.buffer.subarray(0, bytesPerChunk));
            session.buffer = session.buffer.subarray(bytesPerChunk);
        }

        while (session.queue.length > 12)
            session.queue.shift();

        this.pumpPcm(session).catch(e => this.console.warn('talkback PCM pump failed', e));
    }

    private async pumpPcm(session: IntercomSession): Promise<void> {
        if (session.sending)
            return;
        session.sending = true;
        try {
            while (!session.stopped && this.intercom === session && session.queue.length) {
                const pcm = session.queue.shift();
                if (!pcm)
                    continue;
                if (!session.talkbackStarted) {
                    await this.startHaTalkbackWithRetry(session.targetData);
                    session.talkbackStarted = true;
                    this.console.log(`ABB HA intercom session ${session.talkbackSessionId} started after first PCM`);
                }
                await this.provider.callHaService('abb_welcome', 'talk_pcm16le', {
                    ...session.targetData,
                    pcm16le: pcm.toString('base64'),
                });
            }
        }
        finally {
            session.sending = false;
        }
    }
}

export default AbbDoorbellProvider;
