const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const filename = join(__dirname, '../src/main.ts');
const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
    fileName: filename,
});
const pluginExports = {};
runInNewContext(outputText, {
    exports: pluginExports,
    Buffer,
    require(id) {
        if (id !== '@scrypted/sdk')
            return require(id);
        return {
            ScryptedDeviceBase: class {
                constructor(nativeId) {
                    this.id = nativeId;
                    this.console = { warn() {} };
                }
            },
            mediaManager: {
                async createMediaObject(data, mimeType, options) {
                    return { data, mimeType, ...options };
                },
            },
        };
    },
}, { filename });

const stations = [
    { nativeId: 'front-door', entityId: 'camera.abb_welcome_front', stationId: '01' },
    { nativeId: 'station-02', entityId: 'camera.abb_welcome_back', stationId: '02' },
];
const currentImage = Buffer.from('current image entity snapshot');

function snapshotFixture(override = '') {
    // Skip provider startup so the test only exercises discovery and snapshots.
    const provider = Object.create(pluginExports.default.prototype);
    const settings = new Map([
        ['imageEntityId', override],
        ['cameraEntityId', stations[0].entityId],
    ]);
    provider.storage = {
        getItem: key => settings.get(key),
        setItem: (key, value) => settings.set(key, value),
    };
    provider.doorbells = new Map();
    const states = [
        ...stations.map(station => ({
            entity_id: station.entityId,
            state: 'idle',
            attributes: {
                friendly_name: `ABB Welcome ${station.stationId} Camera`,
                go2rtc_stream: `abb_${station.stationId}`,
                entity_picture: `/camera/${station.stationId}`,
            },
        })),
        {
            entity_id: 'image.abb_welcome_latest_screenshot',
            state: '2026-10-25T10:00:00Z',
            attributes: { entity_picture: '/image/latest' },
        },
    ];
    const pictures = new Map([
        ['/image/latest', () => new Response(currentImage, { headers: { 'content-type': 'image/jpeg' } })],
        ...stations.map(station => [
            `/camera/${station.stationId}`,
            () => new Response(`camera ${station.stationId}`, { headers: { 'content-type': 'image/jpeg' } }),
        ]),
    ]);
    const requests = [];
    provider.callHa = async path => {
        requests.push(path);
        if (path === '/api/states')
            return states;
        const entityId = decodeURIComponent(path.slice('/api/states/'.length));
        const state = states.find(item => item.entity_id === entityId);
        if (!state)
            throw new Error(`Entity not found: ${entityId}`);
        return state;
    };
    provider.fetchHa = async path => {
        requests.push(path);
        assert.ok(pictures.has(path), `Unexpected picture request: ${path}`);
        return pictures.get(path)();
    };
    return { provider, states, pictures, requests };
}

for (const station of stations) {
    test(`explicit image override supplies the snapshot for ${station.nativeId}`, async () => {
        const { provider, requests } = snapshotFixture(' image.abb_welcome_latest_screenshot ');
        const doorbell = await provider.getDevice(station.nativeId);
        const picture = await doorbell.takePicture();

        assert.deepEqual(picture.data, currentImage);
        assert.equal(picture.mimeType, 'image/jpeg');
        assert.equal(picture.sourceId, station.nativeId);
        assert.deepEqual(requests, [
            '/api/states',
            '/api/states/image.abb_welcome_latest_screenshot',
            '/image/latest',
        ]);
    });

    test(`without an override ${station.nativeId} uses its own camera snapshot`, async () => {
        const { provider, requests } = snapshotFixture('   ');
        const doorbell = await provider.getDevice(station.nativeId);
        const picture = await doorbell.takePicture();

        assert.equal(picture.data.toString(), `camera ${station.stationId}`);
        assert.deepEqual(requests, [
            '/api/states',
            `/api/states/${station.entityId}`,
            `/camera/${station.stationId}`,
        ]);
    });
}

test('snapshots follow the HA image entity when a new event changes its URL', async () => {
    const { provider, states, pictures, requests } = snapshotFixture(
        'image.abb_welcome_latest_screenshot',
    );
    const doorbell = await provider.getDevice('front-door');
    assert.deepEqual((await doorbell.takePicture()).data, currentImage);

    const nextImage = Buffer.from('next event image');
    const nextUrl = '/image/latest?token=test-next-event';
    states.at(-1).attributes.entity_picture = nextUrl;
    pictures.set(nextUrl, () => new Response(nextImage, {
        headers: { 'content-type': 'image/jpeg' },
    }));

    assert.deepEqual((await doorbell.takePicture()).data, nextImage);
    assert.deepEqual(requests.slice(-2), [
        '/api/states/image.abb_welcome_latest_screenshot',
        nextUrl,
    ]);
});

test('default snapshots read updated HA station images without restarting', async () => {
    const { provider, pictures } = snapshotFixture();
    const front = await provider.getDevice('front-door');
    const back = await provider.getDevice('station-02');
    assert.equal((await front.takePicture()).data.toString(), 'camera 01');

    pictures.set('/camera/01', () => new Response('latest front event', {
        headers: { 'content-type': 'image/jpeg' },
    }));

    assert.equal((await front.takePicture()).data.toString(), 'latest front event');
    assert.equal((await back.takePicture()).data.toString(), 'camera 02');
});

const overrideFailures = {
    'missing entity': fixture => {
        fixture.states.pop();
    },
    'missing entity picture': fixture => {
        fixture.states.at(-1).attributes = {};
    },
    'HTTP error': fixture => {
        fixture.pictures.set('/image/latest', () => new Response('', { status: 503 }));
    },
    'non-image response': fixture => {
        fixture.pictures.set('/image/latest', () => new Response('unavailable'));
    },
    'network error': fixture => {
        fixture.pictures.set('/image/latest', () => { throw new TypeError('fetch failed'); });
    },
};

for (const [failure, configure] of Object.entries(overrideFailures)) {
    test(`an override with ${failure} falls back to the station camera`, async () => {
        const fixture = snapshotFixture('image.abb_welcome_latest_screenshot');
        configure(fixture);
        const doorbell = await fixture.provider.getDevice('station-02');
        const picture = await doorbell.takePicture();

        assert.equal(picture.data.toString(), 'camera 02');
        assert.ok(fixture.requests.includes('/api/states/image.abb_welcome_latest_screenshot'));
        assert.deepEqual(fixture.requests.slice(-2), [
            '/api/states/camera.abb_welcome_back',
            '/camera/02',
        ]);
    });
}

test('unavailable override and camera retain the placeholder JPEG', async () => {
    const { provider, pictures } = snapshotFixture('image.abb_welcome_latest_screenshot');
    pictures.set('/image/latest', () => new Response('', { status: 503 }));
    pictures.set('/camera/01', () => new Response('', { status: 503 }));
    const doorbell = await provider.getDevice('front-door');
    const picture = await doorbell.takePicture();

    assert.equal(picture.mimeType, 'image/jpeg');
    assert.equal(picture.data.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(picture.data.subarray(-2).toString('hex'), 'ffd9');
});
