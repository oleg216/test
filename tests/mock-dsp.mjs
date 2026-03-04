import http from 'node:http';

const PORT = parseInt(process.env.MOCK_DSP_PORT || '4200', 10);
const HOST = process.env.MOCK_DSP_HOST || 'localhost';

function buildVastXml(trackBase) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0">
  <Ad id="mock-ad-001">
    <InLine>
      <AdSystem>MockDSP</AdSystem>
      <AdTitle>Test Ad</AdTitle>
      <Impression><![CDATA[${trackBase}/track?event=impression]]></Impression>
      <Creatives>
        <Creative>
          <Linear>
            <Duration>00:00:10</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[${trackBase}/track?event=start]]></Tracking>
              <Tracking event="firstQuartile"><![CDATA[${trackBase}/track?event=firstQuartile]]></Tracking>
              <Tracking event="midpoint"><![CDATA[${trackBase}/track?event=midpoint]]></Tracking>
              <Tracking event="thirdQuartile"><![CDATA[${trackBase}/track?event=thirdQuartile]]></Tracking>
              <Tracking event="complete"><![CDATA[${trackBase}/track?event=complete]]></Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080">
                <![CDATA[https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
}

let trackedEvents = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Tracking pixel endpoint
  if (url.pathname === '/track') {
    const event = url.searchParams.get('event');
    const ts = new Date().toISOString();
    trackedEvents.push({ event, ts });
    console.log(`[TRACK] ${ts} — ${event}`);
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Stats endpoint
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: trackedEvents }, null, 2));
    return;
  }

  // Reset endpoint — clear tracked events
  if (req.method === 'POST' && url.pathname === '/reset') {
    const count = trackedEvents.length;
    trackedEvents = [];
    console.log(`[RESET] Cleared ${count} tracked events`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: count }));
    return;
  }

  // DSP bid endpoint — returns OpenRTB bid response with VAST in adm
  if (req.method === 'POST' && (url.pathname === '/bid' || url.pathname === '/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log(`[BID] Received bid request (${body.length} bytes)`);
      const trackBase = `http://${HOST}:${PORT}`;
      const bidResponse = {
        id: 'mock-response-1',
        seatbid: [{
          bid: [{
            id: 'mock-bid-1',
            impid: '1',
            price: 5.00,
            adm: buildVastXml(trackBase),
            crid: 'creative-001',
          }],
          seat: 'mock-dsp',
        }],
        cur: 'USD',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bidResponse));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock DSP + Tracker running on http://0.0.0.0:${PORT}`);
  console.log('  POST /bid    — returns OpenRTB bid response with VAST');
  console.log('  GET  /track  — tracking pixel receiver');
  console.log('  GET  /stats  — view all received events');
  console.log('  POST /reset  — clear tracked events');
});
