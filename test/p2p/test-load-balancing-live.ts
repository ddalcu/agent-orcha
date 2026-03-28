/**
 * Live P2P load balancing test.
 *
 * Sends concurrent TTS requests via the p2pvoice agent and verifies
 * that requests distribute across available peers.
 *
 * Usage:
 *   node --experimental-strip-types test/p2p/test-load-balancing-live.ts [baseUrl] [concurrency]
 *
 * Defaults: http://localhost:3000, 6 concurrent requests
 */

const BASE_URL = process.argv[2] ?? 'http://localhost:3000';
const CONCURRENCY = parseInt(process.argv[3] ?? '6', 10);

const PHRASES = [
  'The quick brown fox jumps over the lazy dog',
  'Agent Orcha distributes work across the network',
  'Load balancing ensures even utilization',
  'Peer to peer computing is the future',
  'Hello from the decentralized world',
  'Every node contributes to the swarm',
  'Testing one two three four five six',
  'The rain in Spain stays mainly in the plain',
];

interface TtsResult {
  index: number;
  peer: string | null;
  audio: string | null;
  error: string | null;
  durationMs: number;
}

async function discoverTtsPeers(): Promise<Array<{ peerId: string; peerName: string; name: string }>> {
  const res = await fetch(`${BASE_URL}/api/p2p/llms`);
  const models = await res.json() as Array<{ peerId: string; peerName: string; name: string; type: string }>;
  return models.filter(m => m.type === 'tts');
}

async function sendTtsRequest(index: number, peers: Array<{ peerId: string; peerName: string; name: string }>): Promise<TtsResult> {
  const phrase = PHRASES[index % PHRASES.length]!;
  const start = Date.now();

  // Use selectBestPeer via the API — pick peer from the list ourselves by
  // calling the agent endpoint which uses selectBestPeer internally.
  // But to test direct P2P, use the LLM stream endpoint isn't right for TTS.
  // So we go through p2pvoice agent which routes TTS to the best peer.
  try {
    const res = await fetch(`${BASE_URL}/api/agents/p2pvoice/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: `Say the following: ${phrase}` } }),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));

    let peer: string | null = null;
    let audio: string | null = null;
    let error: string | null = null;

    for (const line of lines) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'tool_end' && data.output) {
          const output = JSON.parse(data.output);
          if (output.__modelTask) {
            peer = output.remote ?? 'LOCAL';
            audio = output.audio ?? null;
            error = output.error ?? null;
          }
        }
        if (data.error && !error) {
          error = data.error;
        }
      } catch {
        // skip non-JSON lines
      }
    }

    return { index, peer, audio, error, durationMs: Date.now() - start };
  } catch (err) {
    return { index, peer: null, audio: null, error: (err as Error).message, durationMs: Date.now() - start };
  }
}

async function checkPeerLoads(): Promise<Record<string, number>> {
  const res = await fetch(`${BASE_URL}/api/p2p/peers`);
  const peers = await res.json() as Array<{ peerName: string; load: number }>;
  const loads: Record<string, number> = {};
  for (const p of peers) {
    loads[p.peerName] = p.load ?? 0;
  }
  return loads;
}

async function main() {
  console.log(`\n🔬 P2P Load Balancing Test`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);

  // Check initial state
  const preLoads = await checkPeerLoads();
  console.log(`\n📊 Pre-test peer loads:`, preLoads);

  // Discover TTS peers
  const ttsPeers = await discoverTtsPeers();
  console.log(`   TTS peers: ${ttsPeers.map(p => p.peerName).join(', ')}\n`);

  if (ttsPeers.length === 0) {
    console.log('   ❌ No TTS peers found. Cannot test load balancing.');
    process.exit(1);
  }

  // Send requests sequentially with small gaps — each request takes seconds
  // so we send them with 500ms stagger to overlap on the peer side
  console.log(`🚀 Sending ${CONCURRENCY} TTS requests (500ms stagger)...\n`);
  const startAll = Date.now();

  const promises: Promise<TtsResult>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(sendTtsRequest(i, ttsPeers));
    if (i < CONCURRENCY - 1) await new Promise(r => setTimeout(r, 500));
  }
  const results = await Promise.all(promises);

  const totalMs = Date.now() - startAll;

  // Check loads during/after
  const postLoads = await checkPeerLoads();

  // Report results
  console.log('─'.repeat(70));
  console.log(`  #  Peer                  Audio                          Duration`);
  console.log('─'.repeat(70));

  for (const r of results) {
    const peerStr = (r.peer ?? 'ERROR').padEnd(20);
    const audioStr = (r.audio ?? r.error ?? 'N/A').padEnd(30);
    const durStr = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${r.index}  ${peerStr}  ${audioStr}  ${durStr}`);
  }

  console.log('─'.repeat(70));

  // Distribution analysis
  const peerCounts = new Map<string, number>();
  let errors = 0;
  for (const r of results) {
    if (r.error || !r.peer) {
      errors++;
    } else {
      peerCounts.set(r.peer, (peerCounts.get(r.peer) ?? 0) + 1);
    }
  }

  console.log(`\n📈 Distribution:`);
  for (const [peer, count] of [...peerCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const bar = '█'.repeat(count * 4);
    const pct = ((count / CONCURRENCY) * 100).toFixed(0);
    console.log(`   ${peer.padEnd(20)} ${count}/${CONCURRENCY} (${pct}%)  ${bar}`);
  }
  if (errors > 0) {
    console.log(`   ${'ERRORS'.padEnd(20)} ${errors}/${CONCURRENCY}`);
  }

  console.log(`\n📊 Post-test peer loads:`, postLoads);
  console.log(`⏱  Total time: ${(totalMs / 1000).toFixed(1)}s`);

  // Verdict
  const uniquePeers = peerCounts.size;
  const maxCount = Math.max(...peerCounts.values(), 0);
  const minCount = Math.min(...peerCounts.values(), 0);

  console.log(`\n🏁 Verdict:`);
  if (errors === CONCURRENCY) {
    console.log(`   ❌ All requests failed`);
    process.exit(1);
  } else if (uniquePeers < 2) {
    console.log(`   ⚠️  Only 1 peer used — load balancing NOT active`);
    console.log(`   (This may be expected if only one peer shares TTS)`);
  } else if (maxCount - minCount <= 1) {
    console.log(`   ✅ Even distribution across ${uniquePeers} peers`);
  } else {
    console.log(`   ⚠️  Uneven distribution (${maxCount} max, ${minCount} min) across ${uniquePeers} peers`);
    console.log(`   (Some imbalance is expected with concurrent requests)`);
  }

  console.log('');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
