export const NETWORK_PROFILES = {
    '3G': {
        type: '3G',
        downloadThroughput: 750 * 1024,
        uploadThroughput: 250 * 1024,
        latency: 100,
        packetLoss: 0.01,
    },
    '4G': {
        type: '4G',
        downloadThroughput: 4 * 1024 * 1024,
        uploadThroughput: 3 * 1024 * 1024,
        latency: 20,
        packetLoss: 0.001,
    },
    WiFi: {
        type: 'WiFi',
        downloadThroughput: 30 * 1024 * 1024,
        uploadThroughput: 15 * 1024 * 1024,
        latency: 2,
        packetLoss: 0,
    },
};
//# sourceMappingURL=network-profiles.js.map