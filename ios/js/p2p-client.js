/**
 * Agent Orcha iOS P2P Client
 *
 * Consumer-only Hyperswarm peer that runs inside the Bare runtime.
 * Communicates with Swift via BareKit.IPC using NDJSON.
 *
 * This is a subset of lib/p2p/p2p-manager.ts — it only discovers
 * peers and invokes remote agents/LLMs, never serves any.
 */

/* global Bare, BareKit */

const Hyperswarm = require('hyperswarm')
const crypto = require('bare-crypto')
const b4a = require('b4a')

const IPC = BareKit.IPC
const VERSION = '1.0.0'

// --- State ---

let swarm = null
let localPeerId = null
let peerName = 'iOS'
const peers = new Map() // peerId -> { socket, protocol, info }

// --- NDJSON Protocol (mirrors lib/p2p/p2p-protocol.ts) ---

class Protocol {
  constructor (socket) {
    this.socket = socket
    this.buffer = ''
    this.handlers = new Map()
    this.destroyed = false

    socket.on('data', (data) => this._onData(data))
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.destroy())
  }

  on (type, handler) {
    this.handlers.set(type, handler)
  }

  send (message) {
    if (this.destroyed) return
    try {
      this.socket.write(JSON.stringify(message) + '\n')
    } catch (err) {
      // Socket may be closing
    }
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.handlers.clear()
    try { this.socket.destroy() } catch (err) { /* socket already closing */ }
  }

  _onData (data) {
    this.buffer += data.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        const handler = this.handlers.get(msg.type)
        if (handler) handler(msg)
      } catch (err) {
        // Ignore malformed messages
      }
    }
  }
}

// --- IPC Communication ---

function sendEvent (event) {
  IPC.write(JSON.stringify(event) + '\n')
}

// --- IPC Command Buffer ---

let ipcBuffer = ''

function processIPCData (data) {
  ipcBuffer += data.toString()
  const lines = ipcBuffer.split('\n')
  ipcBuffer = lines.pop() || ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const cmd = JSON.parse(trimmed)
      handleCommand(cmd)
    } catch (err) {
      sendEvent({ event: 'error', message: 'Invalid IPC command: ' + err.message })
    }
  }
}

// --- Command Handler ---

function handleCommand (cmd) {
  switch (cmd.cmd) {
    case 'connect':
      connect(cmd.networkKey, cmd.peerName)
      break
    case 'disconnect':
      disconnect()
      break
    case 'invoke_agent':
      invokeAgent(cmd.requestId, cmd.peerId, cmd.agentName, cmd.input, cmd.sessionId)
      break
    case 'invoke_llm':
      invokeLLM(cmd.requestId, cmd.peerId, cmd.modelName, cmd.messages, cmd.sessionId)
      break
    case 'abort':
      abortRequest(cmd.requestId)
      break
    default:
      sendEvent({ event: 'error', message: 'Unknown command: ' + cmd.cmd })
  }
}

// --- Hyperswarm Connection ---

async function connect (networkKey, name) {
  if (swarm) {
    await disconnect()
  }

  peerName = name || 'iOS'
  localPeerId = b4a.toString(crypto.randomBytes(16), 'hex')

  swarm = new Hyperswarm()

  const topicBuffer = crypto.createHash('sha256').update(b4a.from(networkKey)).digest()

  swarm.on('connection', (socket, info) => {
    onConnection(socket, info)
  })

  const discovery = swarm.join(topicBuffer, { server: true, client: true })
  await discovery.flushed()

  sendEvent({ event: 'connected', peerCount: peers.size })
}

async function disconnect () {
  if (!swarm) return

  // Abort all pending — clean up tracked peers
  for (const [peerId, peer] of peers) {
    peer.protocol.destroy()
  }
  peers.clear()

  try {
    await swarm.destroy()
  } catch (err) {
    // Swarm may already be closing
  }
  swarm = null

  sendEvent({ event: 'disconnected' })
}

// --- Peer Connection Handling ---

function onConnection (socket, _info) {
  const protocol = new Protocol(socket)

  // Send handshake immediately (consumer-only: empty agents/llms)
  const handshake = {
    type: 'handshake',
    peerId: localPeerId,
    peerName: peerName,
    version: VERSION,
    agents: [],
    llms: []
  }
  protocol.send(handshake)

  // Handle incoming handshake
  protocol.on('handshake', (msg) => {
    if (msg.peerId === localPeerId) {
      // Connected to ourselves
      protocol.destroy()
      return
    }

    // Deduplicate
    if (peers.has(msg.peerId)) {
      protocol.destroy()
      return
    }

    const peerInfo = {
      peerId: msg.peerId,
      peerName: msg.peerName,
      version: msg.version,
      agents: msg.agents || [],
      llms: msg.llms || [],
      connectedAt: Date.now()
    }

    peers.set(msg.peerId, { socket, protocol, info: peerInfo })
    setupPeerHandlers(msg.peerId, protocol)

    sendEvent({ event: 'peer_joined', peer: peerInfo })
  })

  // Handle disconnect
  socket.on('close', () => {
    for (const [peerId, peer] of peers) {
      if (peer.protocol === protocol) {
        peers.delete(peerId)
        sendEvent({ event: 'peer_left', peerId })
        break
      }
    }
  })
}

function setupPeerHandlers (peerId, protocol) {
  // Catalog updates
  protocol.on('catalog', (msg) => {
    const peer = peers.get(peerId)
    if (!peer) return
    peer.info.agents = msg.agents || []
    peer.info.llms = msg.llms || []
    if (msg.peerName) peer.info.peerName = msg.peerName

    sendEvent({
      event: 'catalog_update',
      peerId,
      agents: peer.info.agents,
      llms: peer.info.llms
    })
  })

  // Agent stream responses
  protocol.on('stream', (msg) => {
    sendEvent({
      event: 'stream_chunk',
      requestId: msg.requestId,
      chunk: msg.chunk
    })
  })

  protocol.on('stream_end', (msg) => {
    sendEvent({
      event: 'stream_end',
      requestId: msg.requestId
    })
  })

  protocol.on('stream_error', (msg) => {
    sendEvent({
      event: 'stream_error',
      requestId: msg.requestId,
      error: msg.error
    })
  })

  // LLM stream responses
  protocol.on('llm_stream', (msg) => {
    sendEvent({
      event: 'llm_chunk',
      requestId: msg.requestId,
      chunk: msg.chunk
    })
  })

  protocol.on('llm_stream_end', (msg) => {
    sendEvent({
      event: 'llm_end',
      requestId: msg.requestId
    })
  })

  protocol.on('llm_stream_error', (msg) => {
    sendEvent({
      event: 'llm_error',
      requestId: msg.requestId,
      error: msg.error
    })
  })
}

// --- Agent Invocation ---

function invokeAgent (requestId, peerId, agentName, input, sessionId) {
  const peer = peers.get(peerId)
  if (!peer) {
    sendEvent({ event: 'stream_error', requestId, error: 'Peer not found: ' + peerId })
    return
  }

  const msg = {
    type: 'invoke',
    requestId,
    agentName,
    input: input || {},
    sessionId: sessionId || ('ios-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  }

  peer.protocol.send(msg)
}

// --- LLM Invocation ---

function invokeLLM (requestId, peerId, modelName, messages, sessionId) {
  const peer = peers.get(peerId)
  if (!peer) {
    sendEvent({ event: 'llm_error', requestId, error: 'Peer not found: ' + peerId })
    return
  }

  const msg = {
    type: 'llm_invoke',
    requestId,
    modelName,
    messages: messages || []
  }

  peer.protocol.send(msg)
}

// --- Abort ---

function abortRequest (requestId) {
  // We can't truly abort a remote stream, but we can stop forwarding
  // The stream events will simply be ignored on the Swift side
  // since the continuation will already be finished
}

// --- Lifecycle ---

Bare.on('suspend', () => {
  if (swarm && typeof swarm.suspend === 'function') {
    swarm.suspend()
  }
})

Bare.on('resume', () => {
  if (swarm && typeof swarm.resume === 'function') {
    swarm.resume()
  }
})

// --- Initialize ---

IPC.setEncoding('utf8')
IPC.on('data', processIPCData)

sendEvent({ event: 'ready' })
