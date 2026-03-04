import { startMaster } from './master/server.js';
startMaster().catch((err) => {
    console.error('Failed to start master:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map